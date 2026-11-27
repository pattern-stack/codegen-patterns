import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { CHUNK_STATUSES, type ChunkStatus } from '../model/chunk.ts';
import { JOB_EVENT_TYPES, type JobEventType } from '../model/events.ts';
import { ITEM_STATUSES, type ItemStatus } from '../model/item.ts';
import {
  ACTIVE_RUN,
  CACHE_MODES,
  type CacheMode,
  PAUSE_REASONS,
  type PauseReason,
  RUN_STATUSES,
  RUN_TRIGGERS,
  type RunStatus,
  type RunTrigger,
} from '../model/run.ts';
import {
  STEP_KINDS,
  STEP_STATUSES,
  type StepKind,
  type StepStatus,
  WAIT_KINDS,
  type WaitKind,
} from '../model/step-state.ts';
import { literalsOf } from './rows.ts';

/**
 * The job engine's tables (`@pattern-stack/jobs/postgres`), the one definition: an app's schema re-exports them (codegen
 * emits that file), so its migrations create them, and binds them with `jobTables` below. Two kinds:
 *
 * - The bookkeeping, typed columns only: one row per run, per step a run started, per planned item of a map step and
 *   per chunk. This is what surfaces read and filter on.
 * - A job's values, as JSON beside the bookkeeping, never in it: `job_run_values` (a run's input and each step's
 *   output) and `job_item_results` (a map step's item results, cached across runs). Every job's values fit them, so a
 *   new job needs no table and no migration. Only the engine writes and reads them back; nothing queries inside the
 *   JSON, and domain data a surface reads lives in its domain's tables.
 *
 * The tenant is `text`, whatever the app's tenant ids are, and a single-tenant app writes `SYSTEM_TENANT`: no FK to
 * a tenants table (the engine's rows outlive nothing they point at). Every child carries `tenant_id` with a composite FK to `job_runs (tenant_id, id)`, so a child row can
 * never point at another tenant's run. Timestamps are `timestamptz(3)` (an instant, the millisecond a JS `Date` holds; codegen #796), and
 * every one is written from the store's clock, never SQL `now()`. Each status column is typed with the model's type and
 * its CHECK is built from the model's one const list (`literalsOf`), so a word added to the model reaches both.
 */

const ms = { precision: 3, withTimezone: true } as const;

