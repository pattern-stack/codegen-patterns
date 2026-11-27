import type { RunLeases } from '../ports/run-lease.ts';
import { type SQL, sql } from 'drizzle-orm';
import { MAX_CHILDREN, type NewChild, type Slot } from '../model/children.ts';
import type {
  Chunk,
  ChunkClaim,
  ChunkStatus,
  RenewReport,
  SettleOutcome,
} from '../model/chunk.ts';
import {
  ClaimLostError,
  JobDefinitionError,
  RunNotFoundError,
} from '../model/errors.ts';
import type { JobEvent } from '../model/events.ts';
import type { Done, Failed, Item, ItemRef, ItemResult } from '../model/item.ts';
import {
  ACTIVE_RUN,
  budgetStop,
  canTransition,
  checkNewRun,
  MAX_DEPTH,
  type NewRun,
  type Run,
  type RunError,
  type RunProgress,
  type RunStatus,
  type RunSubject,
  type RunTransition,
  type Spend,
  TERMINAL_RUN,
} from '../model/run.ts';
import type { Speculation, StepState, WaitKind } from '../model/step-state.ts';
import type { ItemRange, JobStore, Reservation } from '../ports/job-store.ts';
import { type JobTables, jobTables } from './tables.ts';
import type {
  EventLogQuery,
  JobOperatorReads,
  JobRecentRun,
  OperatorItem,
  OperatorRunQuery,
  RunEventQuery,
  RunItemQuery,
  StoredJobEvent,
} from './operator-reads.ts';
import {
  chunkOf,
  claimRowOf,
  itemOf,
  itemResultRowOf,
  listOf,
  literalsOf,
  recentRunOf,
  refOf,
  reservedCallsOf,
  runOf,
  selectOf,
  slotOf,
  statusCountOf,
  stepOf,
  storedEventOf,
  tsOf,
  valueRowOf,
  zeroChunkCounts,
} from './rows.ts';

/**
 * The database the store runs on: a node-postgres Drizzle database or one of its transactions (a nested
 * `transaction` is a savepoint). Structural, so the backend's `NodePgDatabase` and a test's transaction both fit
 * and this package never names the backend's schema.
 */
export interface JobDatabase {
  /**
   * Rows as objects: Drizzle's `'objects'` mode (rc.5) answers an array; rc.4's node-postgres answers a `QueryResult`
   * whose `rows` are the objects. Both fit.
   */
  execute(query: SQL, mode: 'objects'): PromiseLike<unknown[] | { rows: unknown[] }>;
  transaction<T>(fn: (tx: JobDatabase) => Promise<T>): Promise<T>;
}

export interface PostgresJobStoreOptions {
  /** The store's clock: claim expiry, eligibility, the sweep, every timestamp. Default system time. */
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The model's lists as literals: `OPEN` must match the one-open-run index's predicate for `ON CONFLICT`. */
const OPEN = literalsOf(ACTIVE_RUN);
const TERMINAL = literalsOf(TERMINAL_RUN);
/** Expired claims one sweep returns: bounded per call; the next sweep takes the rest. */
const SWEEP_LIMIT = 1000;
/** Rows per multi-row INSERT. */
const INSERT_PAGE = 1000;

const rowsOf = async (db: JobDatabase, query: SQL): Promise<unknown[]> => {
  const result = await db.execute(query, 'objects');
  return Array.isArray(result) ? result : result.rows;
};

const isTerminal = (to: RunTransition['to']): boolean =>
  TERMINAL_RUN.includes(to);

/** One chunk's reservation moves by `usd` and `calls`, never below zero (a sub-picodollar remainder is zero). */
const nextReserved = (current: SQL, delta: number): SQL =>
  sql`CASE WHEN ${current} + ${delta} > 1e-12 THEN ${current} + ${delta} ELSE 0 END`;

/** A value as a `jsonb` parameter: the engine has checked it is plain JSON. */
const jsonOf = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

/** The name a run's input is kept under in `job_run_values`: reserved, so no step can take it. */
const INPUT = 'input';

/**
 * The durable `JobStore` on Postgres. It keeps a job's values (the run's input, each step's output, each item's
 * result) as JSON in `job_run_values` and `job_item_results`, beside the bookkeeping and never in it, so a run read
 * never carries one. A claim is a lease on a chunk row (`FOR UPDATE SKIP
 * LOCKED`), every chunk write is fenced by it, and every timestamp comes from the injected clock, never SQL `now()`.
 * Every row's `tenant_id` is copied from its run inside the statement that writes it, never from a caller.
 * A transaction that writes a run's chunks or items locks the run row first (`FOR NO KEY UPDATE`), then the chunk, so
 * a cancel and a chunk's write never wait on each other in opposite orders. What a run has reserved and not spent is
 * held on its chunks, one claim's calls each, and summed on every read of the run.
 */
export class PostgresJobStore implements JobStore, JobOperatorReads {
  readonly durability = 'durable' as const;
  readonly keepsValues = true;
  private readonly now: () => Date;

  constructor(
    private readonly db: JobDatabase,
    private readonly tables: JobTables = jobTables,
    options: PostgresJobStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** The advance lease, on `job_runs`' `advance_*` columns: one statement each, timestamps from the store's clock. */
  readonly runLeases: RunLeases = {
    leaseRun: async (runId, owner, ttlMs) => {
      if (!UUID.test(runId)) return null;
      const R = this.tables.runs;
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ttlMs);
      const [row] = await rowsOf(
        this.db,
        sql`UPDATE ${R} SET ${refOf(R.advanceOwner)} = ${owner}, ${refOf(R.advanceToken)} = gen_random_uuid(),
            ${refOf(R.advanceExpiresAt)} = ${tsOf(expiresAt)}
          WHERE ${R.id} = ${runId}
            AND (${R.advanceOwner} IS NULL OR ${R.advanceOwner} = ${owner} OR ${R.advanceExpiresAt} <= ${tsOf(now)})
          RETURNING ${R.advanceToken} AS "token"`,
      );
      if (!row) return null;
      return { runId, owner, token: String((row as { token: unknown }).token), expiresAt };
    },
    renewRunLeases: async (leases, ttlMs) => {
      const R = this.tables.runs;
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ttlMs);
      const kept = new Set<string>();
      for (const l of leases) {
        if (!UUID.test(l.runId) || !UUID.test(l.token)) continue;
        const [row] = await rowsOf(
          this.db,
          sql`UPDATE ${R} SET ${refOf(R.advanceExpiresAt)} = ${tsOf(expiresAt)}
            WHERE ${R.id} = ${l.runId} AND ${R.advanceOwner} = ${l.owner} AND ${R.advanceToken} = ${l.token}
              AND ${R.advanceExpiresAt} > ${tsOf(now)}
            RETURNING ${R.id} AS "id"`,
        );
        if (row) kept.add(`${l.runId}@${l.token}`);
      }
      return { lost: leases.filter((l) => !kept.has(`${l.runId}@${l.token}`)) };
    },
    releaseRunLease: async (lease) => {
      if (!UUID.test(lease.runId) || !UUID.test(lease.token)) return;
      const R = this.tables.runs;
      await rowsOf(
        this.db,
        sql`UPDATE ${R} SET ${refOf(R.advanceOwner)} = NULL, ${refOf(R.advanceToken)} = NULL, ${refOf(R.advanceExpiresAt)} = NULL
          WHERE ${R.id} = ${lease.runId} AND ${R.advanceOwner} = ${lease.owner} AND ${R.advanceToken} = ${lease.token}`,
      );
    },
  };

  /** A run's columns, and its reservations: the sums over its chunks. */
  private runSelect(): SQL {
    const R = this.tables.runs;
    const C = this.tables.chunks;
    const held = (col: typeof C.reservedUsd | typeof C.reservedCalls) =>
      sql`(SELECT coalesce(sum(${refOf(col, 'rc')}), 0) FROM ${C} rc WHERE ${refOf(C.runId, 'rc')} = ${R.id})`;
    return sql`${selectOf(R)}, ${held(C.reservedUsd)}::float8 AS "reservedUsd", ${held(C.reservedCalls)}::int AS "reservedCalls"`;
  }

  /** Clears a chunk's claim and drops its outstanding reservations: a settle, a sweep or a cancel. */
  private unleased(): SQL[] {
    const C = this.tables.chunks;
    return [
      sql`${refOf(C.leaseOwner)} = NULL`,
      sql`${refOf(C.leaseToken)} = NULL`,
      sql`${refOf(C.leaseExpiresAt)} = NULL`,
      sql`${refOf(C.reservedUsd)} = 0`,
      sql`${refOf(C.reservedCalls)} = 0`,
    ];
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async createRun(req: NewRun): Promise<{ run: Run; created: boolean }> {
    const chunkSize = checkNewRun(req);
    const R = this.tables.runs;
    const now = tsOf(this.now());
    const dedupeKey = req.dedupeKey || null;
    const columns = [
      R.tenantId,
      R.jobKey,
      R.jobVersion,
      R.trigger,
      R.requestedByUserId,
      R.dryRun,
      R.dedupeKey,
      R.subjectKind,
      R.subjectId,
      R.cacheMode,
      R.chunkSize,
      R.chunkConcurrency,
      R.maxItems,
      R.maxUsd,
      R.maxCalls,
      R.deadlineAt,
      R.createdAt,
      R.updatedAt,
    ];
    const values = [
      sql`${req.tenantId}`,
      sql`${req.jobKey}`,
      sql`${req.jobVersion}`,
      sql`${req.trigger}`,
      sql`${req.requestedBy}`,
      sql`${req.dryRun ?? false}`,
      sql`${dedupeKey}`,
      sql`${req.subject?.kind ?? null}`,
      sql`${req.subject?.id ?? null}`,
      sql`${req.cache ?? 'read-write'}`,
      sql`${chunkSize}`,
      sql`${req.chunkConcurrency ?? null}`,
      sql`${req.budget.maxItems}`,
      sql`${req.budget.maxUsd ?? null}`,
      sql`${req.budget.maxCalls ?? null}`,
      req.budget.deadline ? tsOf(req.budget.deadline) : sql`NULL`,
      now,
      now,
    ];
    const insertAs = (status: 'pending' | 'queued') =>
      sql`INSERT INTO ${R} (${sql.join(
        [...columns, R.status].map((c) => refOf(c)),
        sql`, `,
      )}) VALUES (${sql.join([...values, sql`${status}`], sql`, `)})`;
    const insert = insertAs('pending');
    // The run and its input commit in one statement: a created run is never without the input it was made with.
    const V = this.tables.values;
    const created = (ins: SQL): SQL =>
      req.input === undefined
        ? sql`${ins} RETURNING ${this.runSelect()}`
        : sql`WITH r AS (${ins} RETURNING ${this.runSelect()}),
            v AS (INSERT INTO ${V} (${refOf(V.runId)}, ${refOf(V.tenantId)}, ${refOf(V.name)}, ${refOf(V.value)}, ${refOf(V.createdAt)})
              SELECT r."id", r."tenantId", ${INPUT}, ${jsonOf(req.input)}, ${now} FROM r)
          SELECT * FROM r`;
    if (dedupeKey === null) {
      const [row] = await rowsOf(this.db, created(insert));
      return { run: runOf(row), created: true };
    }
    const onKey = sql`${R.tenantId} = ${req.tenantId} AND ${R.jobKey} = ${req.jobKey}
      AND ${R.dryRun} = ${req.dryRun ?? false} AND ${R.dedupeKey} = ${dedupeKey}`;
    const window = req.dedupeWindowMs ?? 0;
    if (window > 0) {
      // A start within the window after a run on the key ended is that run, unless one is open (then the collision
      // rule answers).
      const [open] = await rowsOf(
        this.db,
        sql`SELECT ${R.id} FROM ${R} WHERE ${onKey} AND ${R.status} IN ${OPEN}`,
      );
      if (!open) {
        const since = tsOf(new Date(this.now().getTime() - window));
        const [recent] = await rowsOf(
          this.db,
          sql`SELECT ${this.runSelect()} FROM ${R}
            WHERE ${onKey} AND ${R.status} IN ${TERMINAL} AND ${R.completedAt} >= ${since}
            ORDER BY ${R.completedAt} DESC, ${R.id} DESC LIMIT 1`,
        );
        if (recent) return { run: runOf(recent), created: false };
      }
    }
    const tryInsert = async () =>
      (
        await rowsOf(
          this.db,
          created(
            sql`${insert} ON CONFLICT (${refOf(R.tenantId)}, ${refOf(R.jobKey)}, ${refOf(R.dryRun)}, ${refOf(R.dedupeKey)})
            WHERE ${refOf(R.dedupeKey)} IS NOT NULL AND ${refOf(R.status)} IN ${OPEN}
            DO NOTHING`,
          ),
        )
      )[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await tryInsert();
      if (inserted) return { run: runOf(inserted), created: true };
      const [open] = await rowsOf(
        this.db,
        sql`SELECT ${this.runSelect()} FROM ${R}
          WHERE ${R.tenantId} = ${req.tenantId} AND ${R.jobKey} = ${req.jobKey}
            AND ${R.dryRun} = ${req.dryRun ?? false}
            AND ${R.dedupeKey} = ${dedupeKey} AND ${R.status} IN ${OPEN}`,
      );
      if (open && req.collision === 'queue') {
        // Held behind the open run: lock it, and if it is still open the new run is queued behind it (outside the
        // one-open-run index). A run that ends meanwhile makes the next attempt a plain insert. The run's end
        // locks the same row before it promotes, so no queued run is left behind a run that already ended.
        const queued = await this.db.transaction(async (tx) => {
          const [held] = await rowsOf(
            tx,
            sql`SELECT ${R.id} FROM ${R} WHERE ${onKey} AND ${R.status} IN ${OPEN} FOR UPDATE`,
          );
          if (!held) return null;
          const [row] = await rowsOf(tx, created(insertAs('queued')));
          return row;
        });
        if (queued) return { run: runOf(queued), created: true };
        continue;
      }
      if (open) return { run: runOf(open), created: false };
      // The incumbent closed between the two statements: insert once more.
    }
    throw new Error(
      `${req.jobKey}: could not create or find the open run on its dedupe key`,
    );
  }

  /** The run's raw row, its reservations summed over its chunks. Takes no lock. */
  private async runRow(db: JobDatabase, runId: string): Promise<unknown> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const [row] = await rowsOf(
      db,
      sql`SELECT ${this.runSelect()} FROM ${R} WHERE ${R.id} = ${runId}`,
    );
    if (!row) throw new RunNotFoundError(runId);
    return row;
  }

