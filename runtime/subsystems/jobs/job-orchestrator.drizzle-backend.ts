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
import { and, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
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
  JobRun,
  StartOptions,
} from './job-orchestrator.protocol';
import {
  JobCollisionError,
  JobNotReplayableError,
  JobTemplateFieldMissingError,
  JobTypeNotFoundError,
} from './jobs-errors';
import { jobSteps } from './job-orchestration.schema';

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

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleClient) {}

  // ==========================================================================
  // start
  // ==========================================================================

  async start(type: string, input: unknown, opts: StartOptions = {}): Promise<JobRun> {
    const payload = (input ?? {}) as Record<string, unknown>;

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
            await this.cancel(incumbent.id, { cascade: true, reason: 'replaced' });
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
        tenantId: null, // JOB-8 wires multi-tenancy
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
    // Load target.
    const [target] = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.id, runId))
      .limit(1);
    if (!target) return;
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