// One run of a job: the request and the record. Its values sit in `job_run_values`, never on this row.
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    jobKey: varchar('job_key', { length: 128 }).notNull(),
    // The definition's version hash when the run was created.
    jobVersion: varchar('job_version', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 })
      .$type<RunStatus>()
      .default('pending')
      .notNull(),
    pauseReason: varchar('pause_reason', {
      length: 16,
    }).$type<PauseReason>(),
    trigger: varchar('trigger', { length: 16 })
      .$type<RunTrigger>()
      .notNull(),
    requestedByUserId: text('requested_by_user_id'),
    dryRun: boolean('dry_run').default(false).notNull(),
    dedupeKey: varchar('dedupe_key', { length: 255 }),
    cacheMode: varchar('cache_mode', { length: 16 })
      .$type<CacheMode>()
      .default('read-write')
      .notNull(),
    chunkSize: integer('chunk_size').default(1000).notNull(),
    chunkConcurrency: integer('chunk_concurrency'),
    // The budget.
    maxItems: integer('max_items').notNull(),
    maxUsd: doublePrecision('max_usd'),
    maxCalls: integer('max_calls'),
    deadlineAt: timestamp('deadline_at', ms),
    // Spend. What is reserved and not yet spent is held per chunk (`job_run_chunks.reserved_*`).
    calls: integer('calls').default(0).notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .default(0)
      .notNull(),
    costUsd: doublePrecision('cost_usd').default(0).notNull(),
    errorType: varchar('error_type', { length: 128 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', ms).defaultNow().notNull(),
    startedAt: timestamp('started_at', ms),
    completedAt: timestamp('completed_at', ms),
    updatedAt: timestamp('updated_at', ms).defaultNow().notNull(),
    // A child run's link to the run whose step started it, immutable once created: all four null with depth 0 for a
    // run nobody started, or all set with depth 1–3.
    parentRunId: uuid('parent_run_id'),
    parentStep: varchar('parent_step', { length: 64 }),
    childKey: varchar('child_key', { length: 255 }),
    depth: smallint('depth').default(0).notNull(),
    // What the run is about, named by its job from its input at start (never by a caller): a free-text kind and the
    // subject's id, both null or both set. No registry of kinds yet (provisional, Indicators m15).
    subjectKind: text('subject_kind'),
    subjectId: text('subject_id'),
    // The advance lease (`RunLeases`): which executor advances the run now, by which token, until when. Null when
    // none holds it; an expired one is anyone's.
    advanceOwner: varchar('advance_owner', { length: 255 }),
    advanceToken: uuid('advance_token'),
    advanceExpiresAt: timestamp('advance_expires_at', ms),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'job_runs_status_check',
      sql`${table.status} IN ${literalsOf(RUN_STATUSES)}`,
    ),
    check(
      'job_runs_pause_reason_check',
      sql`${table.pauseReason} IS NULL OR (${table.pauseReason} IN ${literalsOf(PAUSE_REASONS)} AND ${table.status} = 'paused')`,
    ),
    check(
      'job_runs_parent_check',
      sql`(${table.parentRunId} IS NULL AND ${table.parentStep} IS NULL AND ${table.childKey} IS NULL AND ${table.depth} = 0) OR (${table.parentRunId} IS NOT NULL AND ${table.parentStep} IS NOT NULL AND ${table.childKey} IS NOT NULL AND ${table.depth} BETWEEN 1 AND 3)`,
    ),
    // A child is in its parent's tenant: the composite key makes another tenant's parent impossible.
    foreignKey({
      name: 'job_runs_parent_fk',
      columns: [table.tenantId, table.parentRunId],
      foreignColumns: [table.tenantId, table.id],
    }).onDelete('cascade'),
    index('job_runs_parent_idx')
      .on(table.parentRunId, table.createdAt, table.id)
      .where(sql`${table.parentRunId} IS NOT NULL`),
    check(
      'job_runs_trigger_check',
      sql`${table.trigger} IN ${literalsOf(RUN_TRIGGERS)}`,
    ),
    check(
      'job_runs_cache_mode_check',
      sql`${table.cacheMode} IN ${literalsOf(CACHE_MODES)}`,
    ),
    check(
      'job_runs_subject_check',
      sql`(${table.subjectKind} IS NULL) = (${table.subjectId} IS NULL)`,
    ),
    // "This subject's runs" in a tenant, newest first.
    index('job_runs_tenant_subject_created_idx').on(
      table.tenantId,
      table.subjectKind,
      table.subjectId,
      table.createdAt,
      table.id,
    ),
    check('job_runs_chunk_size_check', sql`${table.chunkSize} > 0`),
    check('job_runs_max_items_check', sql`${table.maxItems} >= 0`),
    check(
      'job_runs_failed_error_check',
      sql`${table.status} <> 'failed' OR ${table.errorType} IS NOT NULL`,
    ),
    // Target of the tenant-scoped composite foreign keys.
    unique('job_runs_tenant_id_unique').on(table.tenantId, table.id),
    // At most one open run per tenant, job, dry or real, and dedupe key: a real start is never answered by an
    // open dry run, nor the reverse.
    uniqueIndex('job_runs_one_open_per_dedupe_key')
      .on(table.tenantId, table.jobKey, table.dryRun, table.dedupeKey)
      .where(
        sql`${table.dedupeKey} IS NOT NULL AND ${table.status} IN ${literalsOf(ACTIVE_RUN)}`,
      ),
    index('job_runs_tenant_created_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index('job_runs_tenant_job_created_idx').on(
      table.tenantId,
      table.jobKey,
      table.createdAt,
      table.id,
    ),
    // The operator read across tenants.
    index('job_runs_job_created_idx').on(
      table.jobKey,
      table.createdAt,
      table.id,
    ),
    // The operator's runs across tenants with no job or tenant named, and by status.
    index('job_runs_created_idx').on(table.createdAt, table.id),
    index('job_runs_status_created_idx').on(
      table.status,
      table.createdAt,
      table.id,
    ),
    // The sweeper's open runs.
    index('job_runs_open_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index('job_runs_requested_by_idx')
      .on(table.requestedByUserId)
      .where(sql`${table.requestedByUserId} IS NOT NULL`),
  ],
);

