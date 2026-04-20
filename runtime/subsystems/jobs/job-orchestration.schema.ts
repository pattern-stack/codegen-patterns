/**
 * Drizzle schema for the job orchestration domain (ADR-022).
 *
 * Three tables model the lifecycle of a durable job:
 *   - `job`       — definitions keyed by handler type (e.g. 'onboarding').
 *   - `job_run`   — one row per attempt to execute a job; worker claims
 *                   rows directly via SELECT ... FOR UPDATE SKIP LOCKED.
 *   - `job_step`  — individual steps within a run; memoises output for replay.
 *
 * Phase 1 ships only this layer. There is no `job_queue` table, no executor
 * port — see ADR-022 and `.claude/skills/jobs/SKILL.md` for the rationale.
 */
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';

// ─── Internal $type<> helpers ───────────────────────────────────────────────
// Annotation types for jsonb columns only. JOB-2 defines the public protocol
// types; these remain private to this file.

type RetryPolicy = {
  attempts: number;
  backoff: 'fixed' | 'exponential';
  baseMs: number;
  nonRetryableErrors?: string[];
};

type JobRunError = {
  message: string;
  stack?: string;
  retryable: boolean;
  attempt: number;
};

// ─── Enums ──────────────────────────────────────────────────────────────────

export const jobRunStatusEnum = pgEnum('job_run_status', [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'timed_out',
  'canceled',
]);

// extended in ADR-027: tool_call | llm_call | wait | checkpoint | message
export const jobStepKindEnum = pgEnum('job_step_kind', ['task']);

export const jobStepStatusEnum = pgEnum('job_step_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export const collisionModeEnum = pgEnum('job_collision_mode', [
  'queue',
  'reject',
  'replace',
]);

export const replayFromEnum = pgEnum('job_replay_from', [
  'scratch',
  'last_step',
  'last_checkpoint',
]);

export const parentClosePolicyEnum = pgEnum('job_parent_close_policy', [
  'terminate',
  'cancel',
  'abandon',
]);

// Phase 3 placeholder — see ADR-025
export const waitKindEnum = pgEnum('job_wait_kind', ['signal']);

// Phase 2 may add more sources; requires Atlas migration
export const triggerSourceEnum = pgEnum('job_trigger_source', [
  'manual',
  'schedule',
  'event',
  'parent',
]);

// ─── job ────────────────────────────────────────────────────────────────────

export const jobs = pgTable('job', {
  type: text('type').primaryKey(),
  version: integer('version').notNull().default(1),
  pool: text('pool').notNull(),
  scopeEntityType: text('scope_entity_type'),
  retryPolicy: jsonb('retry_policy').notNull().$type<RetryPolicy>(),
  timeoutMs: integer('timeout_ms'),
  concurrencyKeyTemplate: text('concurrency_key_template'),
  collisionMode: collisionModeEnum('collision_mode').notNull().default('queue'),
  dedupeKeyTemplate: text('dedupe_key_template'),
  dedupeWindowMs: integer('dedupe_window_ms'),
  priorityDefault: integer('priority_default').notNull().default(0),
  replayFrom: replayFromEnum('replay_from').notNull().default('last_checkpoint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type JobDefinitionRow = InferSelectModel<typeof jobs>;

// ─── job_run ────────────────────────────────────────────────────────────────

export const jobRuns = pgTable(
  'job_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobType: text('job_type').notNull().references(() => jobs.type),
    jobVersion: integer('job_version').notNull(),
    parentRunId: uuid('parent_run_id').references((): any => jobRuns.id),
    /**
     * Service generates `id` client-side via randomUUID() and sets
     * root_run_id = id for root runs (single INSERT, no self-FK race).
     */
    rootRunId: uuid('root_run_id').notNull(),
    parentClosePolicy: parentClosePolicyEnum('parent_close_policy')
      .notNull()
      .default('terminate'),
    scopeEntityType: text('scope_entity_type'),
    scopeEntityId: text('scope_entity_id'),
    // scaffold-time conditional in template — see JOB-8
    tenantId: text('tenant_id'),
    tags: jsonb('tags').notNull().default({}).$type<Record<string, string>>(),
    pool: text('pool').notNull(),
    priority: integer('priority').notNull().default(0),
    concurrencyKey: text('concurrency_key'),
    dedupeKey: text('dedupe_key'),
    status: jobRunStatusEnum('status').notNull().default('pending'),
    input: jsonb('input').notNull().$type<Record<string, unknown>>(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<JobRunError>(),
    triggerSource: triggerSourceEnum('trigger_source').notNull(),
    triggerRef: text('trigger_ref'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    // Phase 3 placeholder — see ADR-025
    waitKind: waitKindEnum('wait_kind'),
    // Phase 3 placeholder — see ADR-025
    resumeToken: text('resume_token'),
    // Phase 3 placeholder — see ADR-025
    waitDeadline: timestamp('wait_deadline', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Claim query: ORDER BY priority DESC, run_at ASC. */
    idxJobRunClaim: index('idx_job_run_claim').on(t.status, t.pool, t.runAt),
    /** Tree traversal / cascade cancel. */
    idxJobRunRoot: index('idx_job_run_root').on(t.rootRunId),
    /** listForScope query. */
    idxJobRunScope: index('idx_job_run_scope').on(t.scopeEntityType, t.scopeEntityId),
    /** Idempotency collapse — partial index. */
    idxJobRunDedupe: index('idx_job_run_dedupe')
      .on(t.jobType, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    /** Collision check — partial index. */
    idxJobRunConcurrency: index('idx_job_run_concurrency')
      .on(t.concurrencyKey)
      .where(
        sql`${t.concurrencyKey} IS NOT NULL AND ${t.status} IN ('pending','running')`,
      ),
  }),
);

export type JobRunRow = InferSelectModel<typeof jobRuns>;

// ─── job_step ───────────────────────────────────────────────────────────────

export const jobSteps = pgTable(
  'job_step',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobRunId: uuid('job_run_id').notNull().references(() => jobRuns.id),
    stepId: text('step_id').notNull(),
    kind: jobStepKindEnum('kind').notNull().default('task'),
    /**
     * Monotonic within run. integer (max ~2B per run) is sufficient —
     * downgraded from ADR-022's bigint; revisit only if a single run
     * ever exceeds 2 billion steps.
     */
    seq: integer('seq').notNull(),
    status: jobStepStatusEnum('status').notNull().default('pending'),
    input: jsonb('input').$type<Record<string, unknown>>(),
    /** Memoised on success for replay. */
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<JobRunError>(),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    /** No duplicate step IDs per run. */
    idxJobStepRunStep: uniqueIndex('idx_job_step_run_step').on(t.jobRunId, t.stepId),
    /** Ordered timeline reads. */
    idxJobStepTimeline: index('idx_job_step_timeline').on(t.jobRunId, t.seq),
  }),
);

export type JobStepRow = InferSelectModel<typeof jobSteps>;
