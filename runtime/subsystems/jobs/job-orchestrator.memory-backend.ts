/**
 * MemoryJobOrchestrator — in-process implementation of `IJobOrchestrator`
 * (ADR-022, JOB-4).
 *
 * Exists solely for the unit test suite: reproduces the Drizzle backend's
 * observable behaviour (claim ordering, collision modes, dedupe collapse,
 * memoization cache, replay row-clearing, cascade cancel) without a
 * database. Not production — the single-process mutex is a substitute for
 * Postgres' `FOR UPDATE SKIP LOCKED`; acceptable non-parity is listed in
 * `docs/specs/JOB-4.md` (fsync, query perf, multi-process claim).
 *
 * The `MemoryJobStore` is shared with `MemoryJobRunService` /
 * `MemoryJobStepService` — all three services mutate the same Maps under
 * the orchestrator's mutex.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  JobDefinitionRow,
  JobRunRow,
} from './job-orchestration.schema';
import type {
  CancelOptions,
  IJobOrchestrator,
  JobPoolDef,
  JobRun,
  JobUpsertEntry,
  StartOptions,
} from './job-orchestrator.protocol';
import type {
  JobContext,
  JobHandlerBase,
  JobHandlerMeta,
  RetryPolicy,
  SpawnChildOptions,
  StepOptions,
} from './job-handler.base';
import { ParentClosePolicy } from './job-handler.base';
import {
  JobCollisionError,
  JobNotReplayableError,
  JobTemplateFieldMissingError,
  JobTypeNotFoundError,
  MissingTenantIdError,
} from './jobs-errors';
import { MemoryJobStore } from './memory-job-store';
import { MemoryJobStepService } from './job-step-service.memory-backend';
import { JOBS_MULTI_TENANT } from './jobs-domain.tokens';

/**
 * Sentinel `run_at` for runs that lost the `queue` collision — they stay
 * unclaimable until the incumbent transitions terminal and the orchestrator
 * advances their `run_at` back to `now()`. Mirrors the Drizzle backend's
 * `claim-time gate` behaviour without requiring a separate claim query.
 */
const QUEUED_RUN_AT = new Date(8_640_000_000_000_000); // "distant future"
const TERMINAL_STATUSES: JobRunRow['status'][] = [
  'completed',
  'failed',
  'timed_out',
  'canceled',
];
const DEDUPE_EXCLUDED_STATUSES: JobRunRow['status'][] = ['canceled', 'failed'];
const IN_FLIGHT_STATUSES: JobRunRow['status'][] = ['pending', 'running'];

function isTerminal(status: JobRunRow['status']): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Mirror of `evaluateKeyTemplate` in the Drizzle backend. Kept private here
 * rather than exported so the memory backend has no dependency on the
 * Drizzle module.
 */
function evaluateKeyTemplate(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_m, field: string) => {
      const value = input[field];
      if (value === undefined || value === null) {
        throw new JobTemplateFieldMissingError(template, field);
      }
      return String(value);
    },
  );
}

/**
 * Single-promise-chain mutex. Every mutating op on the store goes through
 * `run(...)` so two concurrent `start` calls observe the same sequential
 * consistency Postgres gives us via `FOR UPDATE SKIP LOCKED`. Error
 * swallowing on the chain pointer prevents one failed call from poisoning
 * the queue for subsequent callers.
 *
 * Kept private to this file on purpose — the spec explicitly forbids
 * exporting this; it exists only for the memory backend's internal
 * serialisation.
 */
class PromiseMutex {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn());
    // Swallow errors on the chain pointer so a throwing `fn` doesn't
    // permanently reject every future caller.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Handler registry entry — class + frozen metadata. */
interface HandlerRegistration {
  type: string;
  meta: JobHandlerMeta<unknown>;
  handlerClass: new (...args: unknown[]) => JobHandlerBase<unknown>;
}