// One step a run started. Its output is kept in `job_run_values`, never here.
export const jobRunSteps = pgTable(
  'job_run_steps',
  {
    runId: uuid('run_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    stepIndex: integer('step_index').notNull(),
    kind: varchar('kind', { length: 8 }).$type<StepKind>().notNull(),
    status: varchar('status', { length: 16 })
      .$type<StepStatus>()
      .default('running')
      .notNull(),
    attempts: integer('attempts').default(0).notNull(),
    itemsTotal: integer('items_total').default(0).notNull(),
    itemsDone: integer('items_done').default(0).notNull(),
    itemsCached: integer('items_cached').default(0).notNull(),
    itemsFailed: integer('items_failed').default(0).notNull(),
    itemsSkipped: integer('items_skipped').default(0).notNull(),
    planned: boolean('planned').default(false).notNull(),
    sourceCursor: text('source_cursor'),
    speculated: integer('speculated'),
    used: integer('used'),
    overshoot: integer('overshoot'),
    errorType: varchar('error_type', { length: 128 }),
    errorMessage: text('error_message'),
    // The step's wait, held on its row. Kind and name stay after the wait settles (what it waited for); `wake_at`,
    // when the advance looks again, is cleared.
    waitKind: varchar('wait_kind', { length: 16 }).$type<WaitKind>(),
    // A gate's or signal's name (a code constant, never content); a children step's child job key.
    waitName: varchar('wait_name', { length: 128 }),
    waitSince: timestamp('wait_since', ms),
    wakeAt: timestamp('wake_at', ms),
    // Who sent the signal that settled a wait; null for a timeout's value.
    settledByUserId: text('settled_by_user_id'),
    startedAt: timestamp('started_at', ms),
    completedAt: timestamp('completed_at', ms),
    updatedAt: timestamp('updated_at', ms).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'job_run_steps_pk',
      columns: [table.runId, table.name],
    }),
    unique('job_run_steps_run_index_unique').on(table.runId, table.stepIndex),
    foreignKey({
      name: 'job_run_steps_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [jobRuns.tenantId, jobRuns.id],
    }).onDelete('cascade'),
    check(
      'job_run_steps_kind_check',
      sql`${table.kind} IN ${literalsOf(STEP_KINDS)}`,
    ),
    check(
      'job_run_steps_status_check',
      sql`${table.status} IN ${literalsOf(STEP_STATUSES)}`,
    ),
    check(
      'job_run_steps_wait_kind_check',
      sql`${table.waitKind} IS NULL OR ${table.waitKind} IN ${literalsOf(WAIT_KINDS)}`,
    ),
    check(
      'job_run_steps_waiting_check',
      sql`${table.status} <> 'waiting' OR (${table.waitKind} IS NOT NULL AND ${table.waitSince} IS NOT NULL)`,
    ),
    // The sweep's due waits.
    index('job_run_steps_due_idx')
      .on(table.wakeAt)
      .where(sql`${table.status} = 'waiting' AND ${table.wakeAt} IS NOT NULL`),
    // A gate's push: the tenant's steps waiting on it.
    index('job_run_steps_gate_idx')
      .on(table.tenantId, table.waitName)
      .where(sql`${table.status} = 'waiting' AND ${table.waitKind} = 'gate'`),
    check(
      'job_run_steps_speculation_check',
      sql`(${table.speculated} IS NULL AND ${table.used} IS NULL AND ${table.overshoot} IS NULL) OR (${table.speculated} IS NOT NULL AND ${table.used} IS NOT NULL AND ${table.overshoot} IS NOT NULL)`,
    ),
  ],
);

// One planned item of a map step: a ref (an entity id, never content) and its key. Its result lives in
// `job_item_results`, under its key.
export const jobRunItems = pgTable(
  'job_run_items',
  {
    runId: uuid('run_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    step: varchar('step', { length: 64 }).notNull(),
    ordinal: integer('ordinal').notNull(),
    // Null only for a children step's slot, which has no chunk.
    chunkIndex: integer('chunk_index'),
    itemKey: text('item_key').notNull(),
    itemRef: text('item_ref').notNull(),
    status: varchar('status', { length: 16 })
      .$type<ItemStatus>()
      .default('pending')
      .notNull(),
    attempts: integer('attempts').default(0).notNull(),
    errorType: varchar('error_type', { length: 128 }),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'job_run_items_pk',
      columns: [table.runId, table.step, table.ordinal],
    }),
    // An item is planned once per step.
    unique('job_run_items_key_unique').on(
      table.runId,
      table.step,
      table.itemKey,
    ),
    foreignKey({
      name: 'job_run_items_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [jobRuns.tenantId, jobRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'job_run_items_step_fk',
      columns: [table.runId, table.step],
      foreignColumns: [jobRunSteps.runId, jobRunSteps.name],
    }).onDelete('cascade'),
    check(
      'job_run_items_status_check',
      sql`${table.status} IN ${literalsOf(ITEM_STATUSES)}`,
    ),
    // A claimed chunk's pending items.
    index('job_run_items_pending_idx')
      .on(table.runId, table.step, table.chunkIndex)
      .where(sql`${table.status} = 'pending'`),
    // The operator's item page: a step's failed items first, by ordinal (the rest read the primary key).
    index('job_run_items_failed_idx')
      .on(table.runId, table.step, table.ordinal)
      .where(sql`${table.status} = 'failed'`),
  ],
);

