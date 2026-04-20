/**
 * DrizzleJobOrchestrator — Postgres-backed implementation of
 * `IJobOrchestrator` (ADR-022, JOB-3).
 *
 * Single-layer architecture: `start` writes a single `job_run` row; the
 * `JobWorker` polling loop claims it directly via `FOR UPDATE SKIP LOCKED`.
 * No `job_queue` table, no executor port. See `docs/specs/JOB-3.md`.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { DRIZZLE } from '../../constants/tokens';
import {
  jobRuns,
  jobs,
  type JobDefinitionRow,
  type JobRunRow,
} from './job-orchestration.schema';
import type {
  CancelOptions,
  IJobOrchestrator,
  JobPoolDef,
  JobRun,
  JobUpsertEntry,
  StartOptions,
} from './job-orchestrator.protocol';
import {
  JobCollisionError,
  JobNotReplayableError,
  JobTemplateFieldMissingError,
  JobTypeNotFoundError,
  MissingTenantIdError,
} from './jobs-errors';
import { jobSteps } from './job-orchestration.schema';
import { JOBS_MULTI_TENANT } from './jobs-domain.tokens';

/**
 * Terminal statuses — transitions into these are final. Used by `cancel`
 * (to short-circuit idempotently) and by `replay` (as the guard gate).
 */
export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'canceled',
] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
type JobRunStatus = JobRunRow['status'];

/** Statuses excluded from dedupe window matches per ADR-022. */
const DEDUPE_EXCLUDED_STATUSES: JobRunStatus[] = ['canceled', 'failed'];
/** Statuses that count as in-flight for concurrency collision checks. */
const IN_FLIGHT_STATUSES: JobRunStatus[] = ['pending', 'running'];

/**
 * Substitute `{{field}}` placeholders against the input payload.
 *
 * Implementation decision (JOB-3, 2026-04-19): simple `{{field}}` single-key
 * substitution, no dotted paths, no Mustache/Handlebars dependency. A missing
 * field throws `JobTemplateFieldMissingError` synchronously — cheaper than
 * discovering the misconfiguration at claim time.
 */
export function evaluateKeyTemplate(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, field: string) => {
    const value = input[field];
    if (value === undefined || value === null) {
      throw new JobTemplateFieldMissingError(template, field);
    }
    return String(value);
  });
}

@Injectable()
export class DrizzleJobOrchestrator implements IJobOrchestrator {
  // TODO(logging-subsystem): swap to ILogger once ADR-028 lands
  private readonly logger = new Logger(DrizzleJobOrchestrator.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Inject(JOBS_MULTI_TENANT) private readonly multiTenant: boolean,
  ) {}