  /** Locks the run row (`FOR NO KEY UPDATE`) for the rest of the transaction, and reads nothing. */
  private async lockRun(db: JobDatabase, runId: string): Promise<void> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const [row] = await rowsOf(
      db,
      sql`SELECT 1 AS "one" FROM ${R} WHERE ${R.id} = ${runId} FOR NO KEY UPDATE`,
    );
    if (!row) throw new RunNotFoundError(runId);
  }

  /**
   * Locks the run row, then reads it in a new statement. One locking statement would compute the chunk sums from its
   * snapshot, taken before it waited for the lock: a reserve that waited on another would miss its reservation.
   */
  private async lockedRunRow(db: JobDatabase, runId: string): Promise<unknown> {
    await this.lockRun(db, runId);
    return this.runRow(db, runId);
  }

  async getRun(runId: string): Promise<Run> {
    return runOf(await this.runRow(this.db, runId));
  }

  async openRunIds(limit: number, after?: string): Promise<string[]> {
    const R = this.tables.runs;
    // Keyset past `after` in the same order; a run the table doesn't have makes the row comparison null: no rows.
    const past =
      after === undefined
        ? sql``
        : sql`AND (${R.createdAt}, ${R.id}) > (SELECT ${R.createdAt}, ${R.id} FROM ${R} WHERE ${R.id} = ${after})`;
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${R.id} AS "id" FROM ${R} WHERE ${R.status} IN ('pending', 'running') ${past}
        ORDER BY ${R.createdAt}, ${R.id} LIMIT ${Math.max(0, Math.floor(limit))}`,
    );
    return rows.map((r) => String((r as { id: unknown }).id));
  }

  async listRuns(filter: {
    tenantId: string;
    jobKey?: string;
    status?: RunStatus;
    subject?: RunSubject;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<Run[]> {
    const R = this.tables.runs;
    const { before, subject } = filter;
    if (filter.limit <= 0) return [];
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${this.runSelect()} FROM ${R}
        WHERE ${R.tenantId} = ${filter.tenantId}
          ${filter.jobKey ? sql`AND ${R.jobKey} = ${filter.jobKey}` : sql``}
          ${filter.status ? sql`AND ${R.status} = ${filter.status}` : sql``}
          ${subject ? sql`AND ${R.subjectKind} = ${subject.kind} AND ${R.subjectId} = ${subject.id}` : sql``}
          ${before ? sql`AND (${R.createdAt}, ${R.id}) < (${tsOf(before.createdAt)}, ${before.id}::uuid)` : sql``}
        ORDER BY ${R.createdAt} DESC, ${R.id} DESC LIMIT ${Math.floor(filter.limit)}`,
    );
    return rows.map(runOf);
  }

  /**
   * The most recent runs of these jobs across every tenant, newest first. Not on the port (which keeps the
   * tenant required): the operator read behind a superuser surface only.
   */
  async listRecentAcrossTenants(filter: {
    jobKeys: readonly string[];
    limit: number;
  }): Promise<Run[]> {
    if (!filter.jobKeys.length || filter.limit <= 0) return [];
    const R = this.tables.runs;
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${this.runSelect()} FROM ${R} WHERE ${R.jobKey} IN ${listOf(filter.jobKeys)}
        ORDER BY ${R.createdAt} DESC, ${R.id} DESC LIMIT ${Math.floor(filter.limit)}`,
    );
    return rows.map(runOf);
  }

  /**
   * Runs across every tenant, newest first, filtered by job, tenant and status and keyset paged after
   * `before`. Off the port: the operator read behind a superuser surface only. Served by `job_runs_job_created_idx`,
   * `job_runs_tenant_created_idx` / `job_runs_tenant_job_created_idx`, `job_runs_status_created_idx` or `job_runs_created_idx`.
   */
  async listRunsAcrossTenants(query: OperatorRunQuery): Promise<Run[]> {
    if (query.limit <= 0) return [];
    const R = this.tables.runs;
    const { before } = query;
    const where: SQL[] = [];
    if (query.jobKey) where.push(sql`${R.jobKey} = ${query.jobKey}`);
    if (query.tenantId)
      where.push(sql`${R.tenantId} = ${query.tenantId}`);
    if (query.status) where.push(sql`${R.status} = ${query.status}`);
    if (query.subject)
      where.push(
        sql`${R.subjectKind} = ${query.subject.kind} AND ${R.subjectId} = ${query.subject.id}`,
      );
    // Through `job_runs_parent_idx`.
    if (query.parentRunId)
      where.push(sql`${R.parentRunId} = ${query.parentRunId}::uuid`);
    if (before)
      where.push(
        sql`(${R.createdAt}, ${R.id}) < (${tsOf(before.at)}, ${before.id}::uuid)`,
      );
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${this.runSelect()} FROM ${R}
        ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
        ORDER BY ${R.createdAt} DESC, ${R.id} DESC LIMIT ${Math.floor(query.limit)}`,
    );
    return rows.map(runOf);
  }

  /**
   * Each job's newest `perJob` runs, whatever their status, in one statement: a lateral read per job over
   * `job_runs_job_created_idx`, never a scan of the job's history. Newest first within each job; what they say of the
   * job's health is the shared `jobHealthOf`, never SQL.
   */
  async listNewestRunsPerJob(
    jobKeys: readonly string[],
    perJob: number,
  ): Promise<JobRecentRun[]> {
    if (!jobKeys.length || perJob <= 0) return [];
    const R = this.tables.runs;
    const ms = (col: SQL) => sql`(extract(epoch from ${col}) * 1000)::float8`;
    const rows = await rowsOf(
      this.db,
      sql`SELECT k.key AS "jobKey", r.id, r.tenant_id AS "tenantId", r.status,
          ${ms(sql`r.created_at`)} AS "createdAt", ${ms(sql`r.started_at`)} AS "startedAt",
          ${ms(sql`r.completed_at`)} AS "completedAt"
        FROM jsonb_array_elements_text(${JSON.stringify(jobKeys)}::jsonb) AS k(key)
        CROSS JOIN LATERAL (
          SELECT ${R.id} AS id, ${R.tenantId} AS tenant_id, ${R.status} AS status,
            ${R.createdAt} AS created_at, ${R.startedAt} AS started_at, ${R.completedAt} AS completed_at
          FROM ${R} WHERE ${R.jobKey} = k.key
          ORDER BY ${R.createdAt} DESC, ${R.id} DESC LIMIT ${Math.floor(perJob)}
        ) r
        ORDER BY k.key, r.created_at DESC, r.id DESC`,
    );
    return rows.map(recentRunOf);
  }

  /**
   * A step's items, a page at a time: its failed items first (over `job_run_items_failed_idx`), then the rest (over
   * the primary key), each by ordinal, continuing after `after`. Never the whole step, as `items()` is.
   */
  async listRunItems(query: RunItemQuery): Promise<OperatorItem[]> {
    if (query.limit <= 0) return [];
    const I = this.tables.items;
    const { after } = query;
    const page = async (
      rank: 0 | 1,
      limit: number,
    ): Promise<OperatorItem[]> => {
      if (limit <= 0 || (after && after.rank > rank)) return [];
      const from = after && after.rank === rank ? after.ordinal : -1;
      const byRank =
        rank === 0 ? sql`${I.status} = 'failed'` : sql`${I.status} <> 'failed'`;
      const status = query.status ? sql`${I.status} = ${query.status}` : byRank;
      const rows = await rowsOf(
        this.db,
        sql`SELECT ${selectOf(I)} FROM ${I}
          WHERE ${I.runId} = ${query.runId} AND ${I.step} = ${query.step} AND ${status} AND ${I.ordinal} > ${from}
          ORDER BY ${I.ordinal} LIMIT ${Math.floor(limit)}`,
      );
      return rows.map(itemOf).map(({ runId: _r, step: _s, ...item }) => item);
    };
    if (query.status)
      return page(query.status === 'failed' ? 0 : 1, query.limit);
    const failed = await page(0, query.limit);
    return [...failed, ...(await page(1, query.limit - failed.length))];
  }

  /**
   * Appends one engine event to the log. Its tenant, run and job come from the run row inside the statement,
   * never from the caller; an event of a run that is gone writes nothing. Ids, counts and types only.
   */
  async appendEvent(event: JobEvent): Promise<void> {
    const R = this.tables.runs;
    const E = this.tables.events;
    const step = 'step' in event ? event.step : null;
    const attempt = 'attempt' in event ? event.attempt : null;
    const counts =
      event.type === 'step.progress' || event.type === 'step.completed'
        ? event.counts
        : null;
    const cols = [
      E.tenantId,
      E.runId,
      E.jobKey,
      E.type,
      E.step,
      E.attempt,
      E.pauseReason,
      E.errorType,
      E.chunkIndex,
      E.itemKey,
      E.itemsTotal,
      E.itemsDone,
      E.itemsCached,
      E.itemsFailed,
      E.itemsSkipped,
      E.waitKind,
      E.waitName,
      E.childRunId,
      E.at,
    ];
    await rowsOf(
      this.db,
      sql`INSERT INTO ${E} (${sql.join(
        cols.map((c) => refOf(c)),
        sql`, `,
      )})
        SELECT ${R.tenantId}, ${R.id}, ${R.jobKey}, ${event.type}, ${step}, ${attempt}::int,
          ${event.type === 'run.paused' ? event.reason : null},
          ${'errorType' in event && event.errorType !== null ? event.errorType.slice(0, 128) : null},
          ${event.type === 'step.retried' ? event.chunk : null}::int,
          ${itemKeyOf(event)},
          ${counts?.total ?? null}::int, ${counts?.done ?? null}::int, ${counts?.cached ?? null}::int,
          ${counts?.failed ?? null}::int, ${counts?.skipped ?? null}::int,
          ${'waitKind' in event ? event.waitKind : null}, ${'waitName' in event ? event.waitName : null},
          ${'childRunId' in event ? event.childRunId : null}::uuid, ${tsOf(event.at)}
        FROM ${R} WHERE ${R.id} = ${event.runId}::uuid`,
    );
  }

  /** A run's events, oldest first, after `after`, over `job_run_events_run_at_idx`. */
  async listRunEvents(query: RunEventQuery): Promise<StoredJobEvent[]> {
    if (query.limit <= 0) return [];
    const E = this.tables.events;
    const { after } = query;
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(E)} FROM ${E} WHERE ${E.runId} = ${query.runId}::uuid
        ${after ? sql`AND (${E.at}, ${E.id}) > (${tsOf(after.at)}, ${after.id}::uuid)` : sql``}
        ORDER BY ${E.at}, ${E.id} LIMIT ${Math.floor(query.limit)}`,
    );
    return rows.map(storedEventOf);
  }

  /**
   * The event log across tenants, newest first, filtered by job, tenant and type, keyset paged. Off the
   * port: a superuser surface only. Served by the `job_run_events_*_at_idx` indexes.
   */
  async listEvents(query: EventLogQuery): Promise<StoredJobEvent[]> {
    if (query.limit <= 0) return [];
    const E = this.tables.events;
    const { before } = query;
    const where: SQL[] = [];
    if (query.jobKey) where.push(sql`${E.jobKey} = ${query.jobKey}`);
    if (query.tenantId)
      where.push(sql`${E.tenantId} = ${query.tenantId}`);
    if (query.type) where.push(sql`${E.type} = ${query.type}`);
    if (before)
      where.push(
        sql`(${E.at}, ${E.id}) < (${tsOf(before.at)}, ${before.id}::uuid)`,
      );
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(E)} FROM ${E}
        ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
        ORDER BY ${E.at} DESC, ${E.id} DESC LIMIT ${Math.floor(query.limit)}`,
    );
    return rows.map(storedEventOf);
  }

  async transition(
    runId: string,
    t: RunTransition,
  ): Promise<{ changed: boolean; run: Run; cascaded: Run[] }> {
    return this.db.transaction((tx) => this.transitionOn(tx, runId, t));
  }

  private async transitionOn(
    db: JobDatabase,
    runId: string,
    t: RunTransition,
  ): Promise<{ changed: boolean; run: Run; cascaded: Run[] }> {
    const R = this.tables.runs;
    const C = this.tables.chunks;
    const S = this.tables.steps;
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    // The parent's row first, then the run's, then its descendants': the one lock order down a tree.
    const [link] = await rowsOf(
      db,
      sql`SELECT ${R.parentRunId} AS "parentRunId" FROM ${R} WHERE ${R.id} = ${runId}`,
    );
    const parentRunId = (link as { parentRunId?: string | null } | undefined)
      ?.parentRunId;
    if (parentRunId) await this.lockRun(db, parentRunId);
    const run = runOf(await this.lockedRunRow(db, runId));
    if (!canTransition(run.status, t))
      return { changed: false, run, cascaded: [] };
    const now = tsOf(this.now());
    const set: SQL[] = [
      sql`${refOf(R.status)} = ${t.to}`,
      sql`${refOf(R.pauseReason)} = ${t.to === 'paused' ? t.reason : null}`,
      sql`${refOf(R.updatedAt)} = ${now}`,
    ];
    if (t.to === 'running') {
      set.push(sql`${refOf(R.startedAt)} = coalesce(${R.startedAt}, ${now})`);
      if (t.from === 'paused' && t.budget)
        set.push(
          sql`${refOf(R.maxItems)} = ${t.budget.maxItems}`,
          sql`${refOf(R.maxUsd)} = ${t.budget.maxUsd ?? null}`,
          sql`${refOf(R.maxCalls)} = ${t.budget.maxCalls ?? null}`,
          sql`${refOf(R.deadlineAt)} = ${t.budget.deadline ? tsOf(t.budget.deadline) : sql`NULL`}`,
        );
    }
    if (t.to === 'failed')
      set.push(
        sql`${refOf(R.errorType)} = ${t.error.type.slice(0, 128)}`,
        sql`${refOf(R.errorMessage)} = ${t.error.message}`,
      );
    if (isTerminal(t.to)) set.push(sql`${refOf(R.completedAt)} = ${now}`);
    await rowsOf(
      db,
      sql`UPDATE ${R} SET ${sql.join(set, sql`, `)} WHERE ${R.id} = ${runId}`,
    );
    if (isTerminal(t.to))
      await rowsOf(
        db,
        sql`UPDATE ${C} SET ${refOf(C.status)} = 'canceled', ${sql.join(this.unleased(), sql`, `)},
            ${refOf(C.updatedAt)} = ${now}
          WHERE ${C.runId} = ${runId} AND ${C.status} IN ('pending', 'running')`,
      );
    const cascaded: Run[] = [];
    const cascade = async (where: SQL, assign: SQL) => {
      const rows = await rowsOf(
        db,
        sql`WITH RECURSIVE tree AS (
            SELECT ${R.id} AS id FROM ${R} WHERE ${R.parentRunId} = ${runId}
            UNION ALL
            SELECT c.${sql.identifier(R.id.name)} FROM ${R} c JOIN tree ON c.${sql.identifier(R.parentRunId.name)} = tree.id
          )
          UPDATE ${R} SET ${assign}, ${refOf(R.updatedAt)} = ${now}
          WHERE ${R.id} IN (SELECT id FROM tree) AND ${where}
          RETURNING ${R.id} AS "id"`,
      );
      for (const row of rows) {
        const id = String((row as { id: unknown }).id);
        if (isTerminal(t.to))
          await rowsOf(
            db,
            sql`UPDATE ${C} SET ${refOf(C.status)} = 'canceled', ${sql.join(this.unleased(), sql`, `)},
                ${refOf(C.updatedAt)} = ${now}
              WHERE ${C.runId} = ${id} AND ${C.status} IN ('pending', 'running')`,
          );
        cascaded.push(runOf(await this.runRow(db, id)));
      }
    };
    if (isTerminal(t.to) && run.dedupeKey !== null) {
      // The run ahead on its dedupe key ended: the oldest run queued behind it is pending now, when none is open.
      const onKey = sql`${R.tenantId} = ${run.tenantId} AND ${R.jobKey} = ${run.jobKey}
        AND ${R.dryRun} = ${run.dryRun} AND ${R.dedupeKey} = ${run.dedupeKey}`;
      await rowsOf(
        db,
        sql`UPDATE ${R} SET ${refOf(R.status)} = 'pending', ${refOf(R.updatedAt)} = ${now}
          WHERE ${R.id} = (
            SELECT ${R.id} FROM ${R} WHERE ${onKey} AND ${R.status} = 'queued'
            ORDER BY ${R.createdAt}, ${R.id} LIMIT 1 FOR UPDATE
          )
          AND NOT EXISTS (SELECT 1 FROM ${R} o WHERE o.${sql.identifier(R.tenantId.name)} = ${run.tenantId}
            AND o.${sql.identifier(R.jobKey.name)} = ${run.jobKey} AND o.${sql.identifier(R.dryRun.name)} = ${run.dryRun}
            AND o.${sql.identifier(R.dedupeKey.name)} = ${run.dedupeKey} AND o.${sql.identifier(R.status.name)} IN ${OPEN})`,
      );
    }
    if (isTerminal(t.to)) {
      await cascade(
        sql`${R.status} IN ('pending', 'running', 'waiting', 'paused')`,
        sql`${refOf(R.status)} = 'canceled', ${refOf(R.pauseReason)} = NULL, ${refOf(R.completedAt)} = ${now}`,
      );
      // A child ended: its parent's step, if waiting on it, is due now.
      if (run.parentRunId && run.parentStep)
        await rowsOf(
          db,
          sql`UPDATE ${S} SET ${refOf(S.wakeAt)} = ${now}
            WHERE ${S.runId} = ${run.parentRunId} AND ${S.name} = ${run.parentStep} AND ${S.status} = 'waiting'`,
        );
    } else if (t.to === 'paused')
      await cascade(
        sql`${R.status} IN ('pending', 'running', 'waiting')`,
        sql`${refOf(R.status)} = 'paused', ${refOf(R.pauseReason)} = 'parent'`,
      );
    else if (t.to === 'running' && t.from === 'paused')
      await cascade(
        sql`${R.status} = 'paused' AND ${R.pauseReason} = 'parent'`,
        sql`${refOf(R.status)} = 'running', ${refOf(R.pauseReason)} = NULL, ${refOf(R.startedAt)} = coalesce(${R.startedAt}, ${now})`,
      );
    return {
      changed: true,
      run: runOf(await this.runRow(db, runId)),
      cascaded,
    };
  }

  async reserve(claim: ChunkClaim, estimateUsd: number): Promise<Reservation> {
    const C = this.tables.chunks;
    return this.db.transaction(async (tx) => {
      const raw = await this.lockedRunRow(tx, claim.runId);
      const run = runOf(raw);
      if (run.status !== 'running') return 'refused';
      // A stale claim reserves nothing: its chunk is another claim's now, and that claim's budget is not its own.
      if (!(await this.holds(tx, claim))) return 'refused';
      const reason = budgetStop(
        run.budget,
        run.spend,
        { usd: run.reservedUsd, calls: reservedCallsOf(raw) },
        { usd: estimateUsd, calls: 1 },
        this.now(),
      );
      if (reason) {
        const { changed } = await this.transitionOn(tx, claim.runId, {
          to: 'paused',
          reason,
        });
        return changed ? 'paused' : 'refused';
      }
      await rowsOf(
        tx,
        sql`UPDATE ${C} SET ${refOf(C.reservedUsd)} = ${C.reservedUsd} + ${estimateUsd},
            ${refOf(C.reservedCalls)} = ${C.reservedCalls} + 1, ${refOf(C.updatedAt)} = ${tsOf(this.now())}
          WHERE ${this.chunkIs(claim)}`,
      );
      return 'ok';
    });
  }

  async releaseReservation(
    claim: ChunkClaim,
    estimateUsd: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockRun(tx, claim.runId);
      // A stale claim's reservations went with its chunk's sweep: nothing of its own is left to return.
      if (!(await this.holds(tx, claim))) return;
      await this.unreserve(tx, claim, estimateUsd);
    });
  }

  /** One call's reservation returned: its estimate and its call. */
  private async unreserve(
    db: JobDatabase,
    claim: ChunkClaim,
    estimateUsd: number,
  ): Promise<void> {
    const C = this.tables.chunks;
    await rowsOf(
      db,
      sql`UPDATE ${C} SET ${refOf(C.reservedUsd)} = ${nextReserved(sql`${C.reservedUsd}`, -estimateUsd)},
          ${refOf(C.reservedCalls)} = greatest(0, ${C.reservedCalls} - 1), ${refOf(C.updatedAt)} = ${tsOf(this.now())}
        WHERE ${this.chunkIs(claim)}`,
    );
  }

  /** The claimed chunk's row, by its key. */
  private chunkIs(claim: Pick<ChunkClaim, 'runId' | 'step' | 'index'>): SQL {
    const C = this.tables.chunks;
    return sql`${C.runId} = ${claim.runId} AND ${C.step} = ${claim.step} AND ${C.chunkIndex} = ${claim.index}`;
  }

  async progress(runId: string): Promise<RunProgress> {
    const C = this.tables.chunks;
    const run = await this.getRun(runId);
    const steps = await this.stepStates(runId);
    const chunks = zeroChunkCounts();
    for (const raw of await rowsOf(
      this.db,
      sql`SELECT ${C.status} AS "status", count(*)::int AS "n" FROM ${C}
        WHERE ${C.runId} = ${runId} GROUP BY ${C.status}`,
    )) {
      const { status, n } = statusCountOf(raw);
      chunks[status] = n;
    }
    return { run, steps, chunks };
  }

  // ── steps ─────────────────────────────────────────────────────────────────

  async stepStates(runId: string): Promise<StepState[]> {
    const S = this.tables.steps;
    const C = this.tables.chunks;
    await this.runRow(this.db, runId);
    const byStep = new Map<string, Record<ChunkStatus, number>>();
    for (const raw of await rowsOf(
      this.db,
      sql`SELECT ${C.step} AS "step", ${C.status} AS "status", count(*)::int AS "n" FROM ${C}
        WHERE ${C.runId} = ${runId} GROUP BY ${C.step}, ${C.status}`,
    )) {
      const { step, status, n } = statusCountOf(raw);
      const counts = byStep.get(step ?? '') ?? zeroChunkCounts();
      counts[status] = n;
      byStep.set(step ?? '', counts);
    }
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(S)} FROM ${S} WHERE ${S.runId} = ${runId} ORDER BY ${S.stepIndex}`,
    );
    return rows.map((raw) => {
      const state = stepOf(raw);
      return { ...state, chunks: byStep.get(state.name) ?? zeroChunkCounts() };
    });
  }

  async startStep(
    runId: string,
    step: { name: string; index: number; kind: 'step' | 'map' },
    expect: { attempts: number },
  ): Promise<StepState | null> {
    const S = this.tables.steps;
    const R = this.tables.runs;
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const now = tsOf(this.now());
    // The CAS: only a step at the expected attempts, not ended. A first start (0) may insert its row.
    const cas = sql`${S.attempts} = ${expect.attempts} AND ${S.status} NOT IN ('completed', 'skipped', 'failed')`;
    const restart = sql`${refOf(S.status)} = 'running', ${refOf(S.attempts)} = ${S.attempts} + 1,
          ${refOf(S.errorType)} = NULL, ${refOf(S.errorMessage)} = NULL, ${refOf(S.updatedAt)} = ${now}`;
    const [row] = await rowsOf(
      this.db,
      expect.attempts === 0
        ? sql`INSERT INTO ${S} (${refOf(S.runId)}, ${refOf(S.tenantId)}, ${refOf(S.name)}, ${refOf(S.stepIndex)},
          ${refOf(S.kind)}, ${refOf(S.status)}, ${refOf(S.attempts)}, ${refOf(S.startedAt)}, ${refOf(S.updatedAt)})
        SELECT ${R.id}, ${R.tenantId}, ${step.name}, ${step.index}, ${step.kind}, 'running', 1, ${now}, ${now}
          FROM ${R} WHERE ${R.id} = ${runId}
        ON CONFLICT (${refOf(S.runId)}, ${refOf(S.name)}) DO UPDATE SET ${restart} WHERE ${cas}
        RETURNING ${selectOf(S)}`
        : sql`UPDATE ${S} SET ${restart} WHERE ${S.runId} = ${runId} AND ${S.name} = ${step.name} AND ${cas}
        RETURNING ${selectOf(S)}`,
    );
    if (!row) {
      await this.runRow(this.db, runId);
      return null;
    }
    return this.withChunks(stepOf(row));
  }

  private async withChunks(state: StepState): Promise<StepState> {
    const C = this.tables.chunks;
    const chunks = zeroChunkCounts();
    for (const raw of await rowsOf(
      this.db,
      sql`SELECT ${C.status} AS "status", count(*)::int AS "n" FROM ${C}
        WHERE ${C.runId} = ${state.runId} AND ${C.step} = ${state.name} GROUP BY ${C.status}`,
    )) {
      const { status, n } = statusCountOf(raw);
      chunks[status] = n;
    }
    return { ...state, chunks };
  }

  private async updateStep(
    runId: string,
    name: string,
    set: SQL[],
    db: JobDatabase = this.db,
  ): Promise<void> {
    const S = this.tables.steps;
    const rows = await rowsOf(
      db,
      sql`UPDATE ${S} SET ${sql.join([...set, sql`${refOf(S.updatedAt)} = ${tsOf(this.now())}`], sql`, `)}
        WHERE ${S.runId} = ${runId} AND ${S.name} = ${name} RETURNING 1 AS "one"`,
    );
    if (!rows.length)
      throw new Error(`no step ${name} started on run ${runId}`);
  }

  async recordStep(
    runId: string,
    name: string,
    record: {
      status: 'completed' | 'skipped';
      output?: unknown;
      speculation?: Speculation;
    },
  ): Promise<void> {
    const S = this.tables.steps;
    const V = this.tables.values;
    const R = this.tables.runs;
    const s = record.speculation;
    const now = tsOf(this.now());
    // The output and the step's completion commit together: a completed step always has the output it returned.
    await this.db.transaction(async (tx) => {
      if (record.output !== undefined)
        await rowsOf(
          tx,
          sql`INSERT INTO ${V} (${refOf(V.runId)}, ${refOf(V.tenantId)}, ${refOf(V.name)}, ${refOf(V.value)}, ${refOf(V.createdAt)})
            SELECT ${R.id}, ${R.tenantId}, ${name}, ${jsonOf(record.output)}, ${now} FROM ${R} WHERE ${R.id} = ${runId}
            ON CONFLICT (${refOf(V.runId)}, ${refOf(V.name)}) DO NOTHING`,
        );
      await this.updateStep(
        runId,
        name,
        [
          sql`${refOf(S.status)} = ${record.status}`,
          sql`${refOf(S.speculated)} = ${s?.speculated ?? null}`,
          sql`${refOf(S.used)} = ${s?.used ?? null}`,
          sql`${refOf(S.overshoot)} = ${s?.overshoot ?? null}`,
          sql`${refOf(S.completedAt)} = ${now}`,
        ],
        tx,
      );
    });
  }

  async failStep(runId: string, name: string, error: RunError): Promise<void> {
    const S = this.tables.steps;
    await this.updateStep(runId, name, [
      sql`${refOf(S.status)} = 'failed'`,
      sql`${refOf(S.errorType)} = ${error.type.slice(0, 128)}`,
      sql`${refOf(S.errorMessage)} = ${error.message}`,
      sql`${refOf(S.completedAt)} = ${tsOf(this.now())}`,
    ]);
  }

  /** A value kept for a run, or undefined when it kept none; a run that doesn't exist is `RunNotFoundError`. */
  private async valueOf(runId: string, name: string): Promise<unknown> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const V = this.tables.values;
    const [row] = await rowsOf(
      this.db,
      sql`SELECT ${refOf(V.value, 'v')} AS "value", (v.${sql.identifier(V.runId.name)} IS NOT NULL) AS "kept"
        FROM ${R} LEFT JOIN ${V} v ON v.${sql.identifier(V.runId.name)} = ${R.id} AND v.${sql.identifier(V.name.name)} = ${name}
        WHERE ${R.id} = ${runId}`,
    );
    if (!row) throw new RunNotFoundError(runId);
    const { value, kept } = valueRowOf(row);
    return kept ? value : undefined;
  }

  async runInput(runId: string): Promise<unknown> {
    return this.valueOf(runId, INPUT);
  }

  async stepOutput(runId: string, name: string): Promise<unknown> {
    return this.valueOf(runId, name);
  }

  async park(
    runId: string,
    step: { name: string; index: number; kind: StepState['kind'] },
    wait: {
      kind: WaitKind;
      name: string;
      wakeAt: Date | null;
      returnAttempt?: boolean;
    },
  ): Promise<boolean> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const S = this.tables.steps;
    return this.db.transaction(async (tx) => {
      const run = runOf(await this.lockedRunRow(tx, runId));
      if (run.status !== 'running' && run.status !== 'waiting') return false;
      const now = tsOf(this.now());
      const wakeAt = wait.wakeAt ? tsOf(wait.wakeAt) : null;
      // A step with no row yet gets one with no attempt spent; an existing one parks only from pending, running or
      // waiting, and keeps its `wait_since` while it waits on the same thing.
      const parked = await rowsOf(
        tx,
        sql`INSERT INTO ${S} (${refOf(S.runId)}, ${refOf(S.tenantId)}, ${refOf(S.name)}, ${refOf(S.stepIndex)},
            ${refOf(S.kind)}, ${refOf(S.status)}, ${refOf(S.attempts)}, ${refOf(S.waitKind)}, ${refOf(S.waitName)},
            ${refOf(S.waitSince)}, ${refOf(S.wakeAt)}, ${refOf(S.updatedAt)})
          VALUES (${runId}, ${run.tenantId}, ${step.name}, ${step.index}, ${step.kind}, 'waiting', 0,
            ${wait.kind}, ${wait.name}, ${now}, ${wakeAt}, ${now})
          ON CONFLICT (${refOf(S.runId)}, ${refOf(S.name)}) DO UPDATE SET
            ${refOf(S.waitSince)} = CASE WHEN ${S.status} = 'waiting' AND ${S.waitKind} = excluded.${refOf(S.waitKind)}
              AND ${S.waitName} = excluded.${refOf(S.waitName)} THEN ${S.waitSince} ELSE excluded.${refOf(S.waitSince)} END,
            ${refOf(S.status)} = 'waiting', ${refOf(S.waitKind)} = excluded.${refOf(S.waitKind)},
            ${refOf(S.attempts)} = ${wait.returnAttempt ? sql`greatest(0, ${S.attempts} - 1)` : S.attempts},
            ${refOf(S.waitName)} = excluded.${refOf(S.waitName)}, ${refOf(S.wakeAt)} = excluded.${refOf(S.wakeAt)},
            ${refOf(S.updatedAt)} = excluded.${refOf(S.updatedAt)}
          WHERE ${S.status} IN ('pending', 'running', 'waiting')
          RETURNING 1 AS "one"`,
      );
      if (!parked.length) return false;
      if (run.status === 'running')
        await rowsOf(
          tx,
          sql`UPDATE ${R} SET ${refOf(R.status)} = 'waiting', ${refOf(R.updatedAt)} = ${now} WHERE ${R.id} = ${runId}`,
        );
      return true;
    });
  }

  async unpark(runId: string, name: string): Promise<boolean> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const S = this.tables.steps;
    return this.db.transaction(async (tx) => {
      await this.lockRun(tx, runId);
      const now = tsOf(this.now());
      const moved = await rowsOf(
        tx,
        sql`UPDATE ${S} SET ${refOf(S.status)} = 'running', ${refOf(S.wakeAt)} = NULL, ${refOf(S.updatedAt)} = ${now}
          WHERE ${S.runId} = ${runId} AND ${S.name} = ${name} AND ${S.status} = 'waiting' RETURNING 1 AS "one"`,
      );
      if (!moved.length) return false;
      await rowsOf(
        tx,
        sql`UPDATE ${R} SET ${refOf(R.status)} = 'running', ${refOf(R.updatedAt)} = ${now}
          WHERE ${R.id} = ${runId} AND ${R.status} = 'waiting'`,
      );
      return true;
    });
  }

  async startChildren(
    parent: { runId: string; step: string; index: number },
    children: readonly NewChild[],
  ): Promise<{ slots: Slot[]; started: Slot[] }> {
    if (!UUID.test(parent.runId)) throw new RunNotFoundError(parent.runId);
    if (children.length > MAX_CHILDREN)
      throw new JobDefinitionError(
        `${parent.step}: a step starts at most ${MAX_CHILDREN} children`,
      );
    const S = this.tables.steps;
    const I = this.tables.items;
    return this.db.transaction(async (tx) => {
      const run = runOf(await this.lockedRunRow(tx, parent.runId));
      if (run.depth + 1 > MAX_DEPTH)
        throw new JobDefinitionError(
          `${run.jobKey}/${parent.step}: runs nest at most ${MAX_DEPTH} deep`,
        );
      const now = tsOf(this.now());
      await rowsOf(
        tx,
        sql`INSERT INTO ${S} (${refOf(S.runId)}, ${refOf(S.tenantId)}, ${refOf(S.name)}, ${refOf(S.stepIndex)},
            ${refOf(S.kind)}, ${refOf(S.status)}, ${refOf(S.attempts)}, ${refOf(S.planned)}, ${refOf(S.startedAt)}, ${refOf(S.updatedAt)})
          VALUES (${run.id}, ${run.tenantId}, ${parent.step}, ${parent.index}, 'children', 'running', 1, true, ${now}, ${now})
          ON CONFLICT (${refOf(S.runId)}, ${refOf(S.name)}) DO NOTHING`,
      );
      const existing = new Set(
        (await this.slotsOn(tx, run.id, parent.step)).map((x) => x.key),
      );
      const started: string[] = [];
      let ordinal = existing.size;
      for (const child of children) {
        if (existing.has(child.key)) continue;
        existing.add(child.key);
        const childRunId = await this.insertChild(tx, run, parent.step, child);
        await rowsOf(
          tx,
          sql`INSERT INTO ${I} (${refOf(I.runId)}, ${refOf(I.tenantId)}, ${refOf(I.step)}, ${refOf(I.ordinal)},
              ${refOf(I.chunkIndex)}, ${refOf(I.itemKey)}, ${refOf(I.itemRef)}, ${refOf(I.status)}, ${refOf(I.attempts)})
            VALUES (${run.id}, ${run.tenantId}, ${parent.step}, ${ordinal++}, NULL, ${child.key}, ${childRunId}, 'pending', 1)`,
        );
        started.push(child.key);
      }
      await this.countSlots(tx, run.id, parent.step);
      const slots = await this.slotsOn(tx, run.id, parent.step);
      return {
        slots,
        started: slots.filter((x) => started.includes(x.key)),
      };
    });
  }

  /** A pending child run in a parent's slot, inheriting from it, its input kept in the same statement. */
  private async insertChild(
    tx: JobDatabase,
    parent: Run,
    step: string,
    child: NewChild,
  ): Promise<string> {
    const R = this.tables.runs;
    const V = this.tables.values;
    const now = tsOf(this.now());
    const b = child.budget;
    const insert = sql`INSERT INTO ${R} (${refOf(R.tenantId)}, ${refOf(R.jobKey)}, ${refOf(R.jobVersion)},
        ${refOf(R.trigger)}, ${refOf(R.requestedByUserId)}, ${refOf(R.dryRun)}, ${refOf(R.cacheMode)}, ${refOf(R.chunkSize)},
        ${refOf(R.maxItems)}, ${refOf(R.maxUsd)}, ${refOf(R.maxCalls)}, ${refOf(R.deadlineAt)}, ${refOf(R.parentRunId)},
        ${refOf(R.parentStep)}, ${refOf(R.childKey)}, ${refOf(R.depth)}, ${refOf(R.createdAt)}, ${refOf(R.updatedAt)})
      VALUES (${parent.tenantId}, ${child.jobKey}, ${child.jobVersion}, ${parent.trigger}, ${parent.requestedBy},
        ${parent.dryRun}, ${parent.cache}, 1000, ${b.maxItems}, ${b.maxUsd ?? null}, ${b.maxCalls ?? null},
        ${b.deadline ? tsOf(b.deadline) : sql`NULL`}, ${parent.id}, ${step}, ${child.key}, ${parent.depth + 1}, ${now}, ${now})
      RETURNING ${R.id} AS "id", ${R.tenantId} AS "tenantId"`;
    const [row] = await rowsOf(
      tx,
      child.input === undefined
        ? insert
        : sql`WITH r AS (${insert}),
            v AS (INSERT INTO ${V} (${refOf(V.runId)}, ${refOf(V.tenantId)}, ${refOf(V.name)}, ${refOf(V.value)}, ${refOf(V.createdAt)})
              SELECT r."id", r."tenantId", ${INPUT}, ${jsonOf(child.input)}, ${now} FROM r)
          SELECT * FROM r`,
    );
    return String((row as { id: unknown }).id);
  }

  /** A children step's slots, by ordinal. */
  private async slotsOn(
    db: JobDatabase,
    runId: string,
    step: string,
  ): Promise<Slot[]> {
    const I = this.tables.items;
    const rows = await rowsOf(
      db,
      sql`SELECT ${I.itemKey} AS "key", ${I.itemRef} AS "childRunId", ${I.ordinal} AS "ordinal", ${I.status} AS "status",
          ${I.attempts} AS "attempts", ${I.errorType} AS "errorType"
        FROM ${I} WHERE ${I.runId} = ${runId} AND ${I.step} = ${step} ORDER BY ${I.ordinal}`,
    );
    return rows.map((raw) => slotOf(raw));
  }

  /** A children step's counts, from its slots. */
  private async countSlots(
    db: JobDatabase,
    runId: string,
    step: string,
  ): Promise<void> {
    const S = this.tables.steps;
    const I = this.tables.items;
    const n = (status: string) =>
      sql`(SELECT count(*) FROM ${I} WHERE ${I.runId} = ${runId} AND ${I.step} = ${step} AND ${I.status} = ${status})::int`;
    await rowsOf(
      db,
      sql`UPDATE ${S} SET
          ${refOf(S.itemsTotal)} = (SELECT count(*) FROM ${I} WHERE ${I.runId} = ${runId} AND ${I.step} = ${step})::int,
          ${refOf(S.itemsDone)} = ${n('done')}, ${refOf(S.itemsFailed)} = ${n('failed')},
          ${refOf(S.itemsSkipped)} = ${n('skipped')}, ${refOf(S.updatedAt)} = ${tsOf(this.now())}
        WHERE ${S.runId} = ${runId} AND ${S.name} = ${step}`,
    );
  }

  async settleSlots(
    runId: string,
    step: string,
  ): Promise<{ slots: Slot[]; ended: Slot[] }> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const I = this.tables.items;
    return this.db.transaction(async (tx) => {
      await this.lockRun(tx, runId);
      const ended = await rowsOf(
        tx,
        sql`UPDATE ${I} i SET
            ${refOf(I.status)} = CASE WHEN c.${sql.identifier(R.status.name)} = 'completed' THEN 'done' ELSE 'failed' END,
            ${refOf(I.errorType)} = CASE c.${sql.identifier(R.status.name)} WHEN 'completed' THEN NULL WHEN 'canceled' THEN 'Canceled'
              ELSE coalesce(c.${sql.identifier(R.errorType.name)}, 'Error') END
          FROM ${R} c
          WHERE i.${sql.identifier(I.runId.name)} = ${runId} AND i.${sql.identifier(I.step.name)} = ${step}
            AND i.${sql.identifier(I.status.name)} = 'pending'
            AND c.${sql.identifier(R.id.name)} = i.${sql.identifier(I.itemRef.name)}::uuid
            AND c.${sql.identifier(R.status.name)} IN ('completed', 'failed', 'canceled')
          RETURNING i.${sql.identifier(I.itemKey.name)} AS "key"`,
      );
      if (ended.length) await this.countSlots(tx, runId, step);
      const keys = ended.map((x) => String((x as { key: unknown }).key));
      const slots = await this.slotsOn(tx, runId, step);
      return { slots, ended: slots.filter((x) => keys.includes(x.key)) };
    });
  }

  async retryChild(
    runId: string,
    step: string,
    key: string,
    child: NewChild,
  ): Promise<Slot | null> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const I = this.tables.items;
    return this.db.transaction(async (tx) => {
      const run = runOf(await this.lockedRunRow(tx, runId));
      const slot = (await this.slotsOn(tx, runId, step)).find(
        (x) => x.key === key,
      );
      if (slot?.status !== 'failed') return null;
      const childRunId = await this.insertChild(tx, run, step, child);
      await rowsOf(
        tx,
        sql`UPDATE ${I} SET ${refOf(I.itemRef)} = ${childRunId}, ${refOf(I.status)} = 'pending',
            ${refOf(I.errorType)} = NULL, ${refOf(I.attempts)} = ${I.attempts} + 1
          WHERE ${I.runId} = ${runId} AND ${I.step} = ${step} AND ${I.itemKey} = ${key}`,
      );
      await this.countSlots(tx, runId, step);
      return (
        (await this.slotsOn(tx, runId, step)).find((x) => x.key === key) ?? null
      );
    });
  }

  async skipChild(
    runId: string,
    step: string,
    key: string,
  ): Promise<Slot | null> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const I = this.tables.items;
    const S = this.tables.steps;
    return this.db.transaction(async (tx) => {
      await this.lockRun(tx, runId);
      const skipped = await rowsOf(
        tx,
        sql`UPDATE ${I} SET ${refOf(I.status)} = 'skipped'
          WHERE ${I.runId} = ${runId} AND ${I.step} = ${step} AND ${I.itemKey} = ${key} AND ${I.status} = 'failed'
          RETURNING 1 AS "one"`,
      );
      if (!skipped.length) return null;
      await this.countSlots(tx, runId, step);
      await rowsOf(
        tx,
        sql`UPDATE ${S} SET ${refOf(S.wakeAt)} = ${tsOf(this.now())}
          WHERE ${S.runId} = ${runId} AND ${S.name} = ${step} AND ${S.status} = 'waiting'`,
      );
      return (
        (await this.slotsOn(tx, runId, step)).find((x) => x.key === key) ?? null
      );
    });
  }

  async treeSpend(runId: string): Promise<Spend> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const [row] = await rowsOf(
      this.db,
      sql`WITH RECURSIVE tree AS (
          SELECT ${R.id} AS id FROM ${R} WHERE ${R.id} = ${runId}
          UNION ALL
          SELECT c.${sql.identifier(R.id.name)} FROM ${R} c JOIN tree ON c.${sql.identifier(R.parentRunId.name)} = tree.id
        )
        SELECT count(*)::int AS "n", coalesce(sum(${R.calls}), 0)::float8 AS "calls",
          coalesce(sum(${R.inputTokens}), 0)::float8 AS "inputTokens", coalesce(sum(${R.costUsd}), 0)::float8 AS "costUsd"
        FROM ${R} WHERE ${R.id} IN (SELECT id FROM tree)`,
    );
    const r = row as {
      n: number;
      calls: number;
      inputTokens: number;
      costUsd: number;
    };
    if (!r || r.n === 0) throw new RunNotFoundError(runId);
    return {
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      costUsd: Number(r.costUsd),
    };
  }

  async settleWait(
    runId: string,
    name: string,
    settle: { signal: string; output: unknown; by: string | null },
  ): Promise<boolean> {
    if (!UUID.test(runId)) throw new RunNotFoundError(runId);
    const R = this.tables.runs;
    const S = this.tables.steps;
    const V = this.tables.values;
    return this.db.transaction(async (tx) => {
      await this.lockRun(tx, runId);
      const now = tsOf(this.now());
      // The CAS: the run is open and the step is waiting for this signal. The first signal wins. An ended run leaves
      // its waiting step as it was, so the run's status is read too (under the lock, so a cancel can't land between).
      const settled = await rowsOf(
        tx,
        sql`UPDATE ${S} SET ${refOf(S.status)} = 'completed', ${refOf(S.settledByUserId)} = ${settle.by},
            ${refOf(S.wakeAt)} = NULL, ${refOf(S.completedAt)} = ${now}, ${refOf(S.updatedAt)} = ${now}
          WHERE ${S.runId} = ${runId} AND ${S.name} = ${name} AND ${S.status} = 'waiting'
            AND ${S.waitKind} = 'signal' AND ${S.waitName} = ${settle.signal}
            AND EXISTS (SELECT 1 FROM ${R} WHERE ${R.id} = ${runId} AND ${R.status} NOT IN ${TERMINAL})
          RETURNING 1 AS "one"`,
      );
      if (!settled.length) return false;
      await rowsOf(
        tx,
        sql`INSERT INTO ${V} (${refOf(V.runId)}, ${refOf(V.tenantId)}, ${refOf(V.name)}, ${refOf(V.value)}, ${refOf(V.createdAt)})
          SELECT ${R.id}, ${R.tenantId}, ${name}, ${jsonOf(settle.output)}, ${now} FROM ${R} WHERE ${R.id} = ${runId}
          ON CONFLICT (${refOf(V.runId)}, ${refOf(V.name)}) DO NOTHING`,
      );
      // A paused run stays paused: the resume carries on from the settled step.
      await rowsOf(
        tx,
        sql`UPDATE ${R} SET ${refOf(R.status)} = 'running', ${refOf(R.updatedAt)} = ${now}
          WHERE ${R.id} = ${runId} AND ${R.status} = 'waiting'`,
      );
      return true;
    });
  }

  async dueRunIds(now: Date, limit: number, after?: string): Promise<string[]> {
    const R = this.tables.runs;
    const S = this.tables.steps;
    const r = (col: Parameters<typeof refOf>[0]) => refOf(col, 'r');
    // The due steps through `job_run_steps_due_idx`, their waiting runs in the sweep's keyset order.
    const past =
      after === undefined
        ? sql``
        : sql`AND (${r(R.createdAt)}, ${r(R.id)}) > (SELECT ${R.createdAt}, ${R.id} FROM ${R} WHERE ${R.id} = ${after})`;
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${r(R.id)} AS "id" FROM ${R} r
        WHERE ${r(R.status)} = 'waiting' AND EXISTS (
          SELECT 1 FROM ${S} s WHERE ${refOf(S.runId, 's')} = ${r(R.id)} AND ${refOf(S.status, 's')} = 'waiting'
            AND ${refOf(S.wakeAt, 's')} IS NOT NULL AND ${refOf(S.wakeAt, 's')} <= ${tsOf(now)})
        ${past}
        ORDER BY ${r(R.createdAt)}, ${r(R.id)} LIMIT ${Math.max(0, Math.floor(limit))}`,
    );
    return rows.map((x) => String((x as { id: unknown }).id));
  }

  async wakeGate(tenantId: string, name: string): Promise<string[]> {
    const R = this.tables.runs;
    const S = this.tables.steps;
    // Through `job_run_steps_gate_idx`; only this tenant's steps waiting on this gate.
    const rows = await rowsOf(
      this.db,
      sql`UPDATE ${S} SET ${refOf(S.wakeAt)} = ${tsOf(this.now())}
        WHERE ${S.tenantId} = ${tenantId} AND ${S.waitName} = ${name}
          AND ${S.status} = 'waiting' AND ${S.waitKind} = 'gate'
        RETURNING ${S.runId} AS "runId"`,
    );
    const ids = [
      ...new Set(rows.map((x) => String((x as { runId: unknown }).runId))),
    ];
    if (!ids.length) return [];
    const waiting = await rowsOf(
      this.db,
      sql`SELECT ${R.id} AS "id" FROM ${R} WHERE ${R.id} IN ${listOf(ids)} AND ${R.status} = 'waiting'
        ORDER BY ${R.createdAt}, ${R.id}`,
    );
    return waiting.map((x) => String((x as { id: unknown }).id));
  }

  async stopStep(runId: string, name: string, used: number): Promise<void> {
    const S = this.tables.steps;
    const I = this.tables.items;
    const C = this.tables.chunks;
    await this.db.transaction(async (tx) => {
      await this.lockRun(tx, runId);
      const now = tsOf(this.now());
      const skipped = await rowsOf(
        tx,
        sql`UPDATE ${I} SET ${refOf(I.status)} = 'skipped'
          WHERE ${I.runId} = ${runId} AND ${I.step} = ${name} AND ${I.ordinal} >= ${used} AND ${I.status} = 'pending'
          RETURNING 1 AS "one"`,
      );
      const rows = await rowsOf(
        tx,
        sql`UPDATE ${S} SET ${refOf(S.itemsSkipped)} = ${S.itemsSkipped} + ${skipped.length}, ${refOf(S.planned)} = true,
            ${refOf(S.updatedAt)} = ${now}
          WHERE ${S.runId} = ${runId} AND ${S.name} = ${name} RETURNING 1 AS "one"`,
      );
      if (!rows.length)
        throw new Error(`no step ${name} started on run ${runId}`);
      await rowsOf(
        tx,
        sql`UPDATE ${C} SET ${refOf(C.status)} = 'canceled', ${sql.join(this.unleased(), sql`, `)},
            ${refOf(C.updatedAt)} = ${now}
          WHERE ${C.runId} = ${runId} AND ${C.step} = ${name} AND ${C.status} IN ('pending', 'running')`,
      );
    });
  }

  // ── items ─────────────────────────────────────────────────────────────────

  async planItems(
    runId: string,
    step: string,
    page: { refs: ItemRef[]; keys: string[]; next: string | null },
  ): Promise<void> {
    if (page.refs.length !== page.keys.length)
      throw new Error('a page needs one key per ref');
    const S = this.tables.steps;
    const I = this.tables.items;
    const C = this.tables.chunks;
    await this.db.transaction(async (tx) => {
      // The run row first, as every writer of its items and chunks takes it; then the step lock serializes planning.
      const run = runOf(await this.lockedRunRow(tx, runId));
      const [stepRaw] = await rowsOf(
        tx,
        sql`SELECT ${selectOf(S)}, ${S.tenantId} AS "tenant" FROM ${S}
          WHERE ${S.runId} = ${runId} AND ${S.name} = ${step} FOR UPDATE`,
      );
      if (!stepRaw) throw new Error(`no step ${step} started on run ${runId}`);
      const state = stepOf(stepRaw);
      const tenantId = String((stepRaw as { tenant: unknown }).tenant);
      if (
        state.planned ||
        !['pending', 'running', 'paused'].includes(run.status)
      )
        return;
      const total = state.counts.total;
      const room = Math.max(0, run.budget.maxItems - total);
      const known = new Map<string, string>();
      if (page.keys.length)
        for (const raw of await rowsOf(
          tx,
          sql`SELECT ${I.itemKey} AS "key", ${I.itemRef} AS "ref" FROM ${I}
            WHERE ${I.runId} = ${runId} AND ${I.step} = ${step} AND ${I.itemKey} IN ${listOf(page.keys)}`,
        )) {
          const r = raw as { key: unknown; ref: unknown };
          known.set(String(r.key), String(r.ref));
        }
      const picked: { key: string; ref: string }[] = [];
      const seen = new Map<string, string>();
      page.refs.forEach((ref, i) => {
        const key = page.keys[i] as string;
        // One key, two refs: an author's bug that would drop a ref from the output. Refuse it.
        const other = known.get(key) ?? seen.get(key);
        if (other !== undefined && other !== ref)
          throw new JobDefinitionError(
            `${run.jobKey}/${step}: key ${key} is shared by two items`,
          );
        if (picked.length >= room || other !== undefined) return;
        seen.set(key, ref);
        picked.push({ key, ref });
      });
      const after = total + picked.length;
      const planned = page.next === null || after >= run.budget.maxItems;
      const size = run.chunkSize;
      for (let from = 0; from < picked.length; from += INSERT_PAGE) {
        const rows = picked.slice(from, from + INSERT_PAGE).map((p, i) => {
          const ordinal = total + from + i;
          return sql`(${runId}, ${tenantId}, ${step}, ${ordinal}, ${Math.floor(ordinal / size)}, ${p.key}, ${p.ref})`;
        });
        await rowsOf(
          tx,
          sql`INSERT INTO ${I} (${refOf(I.runId)}, ${refOf(I.tenantId)}, ${refOf(I.step)}, ${refOf(I.ordinal)},
              ${refOf(I.chunkIndex)}, ${refOf(I.itemKey)}, ${refOf(I.itemRef)})
            VALUES ${sql.join(rows, sql`, `)}`,
        );
      }
      const now = tsOf(this.now());
      await rowsOf(
        tx,
        sql`UPDATE ${S} SET ${refOf(S.itemsTotal)} = ${after}, ${refOf(S.sourceCursor)} = ${page.next},
            ${refOf(S.planned)} = ${planned}, ${refOf(S.updatedAt)} = ${now}
          WHERE ${S.runId} = ${runId} AND ${S.name} = ${step}`,
      );
      // A chunk exists once enough items fill it, or once planning ends.
      const [countRaw] = await rowsOf(
        tx,
        sql`SELECT count(*)::int AS "n" FROM ${C} WHERE ${C.runId} = ${runId} AND ${C.step} = ${step}`,
      );
      const existing = Number((countRaw as { n: unknown }).n);
      const want = planned ? Math.ceil(after / size) : Math.floor(after / size);
      const chunks: SQL[] = [];
      for (let index = existing; index < want; index++)
        chunks.push(
          sql`(${runId}, ${tenantId}, ${step}, ${index}, ${now}, ${Math.min(size, after - index * size)}, ${now})`,
        );
      for (let from = 0; from < chunks.length; from += INSERT_PAGE)
        await rowsOf(
          tx,
          sql`INSERT INTO ${C} (${refOf(C.runId)}, ${refOf(C.tenantId)}, ${refOf(C.step)}, ${refOf(C.chunkIndex)},
              ${refOf(C.runAt)}, ${refOf(C.itemsTotal)}, ${refOf(C.updatedAt)})
            VALUES ${sql.join(chunks.slice(from, from + INSERT_PAGE), sql`, `)}`,
        );
    });
  }

  async items(
    runId: string,
    step: string,
    range: ItemRange = {},
  ): Promise<Item[]> {
    const I = this.tables.items;
    // A range read walks the primary key (run_id, step, ordinal).
    const limit =
      range.limit === undefined
        ? sql``
        : sql` LIMIT ${Math.max(0, range.limit)}`;
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(I)} FROM ${I} WHERE ${I.runId} = ${runId} AND ${I.step} = ${step}
        AND ${I.ordinal} >= ${Math.max(0, range.from ?? 0)} ORDER BY ${I.ordinal}${limit}`,
    );
    return rows.map(itemOf);
  }

  async pendingItems(claim: ChunkClaim): Promise<Item[]> {
    const I = this.tables.items;
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(I)} FROM ${I}
        WHERE ${I.runId} = ${claim.runId} AND ${I.step} = ${claim.step} AND ${I.chunkIndex} = ${claim.index}
          AND ${I.status} = 'pending'
        ORDER BY ${I.ordinal}`,
    );
    return rows.map(itemOf);
  }

  async itemResults<R>(
    scope: string,
    tenantId: string,
    keys: string[],
  ): Promise<Map<string, ItemResult<R>>> {
    const out = new Map<string, ItemResult<R>>();
    if (!keys.length) return out;
    const X = this.tables.results;
    // The keys go as one JSON parameter, so a step of any size is one bind parameter, never one per key.
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(X)} FROM ${X}
        WHERE ${X.tenantId} = ${tenantId} AND ${X.scope} = ${scope}
          AND ${X.itemKey} IN (SELECT jsonb_array_elements_text(${jsonOf(keys)}))`,
    );
    for (const raw of rows) {
      const r = itemResultRowOf(raw);
      out.set(r.itemKey, {
        tenantId: r.tenantId,
        scope: r.scope,
        key: r.itemKey,
        ref: r.itemRef,
        result: r.result as R,
        runId: r.runId,
        createdAt: r.createdAt,
      });
    }
    return out;
  }

  // ── chunks ────────────────────────────────────────────────────────────────

  /** The run layer's one-statement claim: eligible chunks of running runs, leased and spending an attempt each. */
  private async claim(
    owner: string,
    limit: number,
    ttlMs: number,
    ref?: { runId: string; step: string; index: number },
    jobKeys?: readonly string[],
  ): Promise<ChunkClaim[]> {
    if (jobKeys?.length === 0) return [];
    const C = this.tables.chunks;
    const R = this.tables.runs;
    const now = this.now();
    const at = tsOf(now);
    const expires = tsOf(new Date(now.getTime() + ttlMs));
    const c = (col: Parameters<typeof refOf>[0]) => refOf(col, 'c');
    const ch = (col: Parameters<typeof refOf>[0]) => refOf(col, 'ch');
    const rows = await rowsOf(
      this.db,
      sql`UPDATE ${C} c
        SET ${refOf(C.status)} = 'running', ${refOf(C.leaseOwner)} = ${owner}, ${refOf(C.leaseToken)} = gen_random_uuid(),
          ${refOf(C.leaseExpiresAt)} = ${expires},
          ${refOf(C.attempts)} = ${c(C.attempts)} + 1, ${refOf(C.startedAt)} = coalesce(${c(C.startedAt)}, ${at}),
          ${refOf(C.updatedAt)} = ${at}
        FROM (SELECT ${ch(C.runId)}, ${ch(C.step)}, ${ch(C.chunkIndex)}
              FROM ${C} ch JOIN ${R} r ON ${refOf(R.id, 'r')} = ${ch(C.runId)}
              WHERE ${ch(C.status)} = 'pending' AND ${ch(C.runAt)} <= ${at} AND ${refOf(R.status, 'r')} = 'running'
                ${ref ? sql`AND ${ch(C.runId)} = ${ref.runId} AND ${ch(C.step)} = ${ref.step} AND ${ch(C.chunkIndex)} = ${ref.index}` : sql``}
                ${
                  jobKeys
                    ? sql`AND ${refOf(R.jobKey, 'r')} IN (${sql.join(
                        jobKeys.map((k) => sql`${k}`),
                        sql`, `,
                      )})`
                    : sql``
                }
              ORDER BY ${ch(C.runAt)}, ${ch(C.runId)}, ${ch(C.step)}, ${ch(C.chunkIndex)}
              LIMIT ${limit}
              FOR UPDATE OF ch SKIP LOCKED) pick
        WHERE (${c(C.runId)}, ${c(C.step)}, ${c(C.chunkIndex)}) = (pick.${refOf(C.runId)}, pick.${refOf(C.step)}, pick.${refOf(C.chunkIndex)})
        RETURNING ${c(C.runId)} AS "runId", ${c(C.step)} AS "step", ${c(C.chunkIndex)} AS "chunkIndex",
          ${c(C.attempts)} AS "attempts", ${c(C.leaseToken)} AS "leaseToken", (extract(epoch from ${c(C.leaseExpiresAt)}) * 1000)::float8 AS "leaseExpiresAt",
          (extract(epoch from ${c(C.runAt)}) * 1000)::float8 AS "runAt"`,
    );
    return rows
      .map((raw) => ({
        row: claimRowOf(raw),
        runAt: Number((raw as { runAt: unknown }).runAt),
      }))
      .sort(
        (a, b) =>
          a.runAt - b.runAt ||
          a.row.runId.localeCompare(b.row.runId) ||
          a.row.step.localeCompare(b.row.step) ||
          a.row.chunkIndex - b.row.chunkIndex,
      )
      .map(({ row }) => ({
        runId: row.runId,
        step: row.step,
        index: row.chunkIndex,
        owner,
        token: row.leaseToken,
        expiresAt: row.leaseExpiresAt,
        attempts: row.attempts,
      }));
  }

  async claimChunk(
    owner: string,
    ttlMs: number,
    chunk?: { runId: string; step: string; index: number },
  ): Promise<ChunkClaim | null> {
    if (chunk && !UUID.test(chunk.runId)) return null;
    return (await this.claim(owner, 1, ttlMs, chunk))[0] ?? null;
  }

  async chunks(runId: string): Promise<Chunk[]> {
    const C = this.tables.chunks;
    const S = this.tables.steps;
    await this.runRow(this.db, runId);
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(C, 'c')} FROM ${C} c
        JOIN ${S} s ON ${refOf(S.runId, 's')} = ${refOf(C.runId, 'c')} AND ${refOf(S.name, 's')} = ${refOf(C.step, 'c')}
        WHERE ${refOf(C.runId, 'c')} = ${runId}
        ORDER BY ${refOf(S.stepIndex, 's')}, ${refOf(C.chunkIndex, 'c')}`,
    );
    return rows.map(chunkOf);
  }

  async pendingChunks(runId: string, limit: number): Promise<Chunk[]> {
    const C = this.tables.chunks;
    const S = this.tables.steps;
    await this.runRow(this.db, runId);
    const rows = await rowsOf(
      this.db,
      sql`SELECT ${selectOf(C, 'c')} FROM ${C} c
        JOIN ${S} s ON ${refOf(S.runId, 's')} = ${refOf(C.runId, 'c')} AND ${refOf(S.name, 's')} = ${refOf(C.step, 'c')}
        WHERE ${refOf(C.runId, 'c')} = ${runId} AND ${refOf(C.status, 'c')} = 'pending'
        ORDER BY ${refOf(C.runAt, 'c')}, ${refOf(S.stepIndex, 's')}, ${refOf(C.chunkIndex, 'c')}
        LIMIT ${Math.max(0, Math.floor(limit))}`,
    );
    return rows.map(chunkOf);
  }

  async claimChunks(
    owner: string,
    limit: number,
    ttlMs: number,
    jobKeys?: readonly string[],
  ): Promise<ChunkClaim[]> {
    if (limit <= 0) return [];
    return this.claim(owner, Math.floor(limit), ttlMs, undefined, jobKeys);
  }

  private tupleOf(claims: readonly ChunkClaim[]): SQL {
    return sql.join(
      claims.map(
        (l) =>
          sql`(${l.runId}::uuid, ${l.step}::varchar, ${l.index}::int, ${l.token}::uuid)`,
      ),
      sql`, `,
    );
  }

  async renewClaim(
    owner: string,
    claims: ChunkClaim[],
    ttlMs: number,
  ): Promise<RenewReport> {
    const C = this.tables.chunks;
    const R = this.tables.runs;
    const mine = claims.filter((l) => l.owner === owner);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const keptKeys = new Set<string>();
    if (mine.length) {
      const c = (col: Parameters<typeof refOf>[0]) => refOf(col, 'c');
      for (const raw of await rowsOf(
        this.db,
        sql`UPDATE ${C} c SET ${refOf(C.leaseExpiresAt)} = ${tsOf(expiresAt)}, ${refOf(C.updatedAt)} = ${tsOf(now)}
          FROM ${R} r
          WHERE ${refOf(R.id, 'r')} = ${c(C.runId)}
            AND (${c(C.runId)}, ${c(C.step)}, ${c(C.chunkIndex)}, ${c(C.leaseToken)}) IN (${this.tupleOf(mine)})
            AND ${c(C.status)} = 'running' AND ${c(C.leaseOwner)} = ${owner}
            AND ${refOf(R.status, 'r')} NOT IN ${TERMINAL}
          RETURNING ${c(C.runId)} AS "runId", ${c(C.step)} AS "step", ${c(C.chunkIndex)} AS "chunkIndex",
            ${c(C.leaseToken)} AS "token"`,
      )) {
        const r = raw as {
          runId: unknown;
          step: unknown;
          chunkIndex: unknown;
          token: unknown;
        };
        keptKeys.add(
          `${r.runId}/${r.step}#${Number(r.chunkIndex)}@${String(r.token)}`,
        );
      }
    }
    const lost: ChunkClaim[] = [];
    for (const l of claims) {
      if (
        l.owner === owner &&
        keptKeys.has(`${l.runId}/${l.step}#${l.index}@${l.token}`)
      )
        l.expiresAt = expiresAt;
      else lost.push(l);
    }
    const runs: Record<string, RunStatus> = {};
    const ids = [...new Set(claims.map((l) => l.runId))].filter((id) =>
      UUID.test(id),
    );
    if (ids.length)
      for (const raw of await rowsOf(
        this.db,
        sql`SELECT ${this.runSelect()} FROM ${R} WHERE ${R.id} IN ${listOf(ids)}`,
      )) {
        const run = runOf(raw);
        runs[run.id] = run.status;
      }
    return { lost, runs };
  }

  /**
   * Whether this claim still holds its chunk, locking the chunk row: the memory store's `holds`, owner and token.
   * The caller has locked the run row first.
   */
  private async holds(db: JobDatabase, claim: ChunkClaim): Promise<boolean> {
    const C = this.tables.chunks;
    const R = this.tables.runs;
    const c = (col: Parameters<typeof refOf>[0]) => refOf(col, 'c');
    if (!UUID.test(claim.runId) || !UUID.test(claim.token)) return false;
    const rows = await rowsOf(
      db,
      sql`SELECT ${c(C.runId)} AS "runId" FROM ${C} c JOIN ${R} r ON ${refOf(R.id, 'r')} = ${c(C.runId)}
        WHERE ${c(C.runId)} = ${claim.runId} AND ${c(C.step)} = ${claim.step} AND ${c(C.chunkIndex)} = ${claim.index}
          AND ${c(C.status)} = 'running' AND ${c(C.leaseOwner)} = ${claim.owner} AND ${c(C.leaseToken)} = ${claim.token}
          AND ${refOf(R.status, 'r')} NOT IN ${TERMINAL}
        FOR UPDATE OF c`,
    );
    return rows.length > 0;
  }

  /**
   * Overwrites the stored results of these keys with the run's own, when the run is a refresh (`cache_mode`). Called
   * only while the claim holds, after the unfenced first-write insert, so only the rows another run wrote change.
   */
  private async refreshResults(
    db: JobDatabase,
    claim: ChunkClaim,
    scope: string | undefined,
    kept: readonly { key: string; ref: string; result?: unknown }[],
  ): Promise<void> {
    const R = this.tables.runs;
    const X = this.tables.results;
    const rows = kept.map((d) => ({
      key: d.key,
      ref: d.ref,
      result: d.result,
    }));
    const scopeOf =
      scope === undefined
        ? sql`${refOf(R.jobKey, 'r')} || '/' || ${claim.step}`
        : sql`${scope}::text`;
    await rowsOf(
      db,
      sql`UPDATE ${X} SET ${sql.identifier(X.result.name)} = x.result, ${sql.identifier(X.itemRef.name)} = x.ref,
          ${sql.identifier(X.runId.name)} = ${refOf(R.id, 'r')}, ${sql.identifier(X.createdAt.name)} = ${tsOf(this.now())}
        FROM ${R} r, jsonb_to_recordset(${jsonOf(rows)}) AS x(key text, ref text, result jsonb)
        WHERE ${refOf(R.id, 'r')} = ${claim.runId} AND ${refOf(R.cacheMode, 'r')} = 'refresh'
          AND ${X.tenantId} = ${refOf(R.tenantId, 'r')} AND ${X.scope} = ${scopeOf}
          AND ${X.itemKey} = x.key AND ${X.runId} <> ${refOf(R.id, 'r')}
        RETURNING 1 AS "one"`,
    );
  }

  /** Locks the run row, then the claimed chunk row, or throws `ClaimLostError`. */
  private async fence(db: JobDatabase, claim: ChunkClaim): Promise<void> {
    if (!UUID.test(claim.runId)) throw new ClaimLostError(claim);
    await this.lockRun(db, claim.runId);
    if (!(await this.holds(db, claim))) throw new ClaimLostError(claim);
  }

  /** Marks the claimed chunk's pending items with these keys; the number that moved. */
  private async mark(
    db: JobDatabase,
    claim: ChunkClaim,
    keys: readonly string[],
    status: 'done' | 'cached' | 'failed',
    errorType: string | null,
  ): Promise<number> {
    if (!keys.length) return 0;
    const I = this.tables.items;
    const moved = await rowsOf(
      db,
      sql`UPDATE ${I} SET ${refOf(I.status)} = ${status}, ${refOf(I.errorType)} = ${errorType},
          ${refOf(I.attempts)} = ${I.attempts} + ${status === 'cached' ? 0 : 1}
        WHERE ${I.runId} = ${claim.runId} AND ${I.step} = ${claim.step} AND ${I.chunkIndex} = ${claim.index}
          AND ${I.itemKey} IN ${listOf(keys)} AND ${I.status} = 'pending'
        RETURNING 1 AS "one"`,
    );
    return moved.length;
  }

  /** Adds item counts to the claimed chunk and its step. */
  private async addCounts(
    db: JobDatabase,
    claim: ChunkClaim,
    n: { done: number; cached: number; failed: number },
  ): Promise<void> {
    const C = this.tables.chunks;
    const S = this.tables.steps;
    const now = tsOf(this.now());
    const add = (table: typeof C | typeof S): SQL[] => [
      sql`${refOf(table.itemsDone)} = ${table.itemsDone} + ${n.done}`,
      sql`${refOf(table.itemsCached)} = ${table.itemsCached} + ${n.cached}`,
      sql`${refOf(table.itemsFailed)} = ${table.itemsFailed} + ${n.failed}`,
      sql`${refOf(table.updatedAt)} = ${now}`,
    ];
    await rowsOf(
      db,
      sql`UPDATE ${C} SET ${sql.join(add(C), sql`, `)}
        WHERE ${C.runId} = ${claim.runId} AND ${C.step} = ${claim.step} AND ${C.chunkIndex} = ${claim.index}`,
    );
    if (n.done + n.cached + n.failed)
      await rowsOf(
        db,
        sql`UPDATE ${S} SET ${sql.join(add(S), sql`, `)} WHERE ${S.runId} = ${claim.runId} AND ${S.name} = ${claim.step}`,
      );
  }

  async writeResults<R>(
    claim: ChunkClaim,
    batch: {
      done?: Done<R>[];
      cached?: string[];
      failed?: Failed[];
      scope?: string;
    },
    spend: Spend,
    reservation?: { reservedUsd: number },
  ): Promise<void> {
    const Runs = this.tables.runs;
    // Results first, outside the fence: the first write per tenant, scope and key wins, so a lost claim's
    // results still land (they can't change one already there) while its counts and settle do not. A void result
    // is not kept.
    const kept = (batch.done ?? []).filter((d) => d.result !== undefined);
    if (kept.length) {
      const X = this.tables.results;
      const rows = kept.map((d) => ({
        key: d.key,
        ref: d.ref,
        result: d.result,
      }));
      await rowsOf(
        this.db,
        sql`INSERT INTO ${X} (${refOf(X.tenantId)}, ${refOf(X.scope)}, ${refOf(X.itemKey)}, ${refOf(X.itemRef)}, ${refOf(X.result)}, ${refOf(X.runId)}, ${refOf(X.createdAt)})
          SELECT ${Runs.tenantId}, ${batch.scope === undefined ? sql`${Runs.jobKey} || '/' || ${claim.step}` : sql`${batch.scope}::text`}, x.key, x.ref, x.result, ${Runs.id}, ${tsOf(this.now())}
          FROM ${Runs}, jsonb_to_recordset(${jsonOf(rows)}) AS x(key text, ref text, result jsonb)
          WHERE ${Runs.id} = ${claim.runId}
          ON CONFLICT (${refOf(X.tenantId)}, ${refOf(X.scope)}, ${refOf(X.itemKey)}) DO NOTHING`,
      );
    }
    // One transaction, run row locked first (the fence's order): the spend lands whatever the claim, then the marks,
    // counts and reservation release only while the claim holds.
    if (!UUID.test(claim.runId)) throw new ClaimLostError(claim);
    const held = await this.db.transaction(async (tx) => {
      await this.lockRun(tx, claim.runId);
      await this.spendOn(tx, claim, spend);
      if (!(await this.holds(tx, claim))) return false;
      // A refresh run's answers replace the stored ones, inside the fence: a late answer never overwrites.
      if (kept.length) await this.refreshResults(tx, claim, batch.scope, kept);
      const done = await this.mark(
        tx,
        claim,
        (batch.done ?? []).map((d) => d.key),
        'done',
        null,
      );
      const cached = await this.mark(
        tx,
        claim,
        batch.cached ?? [],
        'cached',
        null,
      );
      const byType = new Map<string, string[]>();
      for (const f of batch.failed ?? [])
        byType.set(f.errorType, [...(byType.get(f.errorType) ?? []), f.key]);
      let failed = 0;
      for (const [type, keys] of byType)
        failed += await this.mark(
          tx,
          claim,
          keys,
          'failed',
          type.slice(0, 128),
        );
      await this.addCounts(tx, claim, { done, cached, failed });
      // A call's write releases the estimate it reserved, never the actual spend.
      if (reservation) await this.unreserve(tx, claim, reservation.reservedUsd);
      return true;
    });
    if (!held) throw new ClaimLostError(claim);
  }

  async addSpend(claim: ChunkClaim, spend: Spend): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockRun(tx, claim.runId);
      await this.spendOn(tx, claim, spend);
    });
  }

  /** Adds a call's spend to its run and its chunk, unfenced. The caller holds the run row's lock. */
  private async spendOn(
    db: JobDatabase,
    claim: ChunkClaim,
    spend: Spend,
  ): Promise<void> {
    if (!spend.calls && !spend.inputTokens && !spend.costUsd) return;
    const Runs = this.tables.runs;
    const C = this.tables.chunks;
    const now = tsOf(this.now());
    await rowsOf(
      db,
      sql`UPDATE ${Runs} SET ${refOf(Runs.calls)} = ${Runs.calls} + ${spend.calls},
          ${refOf(Runs.inputTokens)} = ${Runs.inputTokens} + ${spend.inputTokens},
          ${refOf(Runs.costUsd)} = ${Runs.costUsd} + ${spend.costUsd},
          ${refOf(Runs.updatedAt)} = ${now}
        WHERE ${Runs.id} = ${claim.runId}`,
    );
    await rowsOf(
      db,
      sql`UPDATE ${C} SET ${refOf(C.calls)} = ${C.calls} + ${spend.calls},
          ${refOf(C.inputTokens)} = ${C.inputTokens} + ${spend.inputTokens},
          ${refOf(C.costUsd)} = ${C.costUsd} + ${spend.costUsd},
          ${refOf(C.updatedAt)} = ${now}
        WHERE ${this.chunkIs(claim)}`,
    );
  }

  async releaseChunk(claim: ChunkClaim, outcome: SettleOutcome): Promise<void> {
    const C = this.tables.chunks;
    const I = this.tables.items;
    await this.db.transaction(async (tx) => {
      await this.fence(tx, claim);
      const now = tsOf(this.now());
      const set: SQL[] = [
        ...this.unleased(),
        sql`${refOf(C.updatedAt)} = ${now}`,
      ];
      if (outcome.kind === 'completed')
        set.push(
          sql`${refOf(C.status)} = 'completed'`,
          sql`${refOf(C.completedAt)} = ${now}`,
        );
      else if (outcome.kind === 'yield')
        set.push(
          sql`${refOf(C.status)} = 'pending'`,
          sql`${refOf(C.attempts)} = greatest(0, ${C.attempts} - 1)`,
          sql`${refOf(C.runAt)} = ${now}`,
        );
      else if (outcome.kind === 'retry')
        set.push(
          sql`${refOf(C.status)} = 'pending'`,
          sql`${refOf(C.runAt)} = ${tsOf(outcome.at)}`,
          sql`${refOf(C.lastErrorType)} = ${outcome.error.type.slice(0, 128)}`,
          sql`${refOf(C.lastErrorMessage)} = ${outcome.error.message}`,
        );
      else
        set.push(
          sql`${refOf(C.status)} = 'failed'`,
          sql`${refOf(C.lastErrorType)} = ${outcome.error.type.slice(0, 128)}`,
          sql`${refOf(C.lastErrorMessage)} = ${outcome.error.message}`,
          sql`${refOf(C.completedAt)} = ${now}`,
        );
      await rowsOf(
        tx,
        sql`UPDATE ${C} SET ${sql.join(set, sql`, `)}
          WHERE ${C.runId} = ${claim.runId} AND ${C.step} = ${claim.step} AND ${C.chunkIndex} = ${claim.index}`,
      );
      if (outcome.kind !== 'failed') return;
      // A failed chunk fails its unsettled items.
      const moved = await rowsOf(
        tx,
        sql`UPDATE ${I} SET ${refOf(I.status)} = 'failed', ${refOf(I.errorType)} = ${outcome.error.type.slice(0, 128)}
          WHERE ${I.runId} = ${claim.runId} AND ${I.step} = ${claim.step} AND ${I.chunkIndex} = ${claim.index}
            AND ${I.status} = 'pending'
          RETURNING 1 AS "one"`,
      );
      if (moved.length)
        await this.addCounts(tx, claim, {
          done: 0,
          cached: 0,
          failed: moved.length,
        });
    });
  }

  async sweepExpired(): Promise<number> {
    const C = this.tables.chunks;
    const now = this.now();
    const rows = await rowsOf(
      this.db,
      sql`UPDATE ${C} SET ${refOf(C.status)} = 'pending', ${sql.join(this.unleased(), sql`, `)},
          ${refOf(C.runAt)} = ${tsOf(now)}, ${refOf(C.updatedAt)} = ${tsOf(now)}
        WHERE (${C.runId}, ${C.step}, ${C.chunkIndex}) IN (
          SELECT ${C.runId}, ${C.step}, ${C.chunkIndex} FROM ${C}
          WHERE ${C.status} = 'running' AND ${C.leaseExpiresAt} <= ${tsOf(now)}
          ORDER BY ${C.leaseExpiresAt} LIMIT ${SWEEP_LIMIT}
          FOR UPDATE SKIP LOCKED)
        RETURNING 1 AS "one"`,
    );
    return rows.length;
  }
}

/** The item an event names: a failed item's key, or a child's key; null for every other event. */
function itemKeyOf(event: JobEvent): string | null {
  if (event.type === 'item.failed') return event.key;
  return 'childKey' in event ? event.childKey : null;
}