// One chunk of a map step: the unit the engine claims (a lease), tracks and retries.
export const jobRunChunks = pgTable(
  'job_run_chunks',
  {
    runId: uuid('run_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    step: varchar('step', { length: 64 }).notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    status: varchar('status', { length: 16 })
      .$type<ChunkStatus>()
      .default('pending')
      .notNull(),
    // Claims so far; a crash spends one too.
    attempts: integer('attempts').default(0).notNull(),
    // Next eligible, after backoff.
    runAt: timestamp('run_at', ms).notNull(),
    leaseOwner: varchar('lease_owner', { length: 255 }),
    // The claim's own id: the fence compares it, so a same-owner re-claim after a sweep fences out the stale claim.
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', ms),
    itemsTotal: integer('items_total').default(0).notNull(),
    itemsDone: integer('items_done').default(0).notNull(),
    itemsCached: integer('items_cached').default(0).notNull(),
    itemsFailed: integer('items_failed').default(0).notNull(),
    itemsSkipped: integer('items_skipped').default(0).notNull(),
    calls: integer('calls').default(0).notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .default(0)
      .notNull(),
    costUsd: doublePrecision('cost_usd').default(0).notNull(),
    // Calls reserved by the chunk's claim and not yet settled: dropped when it settles, is swept or is canceled.
    reservedUsd: doublePrecision('reserved_usd').default(0).notNull(),
    reservedCalls: integer('reserved_calls').default(0).notNull(),
    lastErrorType: varchar('last_error_type', { length: 128 }),
    lastErrorMessage: text('last_error_message'),
    startedAt: timestamp('started_at', ms),
    completedAt: timestamp('completed_at', ms),
    updatedAt: timestamp('updated_at', ms).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'job_run_chunks_pk',
      columns: [table.runId, table.step, table.chunkIndex],
    }),
    foreignKey({
      name: 'job_run_chunks_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [jobRuns.tenantId, jobRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'job_run_chunks_step_fk',
      columns: [table.runId, table.step],
      foreignColumns: [jobRunSteps.runId, jobRunSteps.name],
    }).onDelete('cascade'),
    check(
      'job_run_chunks_status_check',
      sql`${table.status} IN ${literalsOf(CHUNK_STATUSES)}`,
    ),
    check(
      'job_run_chunks_reserved_check',
      sql`${table.reservedUsd} >= 0 AND ${table.reservedCalls} >= 0`,
    ),
    check(
      'job_run_chunks_lease_check',
      sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL) AND (${table.leaseOwner} IS NULL) = (${table.leaseToken} IS NULL) AND (${table.status} = 'running') = (${table.leaseOwner} IS NOT NULL)`,
    ),
    // The claim.
    index('job_run_chunks_claim_idx')
      .on(table.runAt)
      .where(sql`${table.status} = 'pending'`),
    // The sweep.
    index('job_run_chunks_sweep_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'running'`),
  ],
);