  /**
   * JOB-8 — resolve `tenantId` for a mutating / targeted-read call.
   * Returns the tenant value that should be written to the row (or compared
   * against in a WHERE clause). When `multiTenant` is off, the column is
   * forced to `null` regardless of what callers pass. When on, `undefined`
   * throws; `null` and strings pass through untouched.
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
  // start
  // ==========================================================================

  async start(type: string, input: unknown, opts: StartOptions = {}): Promise<JobRun> {
    const payload = (input ?? {}) as Record<string, unknown>;

    // JOB-8 — resolve tenant gate up front so `multi_tenant=true` +
    // undefined surfaces before any row is touched.
    const tenantId = this.resolveTenantId('start', opts.tenantId);

    // 1a. Load job definition.
    const [def] = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.type, type))
      .limit(1);
    if (!def) throw new JobTypeNotFoundError(type);
    const definition = def as JobDefinitionRow;

    // 1b. Dedupe check.
    if (definition.dedupeKeyTemplate && definition.dedupeWindowMs) {
      const dedupeKey = evaluateKeyTemplate(definition.dedupeKeyTemplate, payload);
      const windowStart = new Date(Date.now() - definition.dedupeWindowMs);
      const existing = await this.db
        .select()
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.jobType, type),
            eq(jobRuns.dedupeKey, dedupeKey),
            gt(jobRuns.createdAt, windowStart),
            // status NOT IN ('canceled', 'failed')
            notInStatus(DEDUPE_EXCLUDED_STATUSES),
          ),
        )
        .orderBy(desc(jobRuns.createdAt))
        .limit(1);
      if (existing.length > 0) {
        return existing[0] as JobRun;
      }
    }

    // 1c. Concurrency collision check.
    let concurrencyKey: string | null = null;
    if (definition.concurrencyKeyTemplate) {
      concurrencyKey = evaluateKeyTemplate(
        definition.concurrencyKeyTemplate,
        payload,
      );
      const inFlight = await this.db
        .select()
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.concurrencyKey, concurrencyKey),
            inArray(jobRuns.status, IN_FLIGHT_STATUSES),
          ),
        )
        .limit(1);
      if (inFlight.length > 0) {
        const incumbent = inFlight[0] as JobRun;
        switch (definition.collisionMode) {
          case 'reject':
            throw new JobCollisionError(type, concurrencyKey, incumbent);
          case 'replace':
            // JOB-8 — thread the incumbent's own tenantId through the
            // internal cascade. Without this, every `replace`-collision
            // start() under multiTenant=true throws MissingTenantIdError
            // from the inner cancel() call instead of cancelling the
            // incumbent. Mirrors the memory backend's `cancelLocked(
            // incumbent.id, ..., incumbent.tenantId)` pattern.
            await this.cancel(incumbent.id, {
              cascade: true,
              reason: 'replaced',
              tenantId: incumbent.tenantId,
            });
            break;
          case 'queue':
            // Fall through — row is inserted; claim query gates it until
            // the incumbent transitions (see JobWorker.processRun queue gate).
            break;
        }
      }
    }

    // 1d. Resolve id + rootRunId, INSERT.
    const newId = randomUUID();
    let rootRunId: string = newId;
    if (opts.parentRunId) {
      const [parent] = await this.db
        .select({ rootRunId: jobRuns.rootRunId })
        .from(jobRuns)
        .where(eq(jobRuns.id, opts.parentRunId))
        .limit(1);
      if (!parent) {
        throw new Error(
          `parentRunId ${opts.parentRunId} does not reference an existing job_run`,
        );
      }
      rootRunId = parent.rootRunId;
    }

    const dedupeKey =
      definition.dedupeKeyTemplate
        ? evaluateKeyTemplate(definition.dedupeKeyTemplate, payload)
        : null;

    const [inserted] = await this.db
      .insert(jobRuns)
      .values({
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
        runAt: opts.runAt ?? new Date(),
        startedAt: null,
        finishedAt: null,
        claimedAt: null,
        attempts: 0,
      })
      .returning();

    return inserted as JobRun;
  }

  // ==========================================================================
  // cancel
  // ==========================================================================

  async cancel(runId: string, opts: CancelOptions = {}): Promise<void> {
    // JOB-8 — resolve tenant gate up front (strict undefined-throws).
    const tenantId = this.resolveTenantId('cancel', opts.tenantId);

    // Load target.
    const [target] = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.id, runId))
      .limit(1);
    if (!target) return;
    // JOB-8 — cross-tenant cancel is a silent no-op (no existence leak).
    if (this.multiTenant && target.tenantId !== tenantId) return;
    if (TERMINAL_STATUSES.includes(target.status as TerminalStatus)) {
      return; // idempotent
    }

    // Atomic transition, guarded against concurrent terminal moves.
    const [cancelled] = await this.db
      .update(jobRuns)
      .set({
        status: 'canceled',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(jobRuns.id, runId), notInStatus([...TERMINAL_STATUSES])),
      )
      .returning();

    if (!cancelled) return; // lost the race; already terminal

    if (opts.cascade === false) return;

    // Fetch descendants and branch on parent_close_policy.
    const descendants = await this.db
      .select()
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.rootRunId, target.rootRunId),
          ne(jobRuns.id, runId),
          notInStatus([...TERMINAL_STATUSES]),
        ),
      );

    for (const child of descendants) {
      const policy = (child as JobRunRow).parentClosePolicy;
      if (policy === 'abandon') continue;
      // 'terminate' | 'cancel' — both transition the child to canceled.
      await this.db
        .update(jobRuns)
        .set({
          status: 'canceled',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jobRuns.id, (child as JobRunRow).id),
            notInStatus([...TERMINAL_STATUSES]),
          ),
        );
    }

    void opts.reason; // reserved for future audit logging
  }

  // ==========================================================================
  // replay
  // ==========================================================================

  async replay(runId: string): Promise<JobRun> {
    // Load target + its job definition (we need replay_from).
    const [target] = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.id, runId))
      .limit(1);
    if (!target) {
      throw new Error(`replay: run ${runId} not found`);
    }
    const run = target as JobRunRow;
    if (!TERMINAL_STATUSES.includes(run.status as TerminalStatus)) {
      throw new JobNotReplayableError(runId, run.status);
    }

    const [def] = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.type, run.jobType))
      .limit(1);
    if (!def) throw new JobTypeNotFoundError(run.jobType);
    const mode = (def as JobDefinitionRow).replayFrom;

    // Atomic: step reset + run reset must commit together.
    const result = await this.db.transaction(async (tx) => {
      if (mode === 'scratch') {
        await tx.delete(jobSteps).where(eq(jobSteps.jobRunId, runId));
      } else if (mode === 'last_step') {
        // Delete only non-completed step rows — completed steps stay memoised.
        await tx
          .delete(jobSteps)
          .where(
            and(eq(jobSteps.jobRunId, runId), ne(jobSteps.status, 'completed')),
          );
      } else {
        // 'last_checkpoint' — Phase 1 has no explicit checkpoint markers, so
        // behaviour collapses to `last_step`. See docs/specs/JOB-3.md
        // "Implementation Decisions" — planned divergence in a later phase.
        await tx
          .delete(jobSteps)
          .where(
            and(eq(jobSteps.jobRunId, runId), ne(jobSteps.status, 'completed')),
          );
      }

      const [updated] = await tx
        .update(jobRuns)
        .set({
          status: 'pending',
          attempts: 0,
          runAt: new Date(),
          startedAt: null,
          finishedAt: null,
          claimedAt: null,
          error: null,
          output: null,
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, runId))
        .returning();
      return updated as JobRunRow;
    });

    return result as JobRun;
  }

  // ==========================================================================
  // upsertJobRows — boot-time materialisation of `job` definitions
  // ==========================================================================

  /**
   * Hash-gated `INSERT … ON CONFLICT (type) DO UPDATE … WHERE` per Q3
   * resolution (2026-04-19): the `UPDATE` branch executes only when one
   * of the persisted metadata fields differs from the incoming payload;
   * `version` bumps only on real change; concurrent boots with identical
   * content are idempotent no-ops.
   *
   * Why this shape (not `DO NOTHING`, not advisory locks):
   *   - `DO NOTHING` would let an old-version instance leave a stale row
   *     that a new-version instance can't overwrite during a rolling deploy.
   *   - Advisory locks add latency and leak risk under crashes.
   *   - The `WHERE … IS DISTINCT FROM …` clause makes the conditional
   *     atomic — no read-modify-write race on `version` between concurrent
   *     boots.
   *
   * Orphan detection: a single `SELECT type FROM job WHERE type NOT IN (...)`
   * returns the types present in DB but absent from `entries`. Caller (boot
   * validator) decides whether to throw `BootValidationError`.
   */
  async upsertJobRows(
    entries: JobUpsertEntry[],
    poolConfig: ReadonlyMap<string, JobPoolDef>,
  ): Promise<{ orphaned: string[] }> {
    void poolConfig; // pool validation is the module's responsibility; orchestrator just persists

    for (const entry of entries) {
      const meta = entry.meta;
      const pool = meta.pool ?? 'batch';
      const retryPolicy = meta.retry ?? {
        attempts: 1,
        backoff: 'fixed' as const,
        baseMs: 0,
      };
      const concurrencyKeyTemplate =
        (meta.concurrency as { key?: unknown } | undefined)?.key;
      const concurrencyKeyTemplateStr =
        typeof concurrencyKeyTemplate === 'string' ? concurrencyKeyTemplate : null;
      const collisionMode =
        (meta.concurrency?.collisionMode as JobDefinitionRow['collisionMode']) ??
        'queue';
      const dedupeKeyTemplate =
        (meta.dedupe as { key?: unknown } | undefined)?.key;
      const dedupeKeyTemplateStr =
        typeof dedupeKeyTemplate === 'string' ? dedupeKeyTemplate : null;
      const dedupeWindowMs = meta.dedupe?.windowMs ?? null;
      const timeoutMs = meta.timeoutMs ?? null;
      const replayFrom = meta.replayFrom ?? 'last_checkpoint';
      const scopeEntityType = meta.scope?.entity ?? null;
      // Q3 resolution: priority_default and replay_from are part of the
      // hashed metadata even though they aren't currently set via decorator
      // metadata above (priority_default has no `@JobHandler` field yet).
      // Default to 0 to keep UPDATE branch quiet across deploys.
      const priorityDefault = 0;

      // Hash-gated upsert: every metadata column appears in the WHERE clause
      // so the UPDATE branch only fires on a real change. `version` bumps
      // exactly when the WHERE matches.
      await this.db
        .insert(jobs)
        .values({
          type: entry.type,
          version: 1,
          pool,
          scopeEntityType,
          retryPolicy,
          timeoutMs,
          concurrencyKeyTemplate: concurrencyKeyTemplateStr,
          collisionMode,
          dedupeKeyTemplate: dedupeKeyTemplateStr,
          dedupeWindowMs,
          priorityDefault,
          replayFrom,
        })
        .onConflictDoUpdate({
          target: jobs.type,
          set: {
            pool: sql`EXCLUDED.pool`,
            scopeEntityType: sql`EXCLUDED.scope_entity_type`,
            retryPolicy: sql`EXCLUDED.retry_policy`,
            timeoutMs: sql`EXCLUDED.timeout_ms`,
            concurrencyKeyTemplate: sql`EXCLUDED.concurrency_key_template`,
            collisionMode: sql`EXCLUDED.collision_mode`,
            dedupeKeyTemplate: sql`EXCLUDED.dedupe_key_template`,
            dedupeWindowMs: sql`EXCLUDED.dedupe_window_ms`,
            priorityDefault: sql`EXCLUDED.priority_default`,
            replayFrom: sql`EXCLUDED.replay_from`,
            version: sql`${jobs.version} + 1`,
            updatedAt: sql`now()`,
          },
          // The hash gate: every field listed in the Q3 resolution appears
          // here. `IS DISTINCT FROM` is the null-safe inequality operator;
          // jsonb cast to text gives stable comparison without invoking a
          // dedicated hash column (avoids a JOB-1 schema migration).
          setWhere: sql`
            ${jobs.pool} IS DISTINCT FROM EXCLUDED.pool OR
            ${jobs.retryPolicy}::text IS DISTINCT FROM EXCLUDED.retry_policy::text OR
            ${jobs.timeoutMs} IS DISTINCT FROM EXCLUDED.timeout_ms OR
            ${jobs.concurrencyKeyTemplate} IS DISTINCT FROM EXCLUDED.concurrency_key_template OR
            ${jobs.collisionMode} IS DISTINCT FROM EXCLUDED.collision_mode OR
            ${jobs.dedupeKeyTemplate} IS DISTINCT FROM EXCLUDED.dedupe_key_template OR
            ${jobs.dedupeWindowMs} IS DISTINCT FROM EXCLUDED.dedupe_window_ms OR
            ${jobs.priorityDefault} IS DISTINCT FROM EXCLUDED.priority_default OR
            ${jobs.replayFrom} IS DISTINCT FROM EXCLUDED.replay_from OR
            ${jobs.scopeEntityType} IS DISTINCT FROM EXCLUDED.scope_entity_type
          `,
        });
    }

    // Orphan detection: any `job` row whose type is not in the registry.
    const types = entries.map((e) => e.type);
    const orphans =
      types.length === 0
        ? await this.db.select({ type: jobs.type }).from(jobs)
        : await this.db
            .select({ type: jobs.type })
            .from(jobs)
            .where(notInArray(jobs.type, types));

    return { orphaned: orphans.map((o) => o.type) };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function notInStatus(statuses: JobRunStatus[]) {
  // Drizzle's inArray composes with `not` via negation helper; use raw sql
  // to stay readable. `inArray` + `.not()` isn't idiomatic in 0.45.
  const negated = statuses.map((s) => ne(jobRuns.status, s));
  return and(...negated);
}

// `isNotNull` + `gt` imports are retained for potential future use; silence
// unused-import lint by re-exporting via `void`.
void isNotNull;
