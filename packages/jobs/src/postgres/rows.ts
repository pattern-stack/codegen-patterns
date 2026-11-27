import { getColumns, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Slot } from '../model/children.ts';
import { type Chunk, CHUNK_STATUSES, type ChunkStatus } from '../model/chunk.ts';
import { type Item, ITEM_STATUSES } from '../model/item.ts';
import { type Budget, CACHE_MODES, PAUSE_REASONS, type Run, RUN_STATUSES, RUN_TRIGGERS } from '../model/run.ts';
import { STEP_KINDS, STEP_STATUSES, type StepState, WAIT_KINDS } from '../model/step-state.ts';
import type { JobRecentRun, StoredJobEvent } from './operator-reads.ts';

/**
 * The one mapping between the run tables and the model. Every read selects a table's columns by their TS names
 * (`selectOf`), with timestamps as epoch milliseconds and bigints as float8, so a row reads the same whatever the
 * driver's type parsers do; zod narrows each raw row, and no value is cast.
 */

/** A table's columns as `<expr> AS "<tsKey>"`, optionally through a table alias. */
export function selectOf(table: PgTable, alias?: string): SQL {
  const parts = Object.entries(getColumns(table)).map(([key, col]) => {
    const ref = refOf(col as AnyPgColumn, alias);
    const expr = readAs(ref, (col as AnyPgColumn).getSQLType());
    return sql`${expr} AS ${sql.identifier(key)}`;
  });
  return sql.join(parts, sql`, `);
}

/** A timestamp as epoch milliseconds and a bigint as float8; every other column as it is. */
function readAs(ref: SQL, sqlType: string): SQL {
  if (sqlType.startsWith('timestamp'))
    return sql`(extract(epoch from ${ref}) * 1000)::float8`;
  if (sqlType === 'bigint') return sql`${ref}::float8`;
  return ref;
}

/** A column by its bare name (an INSERT list, a SET), or through an alias. */
export const refOf = (col: AnyPgColumn, alias?: string): SQL =>
  alias
    ? sql`${sql.identifier(alias)}.${sql.identifier(col.name)}`
    : sql`${sql.identifier(col.name)}`;

/** A timestamp parameter: the store's clock, written as a UTC wall-clock `timestamp(3)`. */
export const tsOf = (d: Date): SQL => sql`${d.toISOString()}::timestamp(3)`;

/** `(a, b, c)` for an `IN`; callers guard the empty list. */
/**
 * A list of the engine's own words as SQL literals, `('a', 'b')`: for a CHECK, a partial index's predicate, and an
 * `ON CONFLICT … WHERE` arbiter, which must match that predicate's text (a bound parameter never does). Only the
 * model's const lists reach it; a word that is not a plain identifier is refused.
 */
export const literalsOf = (values: readonly string[]): SQL => {
  for (const v of values)
    if (!/^[a-z][a-z._-]*$/.test(v)) throw new Error(`not a vocabulary word: ${v}`);
  return sql.raw(`(${values.map((v) => `'${v}'`).join(', ')})`);
};

export const listOf = (values: readonly unknown[]): SQL =>
  sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;

const date = z.number().transform((n) => new Date(n));
const RUN_STATUS = z.enum(RUN_STATUSES);
const PAUSE_REASON = z.enum(PAUSE_REASONS);
const WAIT_KIND = z.enum(WAIT_KINDS);
const num = z.coerce.number();

const runRow = z.object({
  id: z.string(),
  tenantId: z.string(),
  jobKey: z.string(),
  jobVersion: z.string(),
  status: RUN_STATUS,
  pauseReason: PAUSE_REASON.nullable(),
  trigger: z.enum(RUN_TRIGGERS),
  requestedByUserId: z.string().nullable(),
  dryRun: z.boolean(),
  dedupeKey: z.string().nullable(),
  subjectKind: z.string().nullable(),
  subjectId: z.string().nullable(),
  cacheMode: z.enum(CACHE_MODES),
  chunkSize: num,
  chunkConcurrency: num.nullable(),
  maxItems: num,
  maxUsd: num.nullable(),
  maxCalls: num.nullable(),
  deadlineAt: date.nullable(),
  calls: num,
  inputTokens: num,
  costUsd: num,
  parentRunId: z.string().nullable(),
  parentStep: z.string().nullable(),
  childKey: z.string().nullable(),
  depth: num,
  // Not columns of the run: the sums of its chunks' outstanding reservations (`runSelectOf`).
  reservedUsd: num,
  reservedCalls: num,
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: date,
  startedAt: date.nullable(),
  completedAt: date.nullable(),
  updatedAt: date,
});