// The engine's event log: one row per event a run emitted (`JOB_EVENT_TYPES`), written by the backend's DB sink.
// Ids, counts and types only, never content: an error by its type, an item by its key (a meaning and an id, never
// text). One table for the engine, not one per job. No retention yet: the log grows with the runs it records and is
// removed with them (cascade).
export const jobRunEvents = pgTable(
  'job_run_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    jobKey: varchar('job_key', { length: 128 }).notNull(),
    type: varchar('type', { length: 32 })
      .$type<JobEventType>()
      .notNull(),
    step: varchar('step', { length: 64 }),
    attempt: integer('attempt'),
    pauseReason: varchar('pause_reason', {
      length: 16,
    }).$type<PauseReason>(),
    errorType: varchar('error_type', { length: 128 }),
    chunkIndex: integer('chunk_index'),
    itemKey: text('item_key'),
    itemsTotal: integer('items_total'),
    itemsDone: integer('items_done'),
    itemsCached: integer('items_cached'),
    itemsFailed: integer('items_failed'),
    itemsSkipped: integer('items_skipped'),
    // A wait's kind and name (`step.waiting`, `step.woke`), and a child run (`child.started`, `child.ended`; no FK).
    waitKind: varchar('wait_kind', { length: 16 }).$type<WaitKind>(),
    waitName: varchar('wait_name', { length: 128 }),
    childRunId: uuid('child_run_id'),
    at: timestamp('at', ms).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'job_run_events_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [jobRuns.tenantId, jobRuns.id],
    }).onDelete('cascade'),
    check(
      'job_run_events_type_check',
      sql`${table.type} IN ${literalsOf(JOB_EVENT_TYPES)}`,
    ),
    check(
      'job_run_events_counts_check',
      sql`(${table.itemsTotal} IS NULL) = (${table.itemsDone} IS NULL) AND (${table.itemsTotal} IS NULL) = (${table.itemsCached} IS NULL) AND (${table.itemsTotal} IS NULL) = (${table.itemsFailed} IS NULL) AND (${table.itemsTotal} IS NULL) = (${table.itemsSkipped} IS NULL)`,
    ),
    // A run's timeline.
    index('job_run_events_run_at_idx').on(table.runId, table.at, table.id),
    // The log: everything, by tenant, by job.
    index('job_run_events_at_idx').on(table.at, table.id),
    index('job_run_events_tenant_at_idx').on(
      table.tenantId,
      table.at,
      table.id,
    ),
    index('job_run_events_job_at_idx').on(table.jobKey, table.at, table.id),
  ],
);

export type JobRunRecord = typeof jobRuns.$inferSelect;
export type JobRunStepRecord = typeof jobRunSteps.$inferSelect;
export type JobRunItemRecord = typeof jobRunItems.$inferSelect;
export type JobRunChunkRecord = typeof jobRunChunks.$inferSelect;
export type JobRunEventRecord = typeof jobRunEvents.$inferSelect;

// A job's values beside its run's bookkeeping: the run's input (name `input`, which no step may take) and each
// completed step's output (name: the step's), as plain JSON the engine checked before writing (`@pattern-stack/jobs`
// refuses a value that isn't, or is over 1 MB). Written once: the first write wins.
export const jobRunValues = pgTable(
  'job_run_values',
  {
    runId: uuid('run_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', ms).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'job_run_values_pk',
      columns: [table.runId, table.name],
    }),
    foreignKey({
      name: 'job_run_values_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [jobRuns.tenantId, jobRuns.id],
    }).onDelete('cascade'),
  ],
);

// A map step's item results, keyed by what the work means: one per tenant, scope (`<jobKey>/<step>`) and item
// key, read back by any later run of the same meaning (the cache). A `read-write` run's first write wins; a `refresh`
// run overwrites the stored answer with its own while its claim holds. They outlive the run that wrote them, so
// `run_id` names the producer without a foreign key; nothing removes them but the app.
export const jobItemResults = pgTable(
  'job_item_results',
  {
    tenantId: text('tenant_id').notNull(),
    scope: varchar('scope', { length: 193 }).notNull(),
    itemKey: text('item_key').notNull(),
    itemRef: text('item_ref').notNull(),
    result: jsonb('result').$type<unknown>().notNull(),
    // The producer: the run whose item wrote it first.
    runId: uuid('run_id').notNull(),
    createdAt: timestamp('created_at', ms).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'job_item_results_pk',
      columns: [table.tenantId, table.scope, table.itemKey],
    }),
  ],
);

/** The job engine's tables, bound once: a column that drifts from what the store reads is a type error. */
export const jobTables = {
  runs: jobRuns,
  steps: jobRunSteps,
  items: jobRunItems,
  chunks: jobRunChunks,
  values: jobRunValues,
  results: jobItemResults,
  events: jobRunEvents,
};

/** The tables the Postgres store reads and writes: the package's own, the one definition. */
export type JobTables = typeof jobTables;