@Injectable()
export class MemoryJobOrchestrator implements IJobOrchestrator {
  private readonly logger = new Logger(MemoryJobOrchestrator.name);
  private readonly mutex = new PromiseMutex();
  private readonly handlerRegistry = new Map<string, HandlerRegistration>();

  /**
   * `runId → dependent runId[]` — when a run with `concurrencyKey = K`
   * blocks on an incumbent, its id is added here under the incumbent's id.
   * On incumbent terminal transition we advance every dependent's `runAt`
   * back to `now()` so it becomes claimable.
   */
  private readonly queueBlockers = new Map<string, string[]>();

  constructor(
    private readonly store: MemoryJobStore,
    private readonly stepService: MemoryJobStepService,
    @Inject(JOBS_MULTI_TENANT) private readonly multiTenant: boolean,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * JOB-8 — mirror of the Drizzle backend's `resolveTenantId`. Returns the
   * value to stamp on `tenant_id` / compare against in memory predicates.
   * Off → always `null`. On + `undefined` → throw. On + `null`/string → pass.
   */
  private resolveTenantId(
    method: string,
    tenantId: string | null | undefined,
  ): string | null {
    if (!this.multiTenant) return null;
    if (tenantId === undefined) throw new MissingTenantIdError(method);
    return tenantId;
  }

  // ==========================================================================
  // registerHandler — replaces Drizzle's `job` table upsert
  // ==========================================================================

  /**
   * Populate the in-memory job definition row plus handler class lookup.
   * Called by `JobWorkerModule.onModuleInit` in memory mode, or directly by
   * unit tests that want to seed the registry without NestJS.
   */
  registerHandler<TInput>(
    type: string,
    meta: JobHandlerMeta<TInput>,
    handlerClass: new (...args: unknown[]) => JobHandlerBase<TInput>,
  ): void {
    const concurrencyKeyTemplate =
      (meta.concurrency as { key?: string } | undefined)?.key ?? null;
    const dedupeKeyTemplate =
      (meta.dedupe as { key?: string } | undefined)?.key ?? null;
    const dedupeWindowMs = meta.dedupe?.windowMs ?? null;
    const now = new Date();

    const def: JobDefinitionRow = {
      type,
      version: 1,
      pool: meta.pool ?? 'batch',
      scopeEntityType: meta.scope?.entity ?? null,
      retryPolicy: meta.retry ?? {
        attempts: 1,
        backoff: 'fixed',
        baseMs: 0,
      },
      timeoutMs: meta.timeoutMs ?? null,
      concurrencyKeyTemplate:
        typeof concurrencyKeyTemplate === 'string' ? concurrencyKeyTemplate : null,
      collisionMode:
        (meta.concurrency?.collisionMode as JobDefinitionRow['collisionMode']) ??
        'queue',
      dedupeKeyTemplate:
        typeof dedupeKeyTemplate === 'string' ? dedupeKeyTemplate : null,
      dedupeWindowMs,
      priorityDefault: 0,
      replayFrom: meta.replayFrom ?? 'last_checkpoint',
      createdAt: now,
      updatedAt: now,
    };

    this.store.jobs.set(type, def);
    this.handlerRegistry.set(type, {
      type,
      meta: meta as JobHandlerMeta<unknown>,
      handlerClass: handlerClass as unknown as new (
        ...args: unknown[]
      ) => JobHandlerBase<unknown>,
    });
  }

  /** Test helper — look up a registered handler without exposing the map. */
  getHandlerRegistration(type: string): HandlerRegistration | undefined {
    return this.handlerRegistry.get(type);
  }

  /**
   * Boot-time upsert per `IJobOrchestrator.upsertJobRows`. Memory backend
   * just funnels each entry through `registerHandler`. The validator is
   * skipped entirely in memory mode (Q4 resolution 2026-04-19), so the
   * orphaned list is always empty — there are no DB rows to compare against.
   */
  async upsertJobRows(
    entries: JobUpsertEntry[],
    poolConfig: ReadonlyMap<string, JobPoolDef>,
  ): Promise<{ orphaned: string[] }> {
    void poolConfig; // pool validation is the module's responsibility
    for (const entry of entries) {
      this.registerHandler(
        entry.type,
        entry.meta as JobHandlerMeta<unknown>,
        entry.handlerClass as new (...args: unknown[]) => JobHandlerBase<unknown>,
      );
    }
    return { orphaned: [] };
  }

  // ==========================================================================
  // start
  // ==========================================================================

  async start(
    type: string,
    input: unknown,
    opts: StartOptions = {},
    // BRIDGE-7: signature parity with Drizzle backend. The memory backend
    // has no real transactions (its "atomic" boundary is a process-wide
    // mutex acquired by the body below), so the parameter is intentionally
    // ignored. Accepting it lets EventFlowService unit tests exercise the
    // same code path without two stub orchestrators.
    _tx?: unknown,
  ): Promise<JobRun> {
    // JOB-8 — resolve tenant gate outside the mutex so the error throws
    // synchronously-ish from the caller's stack rather than via the mutex's
    // deferred chain (matches Drizzle backend's pre-transaction guard).
    const tenantId = this.resolveTenantId('start', opts.tenantId);

    return this.mutex.run(async () => {
      const payload = (input ?? {}) as Record<string, unknown>;
      const definition = this.store.jobs.get(type);
      if (!definition) throw new JobTypeNotFoundError(type);

      // 1. Dedupe — return existing non-excluded run within the window.
      if (definition.dedupeKeyTemplate && definition.dedupeWindowMs) {
        const dedupeKey = evaluateKeyTemplate(
          definition.dedupeKeyTemplate,
          payload,
        );
        const windowStart = Date.now() - definition.dedupeWindowMs;
        const existing = this.findDedupeCandidate(type, dedupeKey, windowStart);
        if (existing) return existing;
      }

      // 2. Concurrency collision check.
      let concurrencyKey: string | null = null;
      let queueBlockedBy: string | null = null;
      if (definition.concurrencyKeyTemplate) {
        concurrencyKey = evaluateKeyTemplate(
          definition.concurrencyKeyTemplate,
          payload,
        );
        const incumbent = this.findInFlightByConcurrencyKey(concurrencyKey);
        if (incumbent) {
          switch (definition.collisionMode) {
            case 'reject':
              throw new JobCollisionError(type, concurrencyKey, incumbent);
            case 'replace':
              // Cancel incumbent (cascading children). Must happen inside
              // the mutex — call the internal helper, not public `cancel()`
              // (public `cancel` would re-enter the mutex and deadlock).
              // Internal replace path sidesteps the tenant gate — it uses
              // the incumbent's own tenant (same concurrency key implies
              // same tenant in practice, but the gate is bypassed via
              // `incumbent.tenantId` to avoid accidental cross-tenant
              // MissingTenantIdError bubbling from the user's `start` call).
              this.cancelLocked(
                incumbent.id,
                { cascade: true, reason: 'replaced' },
                incumbent.tenantId,
              );
              break;
            case 'queue':
              queueBlockedBy = incumbent.id;
              break;
          }
        }
      }

      // 3. Resolve lineage.
      const newId = randomUUID();
      let rootRunId: string = newId;
      if (opts.parentRunId) {
        const parent = this.store.runs.get(opts.parentRunId);
        if (!parent) {
          throw new Error(
            `parentRunId ${opts.parentRunId} does not reference an existing job_run`,
          );
        }
        rootRunId = parent.rootRunId;
      }

      // 4. Compute dedupe key for the persisted row (separate from dedupe
      //    short-circuit above — we store it even when no prior run matched
      //    so future dedupe checks see it).
      const dedupeKey = definition.dedupeKeyTemplate
        ? evaluateKeyTemplate(definition.dedupeKeyTemplate, payload)
        : null;

      const now = new Date();
      const runAt = queueBlockedBy
        ? QUEUED_RUN_AT
        : (opts.runAt ?? now);

      const row: JobRunRow = {
        id: newId,
        jobType: type,
        jobVersion: definition.version,
        parentRunId: opts.parentRunId ?? null,
        rootRunId,
        parentClosePolicy: opts.parentClosePolicy ?? 'terminate',
        scopeEntityType: opts.scope?.entityType ?? null,
        scopeEntityId: opts.scope?.entityId ?? null,
        tenantId,
        tags: opts.tags ?? {},
        pool: opts.pool ?? definition.pool,
        priority: opts.priority ?? definition.priorityDefault,
        concurrencyKey,
        dedupeKey,
        status: 'pending',
        input: payload,
        output: null,
        error: null,
        triggerSource: opts.triggerSource ?? 'manual',
        triggerRef: opts.triggerRef ?? null,
        runAt,
        startedAt: null,
        finishedAt: null,
        claimedAt: null,
        attempts: 0,
        waitKind: null,
        resumeToken: null,
        waitDeadline: null,
        createdAt: now,
        updatedAt: now,
      };

      this.store.runs.set(newId, row);
      if (queueBlockedBy) {
        const list = this.queueBlockers.get(queueBlockedBy) ?? [];
        list.push(newId);
        this.queueBlockers.set(queueBlockedBy, list);
      }
      return row;
    });
  }

  // ==========================================================================
  // cancel
  // ==========================================================================

  async cancel(runId: string, opts: CancelOptions = {}): Promise<void> {
    // JOB-8 — strict tenant gate outside the mutex (matches Drizzle path).
    const tenantId = this.resolveTenantId('cancel', opts.tenantId);
    await this.mutex.run(async () => {
      this.cancelLocked(runId, opts, tenantId);
    });
  }

  /**
   * Internal cancel that assumes the caller already holds the mutex.
   * Synchronous because all store ops are in-memory. Idempotent.
   *
   * `tenantForGate` is the already-validated tenant id (or `null`). When
   * non-null it gates the initial cancellation to that tenant's run; the
   * cascade step then sweeps descendants on the same `rootRunId` without
   * re-checking — children of a tenant-gated parent always share the
   * tenant (enforced at `start` time).
   */
  private cancelLocked(
    runId: string,
    opts: CancelOptions,
    tenantForGate: string | null,
  ): void {
    const run = this.store.runs.get(runId);
    if (!run) return;
    // JOB-8 — cross-tenant cancel is silent no-op.
    if (this.multiTenant && run.tenantId !== tenantForGate) return;
    if (isTerminal(run.status)) return;

    const now = new Date();

    // Collect descendants up front so Cancel-policy parents can wait on
    // children (their `finished_at` is set after children transition).
    const descendants =
      opts.cascade === false
        ? []
        : Array.from(this.store.runs.values()).filter(
            (r) =>
              r.rootRunId === run.rootRunId &&
              r.id !== runId &&
              !isTerminal(r.status),
          );

    // Group by policy stored on the child.
    const terminateChildren = descendants.filter(
      (d) => d.parentClosePolicy === ParentClosePolicy.Terminate,
    );
    const cancelChildren = descendants.filter(
      (d) => d.parentClosePolicy === ParentClosePolicy.Cancel,
    );
    // 'abandon' → do nothing.

    // Terminate policy: cancel children, then parent.
    for (const child of terminateChildren) {
      this.transitionToCanceled(child.id, now);
    }

    // Cancel policy: cancel children first, then parent (so parent's
    // finished_at is set only after children transitioned).
    for (const child of cancelChildren) {
      this.transitionToCanceled(child.id, now);
    }

    this.transitionToCanceled(runId, now);

    void opts.reason; // reserved for future audit logging
  }

  private transitionToCanceled(runId: string, at: Date): void {
    const run = this.store.runs.get(runId);
    if (!run) return;
    if (isTerminal(run.status)) return;
    const next: JobRunRow = {
      ...run,
      status: 'canceled',
      finishedAt: at,
      updatedAt: at,
    };
    this.store.runs.set(runId, next);
    this.unblockQueuedDependents(runId);
  }

  /**
   * When `runId` transitions to a terminal state, advance every dependent
   * `queue`-blocked run's `run_at` back to `now()` so `claimNext` picks
   * them up.
   */
  private unblockQueuedDependents(runId: string): void {
    const dependents = this.queueBlockers.get(runId);
    if (!dependents || dependents.length === 0) return;
    const now = new Date();
    for (const dep of dependents) {
      const depRun = this.store.runs.get(dep);
      if (!depRun) continue;
      if (depRun.status !== 'pending') continue;
      this.store.runs.set(dep, { ...depRun, runAt: now, updatedAt: now });
    }
    this.queueBlockers.delete(runId);
  }

  // ==========================================================================
  // claimNext — consumed by JobWorker in memory mode (tests exercise directly)
  // ==========================================================================

  async claimNext(pool: string): Promise<JobRunRow | null> {
    return this.mutex.run(async () => {
      const now = Date.now();
      const candidates = Array.from(this.store.runs.values()).filter(
        (r) =>
          r.status === 'pending' &&
          r.pool === pool &&
          r.runAt.getTime() <= now,
      );
      if (candidates.length === 0) return null;

      // ORDER BY priority DESC, run_at ASC (Drizzle parity).
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.runAt.getTime() - b.runAt.getTime();
      });

      const winner = candidates[0]!;
      const claimedAt = new Date();
      const next: JobRunRow = {
        ...winner,
        status: 'running',
        claimedAt,
        startedAt: claimedAt,
        updatedAt: claimedAt,
      };
      this.store.runs.set(winner.id, next);
      return next;
    });
  }

  // ==========================================================================
  // replay
  // ==========================================================================

  async replay(runId: string): Promise<JobRun> {
    return this.mutex.run(async () => {
      const run = this.store.runs.get(runId);
      if (!run) throw new Error(`replay: run ${runId} not found`);
      if (!isTerminal(run.status)) {
        throw new JobNotReplayableError(runId, run.status);
      }
      const def = this.store.jobs.get(run.jobType);
      if (!def) throw new JobTypeNotFoundError(run.jobType);

      const mode = def.replayFrom;
      if (mode === 'scratch') {
        this.stepService.clearStepsForRun(runId);
      } else {
        // `last_step` and `last_checkpoint` collapse to the same semantic
        // in Phase 1 — delete non-completed rows, preserve memoized ones.
        // Matches the Drizzle backend exactly (see JOB-3 notes).
        this.stepService.clearIncompleteSteps(runId);
      }

      const now = new Date();
      const next: JobRunRow = {
        ...run,
        status: 'pending',
        attempts: 0,
        runAt: now,
        startedAt: null,
        finishedAt: null,
        claimedAt: null,
        error: null,
        output: null,
        updatedAt: now,
      };
      this.store.runs.set(runId, next);
      return next;
    });
  }

  // ==========================================================================
  // tick — used by unit tests + memory-mode JobWorker
  // ==========================================================================

  /**
   * Execute a single claimed run to completion, retry, or failure. Not on
   * `IJobOrchestrator` — it's the memory equivalent of the Drizzle
   * `JobWorker.processRun` code path. The unit tests drive it directly so
   * they can assert memoization across ticks without spinning up a worker.
   */
  async tick(runId: string): Promise<void> {
    // We load state outside the mutex because handler execution cannot
    // hold the serialisation lock — `fn()` inside `ctx.step` can call back
    // into `start` / `spawnChild` which would deadlock. Mutation points
    // (recordStep, status transition) go through the services or the
    // orchestrator entry points and re-enter the mutex there.
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`tick: run ${runId} not found`);
    if (run.status !== 'running') {
      throw new Error(
        `tick: run ${runId} must be 'running' (got '${run.status}')`,
      );
    }

    const registration = this.handlerRegistry.get(run.jobType);
    if (!registration) {
      await this.markFailed(run, new Error(
        `No handler registered for jobType='${run.jobType}'`,
      ), (run.attempts ?? 0) + 1);
      return;
    }
    const meta = registration.meta;
    const HandlerClass = registration.handlerClass;
    // Match the Drizzle backend: resolve the handler through Nest's
    // ModuleRef so `@Inject` constructor params work. ModuleRef is
    // @Optional() — zero-dep test stubs that construct this orchestrator
    // manually still hit the legacy `new HandlerClass()` path.
    const handler = this.moduleRef
      ? ((await this.moduleRef.create(
          HandlerClass as unknown as new (...args: unknown[]) => unknown,
        )) as JobHandlerBase<unknown>)
      : new HandlerClass();

    const ctx: JobContext<unknown> = {
      input: run.input,
      run: run as JobRun,
      step: this.makeStepFn(run),
      spawnChild: this.makeSpawnFn(run),
      logger: new Logger(`JobRun:${run.id}`),
    };

    const attemptsBefore = run.attempts ?? 0;
    try {
      const output = (await handler.run(ctx)) as Record<string, unknown> | undefined;
      await this.markCompleted(run, output ?? {}, attemptsBefore + 1);
    } catch (err) {
      const policy = meta.retry;
      const decision = classifyError(err, policy, attemptsBefore);
      const nextAttempts = attemptsBefore + 1;
      if (decision === 'retry' && policy) {
        const delay = computeBackoff(policy, nextAttempts);
        await this.rescheduleForRetry(run, err, nextAttempts, delay);
      } else {
        await this.markFailed(run, err, nextAttempts);
      }
    }
  }

  private makeStepFn(run: JobRunRow) {
    return async <TOutput>(
      stepId: string,
      fn: () => Promise<TOutput>,
      _opts?: StepOptions,
    ): Promise<TOutput> => {
      void _opts;
      const existing = await this.stepService.findStep(run.id, stepId);
      if (existing?.status === 'completed') {
        return existing.output as TOutput;
      }
      const seq = this.nextStepSeq(run.id);
      const startedAt = new Date();
      const nextAttempts = (existing?.attempts ?? 0) + 1;
      await this.stepService.recordStep({
        jobRunId: run.id,
        stepId,
        kind: 'task',
        seq,
        status: 'running',
        startedAt,
        attempts: nextAttempts,
      });
      try {
        const output = await fn();
        await this.stepService.recordStep({
          jobRunId: run.id,
          stepId,
          kind: 'task',
          seq,
          status: 'completed',
          output: output as Record<string, unknown> | undefined,
          finishedAt: new Date(),
          attempts: nextAttempts,
        });
        return output;
      } catch (err) {
        await this.stepService.recordStep({
          jobRunId: run.id,
          stepId,
          kind: 'task',
          seq,
          status: 'failed',
          error: serialiseError(err, nextAttempts, false),
          finishedAt: new Date(),
          attempts: nextAttempts,
        });
        throw err;
      }
    };
  }

  private makeSpawnFn(run: JobRunRow) {
    return async (
      type: string,
      input: unknown,
      opts?: SpawnChildOptions,
    ): Promise<JobRun> => {
      return this.start(type, input, {
        parentRunId: run.id,
        parentClosePolicy: opts?.closePolicy,
        runAt: opts?.runAt,
        priority: opts?.priority,
        tags: opts?.tags,
        triggerSource: 'parent',
        triggerRef: run.id,
      });
    };
  }

  private nextStepSeq(runId: string): number {
    const rows = this.store.steps.get(runId);
    if (!rows || rows.length === 0) return 1;
    let max = 0;
    for (const r of rows) if (r.seq > max) max = r.seq;
    return max + 1;
  }

  private async markCompleted(
    run: JobRunRow,
    output: Record<string, unknown>,
    attempts: number,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const current = this.store.runs.get(run.id);
      if (!current || isTerminal(current.status)) return;
      const now = new Date();
      this.store.runs.set(run.id, {
        ...current,
        status: 'completed',
        output,
        finishedAt: now,
        updatedAt: now,
        attempts,
      });
      this.unblockQueuedDependents(run.id);
    });
  }

  private async markFailed(
    run: JobRunRow,
    err: unknown,
    attempts: number,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const current = this.store.runs.get(run.id);
      if (!current || isTerminal(current.status)) return;
      const now = new Date();
      this.store.runs.set(run.id, {
        ...current,
        status: 'failed',
        finishedAt: now,
        updatedAt: now,
        attempts,
        error: serialiseError(err, attempts, false),
      });
      this.unblockQueuedDependents(run.id);
    });

    // parent_close_policy = 'terminate' cascade mirrors the Drizzle worker
    // (cancel runs outside its own terminal transition). We pass the run's
    // own `tenantId` so the cancel passes the multi-tenant gate — this is
    // system-internal cascade, not a user-initiated call.
    if (run.parentClosePolicy === 'terminate') {
      try {
        await this.cancel(run.id, {
          cascade: true,
          reason: 'parent-failed',
          tenantId: run.tenantId,
        });
      } catch (cascadeErr) {
        this.logger.warn(
          `cascade on failed run ${run.id}: ${(cascadeErr as Error).message}`,
        );
      }
    }
  }

  private async rescheduleForRetry(
    run: JobRunRow,
    err: unknown,
    attempts: number,
    delayMs: number,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const current = this.store.runs.get(run.id);
      if (!current || isTerminal(current.status)) return;
      const now = new Date();
      this.store.runs.set(run.id, {
        ...current,
        status: 'pending',
        attempts,
        runAt: new Date(Date.now() + delayMs),
        startedAt: null,
        claimedAt: null,
        updatedAt: now,
        error: serialiseError(err, attempts, true),
      });
    });
  }

  // ==========================================================================
  // Internal queries — used by start / cancel
  // ==========================================================================

  private findDedupeCandidate(
    jobType: string,
    dedupeKey: string,
    windowStartMs: number,
  ): JobRunRow | null {
    let best: JobRunRow | null = null;
    for (const r of this.store.runs.values()) {
      if (r.jobType !== jobType) continue;
      if (r.dedupeKey !== dedupeKey) continue;
      if (DEDUPE_EXCLUDED_STATUSES.includes(r.status)) continue;
      if (r.createdAt.getTime() <= windowStartMs) continue;
      if (!best || r.createdAt.getTime() > best.createdAt.getTime()) {
        best = r;
      }
    }
    return best;
  }

  private findInFlightByConcurrencyKey(key: string): JobRunRow | null {
    for (const r of this.store.runs.values()) {
      if (r.concurrencyKey !== key) continue;
      if (!IN_FLIGHT_STATUSES.includes(r.status)) continue;
      return r;
    }
    return null;
  }
}