export function runOf(raw: unknown): Run {
  const r = runRow.parse(raw);
  const budget: Budget = { maxItems: r.maxItems };
  if (r.maxUsd !== null) budget.maxUsd = r.maxUsd;
  if (r.maxCalls !== null) budget.maxCalls = r.maxCalls;
  if (r.deadlineAt !== null) budget.deadline = r.deadlineAt;
  return {
    id: r.id,
    jobKey: r.jobKey,
    jobVersion: r.jobVersion,
    tenantId: r.tenantId,
    dryRun: r.dryRun,
    status: r.status,
    pauseReason: r.pauseReason,
    trigger: r.trigger,
    requestedBy: r.requestedByUserId,
    chunkSize: r.chunkSize,
    chunkConcurrency: r.chunkConcurrency,
    budget,
    cache: r.cacheMode,
    dedupeKey: r.dedupeKey,
    subject:
      r.subjectKind !== null && r.subjectId !== null
        ? { kind: r.subjectKind, id: r.subjectId }
        : null,
    spend: { calls: r.calls, inputTokens: r.inputTokens, costUsd: r.costUsd },
    reservedUsd: r.reservedUsd,
    parentRunId: r.parentRunId,
    parentStep: r.parentStep,
    childKey: r.childKey,
    depth: r.depth,
    error:
      r.errorType === null
        ? null
        : { type: r.errorType, message: r.errorMessage ?? '' },
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

/** What the store reads of a run beyond the model: the calls reserved and not yet spent. */
export const reservedCallsOf = (raw: unknown): number =>
  runRow.pick({ reservedCalls: true }).parse(raw).reservedCalls;

const counts = {
  itemsTotal: num,
  itemsDone: num,
  itemsCached: num,
  itemsFailed: num,
  itemsSkipped: num,
};

const stepRow = z.object({
  runId: z.string(),
  name: z.string(),
  stepIndex: num,
  kind: z.enum(STEP_KINDS),
  status: z.enum(STEP_STATUSES),
  attempts: num,
  ...counts,
  planned: z.boolean(),
  sourceCursor: z.string().nullable(),
  speculated: num.nullable(),
  used: num.nullable(),
  overshoot: num.nullable(),
  waitKind: WAIT_KIND.nullable(),
  waitName: z.string().nullable(),
  waitSince: date.nullable(),
  wakeAt: date.nullable(),
  settledByUserId: z.string().nullable(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: date.nullable(),
  completedAt: date.nullable(),
});

export const zeroChunkCounts = (): Record<ChunkStatus, number> => ({
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
});

export function stepOf(
  raw: unknown,
  chunks: Record<ChunkStatus, number> = zeroChunkCounts(),
): StepState {
  const r = stepRow.parse(raw);
  return {
    runId: r.runId,
    name: r.name,
    index: r.stepIndex,
    kind: r.kind,
    status: r.status,
    attempts: r.attempts,
    counts: {
      total: r.itemsTotal,
      done: r.itemsDone,
      cached: r.itemsCached,
      failed: r.itemsFailed,
      skipped: r.itemsSkipped,
    },
    chunks,
    planned: r.planned,
    sourceCursor: r.sourceCursor,
    speculation:
      r.speculated === null || r.used === null || r.overshoot === null
        ? null
        : { speculated: r.speculated, used: r.used, overshoot: r.overshoot },
    wait:
      r.waitKind === null || r.waitName === null || r.waitSince === null
        ? null
        : {
            kind: r.waitKind,
            name: r.waitName,
            since: r.waitSince,
            wakeAt: r.wakeAt,
          },
    settledBy: r.settledByUserId,
    error:
      r.errorType === null
        ? null
        : { type: r.errorType, message: r.errorMessage ?? '' },
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

const itemRow = z.object({
  runId: z.string(),
  step: z.string(),
  ordinal: num,
  chunkIndex: num,
  itemKey: z.string(),
  itemRef: z.string(),
  status: z.enum(ITEM_STATUSES),
  attempts: num,
  errorType: z.string().nullable(),
});

export function itemOf(raw: unknown): Item {
  const r = itemRow.parse(raw);
  return {
    runId: r.runId,
    step: r.step,
    ordinal: r.ordinal,
    chunkIndex: r.chunkIndex,
    key: r.itemKey,
    ref: r.itemRef,
    status: r.status,
    attempts: r.attempts,
    errorType: r.errorType,
  };
}

const chunkRow = z.object({
  runId: z.string(),
  step: z.string(),
  chunkIndex: num,
  status: z.enum(CHUNK_STATUSES),
  attempts: num,
  runAt: date,
  leaseOwner: z.string().nullable(),
  leaseToken: z.string().nullable(),
  leaseExpiresAt: date.nullable(),
  ...counts,
  calls: num,
  inputTokens: num,
  costUsd: num,
  lastErrorType: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
});

export function chunkOf(raw: unknown): Chunk {
  const r = chunkRow.parse(raw);
  return {
    runId: r.runId,
    step: r.step,
    index: r.chunkIndex,
    status: r.status,
    attempts: r.attempts,
    runAt: r.runAt,
    claim:
      r.leaseOwner !== null &&
      r.leaseToken !== null &&
      r.leaseExpiresAt !== null
        ? {
            owner: r.leaseOwner,
            token: r.leaseToken,
            expiresAt: r.leaseExpiresAt,
          }
        : null,
    counts: {
      total: r.itemsTotal,
      done: r.itemsDone,
      cached: r.itemsCached,
      failed: r.itemsFailed,
      skipped: r.itemsSkipped,
    },
    spend: { calls: r.calls, inputTokens: r.inputTokens, costUsd: r.costUsd },
    lastError:
      r.lastErrorType === null
        ? null
        : { type: r.lastErrorType, message: r.lastErrorMessage ?? '' },
  };
}

/** A `status, count` row of a `GROUP BY status`. */
export const statusCountOf = (
  raw: unknown,
): { status: ChunkStatus; n: number; step?: string } =>
  z
    .object({
      status: z.enum(CHUNK_STATUSES),
      n: num,
      step: z.string().optional(),
    })
    .parse(raw);

/** A claim's coordinates and lease as the claim statement returns them. */
export const claimRowOf = (raw: unknown) =>
  z
    .object({
      runId: z.string(),
      step: z.string(),
      chunkIndex: num,
      attempts: num,
      leaseToken: z.string(),
      leaseExpiresAt: date,
    })
    .parse(raw);

/** A stored item result, as `itemResults` reads it from `job_item_results`. */
export const itemResultRowOf = (raw: unknown) =>
  z
    .object({
      tenantId: z.string(),
      scope: z.string(),
      itemKey: z.string(),
      itemRef: z.string(),
      result: z.unknown(),
      runId: z.string(),
      createdAt: date,
    })
    .parse(raw);

/** A kept value as `runInput` and `stepOutput` read it: `kept` false when the run has none under that name. */
export const valueRowOf = (raw: unknown) =>
  z.object({ value: z.unknown(), kept: z.boolean() }).parse(raw);

const eventRow = z.object({
  id: z.string(),
  tenantId: z.string(),
  runId: z.string(),
  jobKey: z.string(),
  type: z.enum([
    'run.started',
    'run.paused',
    'run.resumed',
    'run.completed',
    'run.failed',
    'run.canceled',
    'step.started',
    'step.progress',
    'step.completed',
    'step.failed',
    'step.skipped',
    'step.retried',
    'step.waiting',
    'step.woke',
    'step.signaled',
    'child.started',
    'child.ended',
    'item.failed',
  ]),
  step: z.string().nullable(),
  attempt: num.nullable(),
  pauseReason: PAUSE_REASON.nullable(),
  waitKind: WAIT_KIND.nullable(),
  waitName: z.string().nullable(),
  errorType: z.string().nullable(),
  chunkIndex: num.nullable(),
  itemKey: z.string().nullable(),
  itemsTotal: num.nullable(),
  itemsDone: num.nullable(),
  itemsCached: num.nullable(),
  itemsFailed: num.nullable(),
  itemsSkipped: num.nullable(),
  at: date,
});

/** A `job_run_events` row as the operator reads it. */
export function storedEventOf(raw: unknown): StoredJobEvent {
  const r = eventRow.parse(raw);
  return {
    id: r.id,
    runId: r.runId,
    tenantId: r.tenantId,
    jobKey: r.jobKey,
    type: r.type,
    step: r.step,
    attempt: r.attempt,
    pauseReason: r.pauseReason,
    errorType: r.errorType,
    chunk: r.chunkIndex,
    itemKey: r.itemKey,
    waitKind: r.waitKind,
    waitName: r.waitName,
    counts:
      r.itemsTotal === null ||
      r.itemsDone === null ||
      r.itemsCached === null ||
      r.itemsFailed === null ||
      r.itemsSkipped === null
        ? null
        : {
            total: r.itemsTotal,
            done: r.itemsDone,
            cached: r.itemsCached,
            failed: r.itemsFailed,
            skipped: r.itemsSkipped,
          },
    at: r.at,
  };
}

const recentRunRow = z.object({
  jobKey: z.string(),
  id: z.string(),
  tenantId: z.string(),
  status: RUN_STATUS,
  createdAt: date,
  startedAt: date.nullable(),
  completedAt: date.nullable(),
});

/** One row of `listNewestRunsPerJob`. */
export const recentRunOf = (raw: unknown): JobRecentRun =>
  recentRunRow.parse(raw);

const slotRow = z.object({
  key: z.string(),
  childRunId: z.string(),
  ordinal: num,
  status: z.enum(ITEM_STATUSES),
  attempts: num,
  errorType: z.string().nullable(),
});

/** A children step's slot, from its item row. */
export function slotOf(raw: unknown): Slot {
  const r = slotRow.parse(raw);
  return { ...r, status: r.status === 'cached' ? 'done' : r.status };
}