// ─── Pure helpers (mirrored from JobWorker so memory mode is standalone) ────

function classifyError(
  err: unknown,
  policy: RetryPolicy | undefined,
  currentAttempts: number,
): 'retry' | 'fail' {
  if (!policy) return 'fail';
  const errObj = err as { name?: string; code?: string } | undefined;
  const name = errObj?.name;
  const code = errObj?.code;
  const nonRetryable = policy.nonRetryableErrors ?? [];
  if (nonRetryable.some((n) => n === name || n === code)) return 'fail';
  if (currentAttempts + 1 >= policy.attempts) return 'fail';
  return 'retry';
}

function computeBackoff(policy: RetryPolicy, attempts: number): number {
  const base = Math.max(policy.baseMs, 0);
  if (policy.backoff === 'fixed') return base;
  const exponent = Math.max(attempts - 1, 0);
  if (exponent >= 53) return Number.MAX_SAFE_INTEGER;
  const raw = base * Math.pow(2, exponent);
  if (!Number.isFinite(raw) || raw >= Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }
  return raw;
}

function serialiseError(err: unknown, attempt: number, retryable: boolean) {
  const e = err as { message?: string; stack?: string } | undefined;
  return {
    message: (e?.message ?? String(err)) as string,
    stack: e?.stack,
    retryable,
    attempt,
  };
}
