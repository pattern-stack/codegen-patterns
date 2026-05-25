/**
 * OBS-LIST-1 — Drizzle integration test against a REAL Postgres.
 *
 * Closes the gap left open by OBS-LIST-1 (PR #384): the new combiner reads'
 * Drizzle SQL paths were only exercised against the in-memory backends. The
 * SQL that has NO memory equivalent — and so is only validated here — is:
 *
 *   1. `metadata->>'rootRunId'` JSON extraction (events `listEvents`
 *      rootRunId filter + the correlation timeline's event drain).
 *   2. Keyset-pagination WHERE expansion `(created_at, id) < (c0, id0)` →
 *      `created_at < c0 OR (created_at = c0 AND id < id0)` for BOTH
 *      `DrizzleJobRunService.listJobRuns` and `DrizzleEventBus.listEvents`.
 *
 * A typo / Drizzle-API misuse in those paths typechecks fine and passes the
 * memory unit tests but breaks at runtime. This suite catches that by running
 * the REAL `DrizzleJobRunService`, the REAL events read port
 * (`DrizzleEventBus` implementing `IEventReadPort`), and the REAL
 * `ObservabilityService` composing them — all pointed at an ephemeral
 * `postgres:16` spun up via testcontainers.
 *
 * Self-contained / CI-friendly: does NOT depend on the shared `just db-up`
 * docker-compose Postgres. Skips gracefully (not fails) when Docker is
 * unavailable, so it never breaks a Docker-less `bun test` / `just test-unit`.
 *
 * NOT part of `just test-unit` (which globs `src/__tests__/`). Run via
 * `just test-obs-integration`.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'bun:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Wait } from 'testcontainers';

import type { DrizzleClient } from '../../runtime/types/drizzle';
import {
  jobs,
  jobRuns,
} from '../../runtime/subsystems/jobs/job-orchestration.schema';
import { domainEvents } from '../../runtime/subsystems/events/domain-events.schema';
import { DrizzleJobRunService } from '../../runtime/subsystems/jobs/job-run-service.drizzle-backend';
import type { IJobOrchestrator } from '../../runtime/subsystems/jobs/job-orchestrator.protocol';
import { DrizzleEventBus } from '../../runtime/subsystems/events/event-bus.drizzle-backend';
import { ObservabilityService } from '../../runtime/subsystems/observability/observability.service';
import type {
  EventSummary,
  JobRunSummary,
} from '../../runtime/subsystems/observability/observability.protocol';
import { OBS_LIST_DDL } from './obs-list-schema.sql';

// ────────────────────────────────────────────────────────────────────────────
// Docker availability probe → skip gracefully when absent.
// ────────────────────────────────────────────────────────────────────────────

async function dockerIsAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['docker', 'info'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

const DOCKER_OK = await dockerIsAvailable();
if (!DOCKER_OK) {
  // Visible reason in the run output rather than a silent skip.
  // eslint-disable-next-line no-console
  console.warn(
    '[obs-list integration] Docker not available — skipping testcontainers Postgres suite.',
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Container + clients — created once for the whole suite.
// ────────────────────────────────────────────────────────────────────────────

// Imported lazily so a Docker-less environment never even loads
// @testcontainers/postgresql.
let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let pool: Pool;
let db: DrizzleClient;

// Real backends under test (single-tenant: JOBS_MULTI_TENANT = false).
let runService: DrizzleJobRunService;
// Same instance bound to both EVENT_BUS + EVENT_READ_PORT in production.
let eventBus: DrizzleEventBus;
let obs: ObservabilityService;
// A second run service with multi-tenancy ON, to exercise the tenant gate SQL.
let runServiceMT: DrizzleJobRunService;

/** Minimal orchestrator stub — listJobRuns/listEvents never touch it. */
const orchestratorStub = {} as IJobOrchestrator;

const JOB_TYPE = 'obs_test_job';

// Fixed instants (UTC). `tieA`/`tieB` share an instant to exercise the id
// tie-break in the keyset OR-expansion.
const T = {
  e1: new Date('2026-05-01T10:00:00.000Z'),
  e2: new Date('2026-05-01T11:00:00.000Z'),
  e3: new Date('2026-05-01T12:00:00.000Z'),
  e4: new Date('2026-05-01T13:00:00.000Z'),
  tie: new Date('2026-05-01T14:00:00.000Z'),
  e6: new Date('2026-05-01T15:00:00.000Z'),
};

// Deterministic UUIDs so the id tie-break is predictable (id desc).
const ID = {
  // runs
  r1: '00000000-0000-4000-8000-000000000001',
  r2: '00000000-0000-4000-8000-000000000002',
  r3: '00000000-0000-4000-8000-000000000003',
  r4: '00000000-0000-4000-8000-000000000004',
  // two runs sharing `tie` created_at — rTieHi sorts before rTieLo (id desc)
  rTieLo: '00000000-0000-4000-8000-0000000000a1',
  rTieHi: '00000000-0000-4000-8000-0000000000a2',
  r6: '00000000-0000-4000-8000-000000000006',
  // events
  ev1: '11111111-0000-4000-8000-000000000001',
  ev2: '11111111-0000-4000-8000-000000000002',
  ev3: '11111111-0000-4000-8000-000000000003',
  evTieLo: '11111111-0000-4000-8000-0000000000a1',
  evTieHi: '11111111-0000-4000-8000-0000000000a2',
};

const ROOT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROOT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

beforeAll(async () => {
  if (!DOCKER_OK) return;

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  // Use the Docker healthcheck (queried via the Docker API) rather than the
  // default log-message / host-port-socket wait strategy: the latter hangs
  // under the Bun test runtime (the socket probe never resolves even once the
  // container is healthy), which would silently time out `beforeAll`.
  // `postgres:16` ships a built-in healthcheck, so `forHealthCheck()` resolves
  // as soon as Postgres is accepting connections (~1-2s on a warm image).
  container = await new PostgreSqlContainer('postgres:16')
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(60_000)
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool) as unknown as DrizzleClient;

  // Apply the schema (enums + job + job_run + domain_events + CHECK).
  await pool.query(OBS_LIST_DDL);

  runService = new DrizzleJobRunService(db, orchestratorStub, false);
  runServiceMT = new DrizzleJobRunService(db, orchestratorStub, true);
  eventBus = new DrizzleEventBus(db);
  // Combiner composing the real run service + the real events read port.
  // Order matches the constructor: (jobRuns, bridge, syncRuns, cursors, events)
  obs = new ObservabilityService(
    runService,
    undefined,
    undefined,
    undefined,
    eventBus,
  );

  // ── seed ──────────────────────────────────────────────────────────────────
  await db.insert(jobs).values({
    type: JOB_TYPE,
    version: 1,
    pool: 'default',
    retryPolicy: { attempts: 1, backoff: 'fixed', baseMs: 0 },
  });

  // job_run rows. Varied created_at (incl. a tie), pool, status, tenant,
  // root_run_id. Newest-first expected order is:
  //   r6 (15:00), [rTieHi, rTieLo] (14:00 — id desc), r4 (13:00),
  //   r3 (12:00), r2 (11:00), r1 (10:00)
  const baseRun = {
    jobType: JOB_TYPE,
    jobVersion: 1,
    input: {} as Record<string, unknown>,
    triggerSource: 'manual' as const,
  };
  await db.insert(jobRuns).values([
    {
      ...baseRun,
      id: ID.r1,
      rootRunId: ROOT_A,
      pool: 'alpha',
      status: 'completed',
      tenantId: 't1',
      createdAt: T.e1,
      runAt: T.e1,
    },
    {
      ...baseRun,
      id: ID.r2,
      rootRunId: ROOT_A,
      pool: 'beta',
      status: 'failed',
      tenantId: 't2',
      createdAt: T.e2,
      runAt: T.e2,
      error: { message: 'boom', retryable: false, attempt: 1 },
    },
    {
      ...baseRun,
      id: ID.r3,
      rootRunId: ROOT_B,
      pool: 'alpha',
      status: 'running',
      tenantId: 't1',
      createdAt: T.e3,
      runAt: T.e3,
    },
    {
      ...baseRun,
      id: ID.r4,
      rootRunId: ROOT_B,
      pool: 'beta',
      status: 'pending',
      tenantId: null,
      createdAt: T.e4,
      runAt: T.e4,
    },
    {
      ...baseRun,
      id: ID.rTieLo,
      rootRunId: ROOT_A,
      pool: 'alpha',
      status: 'completed',
      tenantId: 't1',
      createdAt: T.tie,
      runAt: T.tie,
    },
    {
      ...baseRun,
      id: ID.rTieHi,
      rootRunId: ROOT_A,
      pool: 'alpha',
      status: 'completed',
      tenantId: 't1',
      createdAt: T.tie,
      runAt: T.tie,
    },
    {
      ...baseRun,
      id: ID.r6,
      rootRunId: ROOT_B,
      pool: 'alpha',
      status: 'completed',
      tenantId: 't1',
      createdAt: T.e6,
      runAt: T.e6,
    },
  ]);

  // domain_events. Some carry metadata.rootRunId (correlated), some don't.
  // All domain-tier rows must have pool+direction (CHECK constraint).
  await db.insert(domainEvents).values([
    {
      id: ID.ev1,
      type: 'thing.created',
      aggregateId: 'agg-1',
      aggregateType: 'thing',
      payload: {},
      occurredAt: T.e1,
      status: 'processed',
      processedAt: T.e1,
      pool: 'events_change',
      direction: 'change',
      tier: 'domain',
      tenantId: 't1',
      metadata: { rootRunId: ROOT_A, pool: 'events_change', direction: 'change' },
    },
    {
      id: ID.ev2,
      type: 'thing.updated',
      aggregateId: 'agg-1',
      aggregateType: 'thing',
      payload: {},
      occurredAt: T.e2,
      status: 'processed',
      processedAt: T.e2,
      pool: 'events_inbound',
      direction: 'inbound',
      tier: 'domain',
      tenantId: 't2',
      // No rootRunId — must NOT match a rootRunId filter.
      metadata: { pool: 'events_inbound', direction: 'inbound' },
    },
    {
      id: ID.ev3,
      type: 'thing.deleted',
      aggregateId: 'agg-2',
      aggregateType: 'thing',
      payload: {},
      occurredAt: T.e3,
      status: 'pending',
      pool: 'events_change',
      direction: 'change',
      tier: 'domain',
      tenantId: 't1',
      metadata: { rootRunId: ROOT_B, pool: 'events_change', direction: 'change' },
    },
    // Two events sharing the `tie` instant (id tie-break), both ROOT_A.
    {
      id: ID.evTieLo,
      type: 'thing.touched',
      aggregateId: 'agg-3',
      aggregateType: 'thing',
      payload: {},
      occurredAt: T.tie,
      status: 'processed',
      processedAt: T.tie,
      pool: 'events_change',
      direction: 'change',
      tier: 'domain',
      tenantId: 't1',
      metadata: { rootRunId: ROOT_A, pool: 'events_change', direction: 'change' },
    },
    {
      id: ID.evTieHi,
      type: 'thing.touched',
      aggregateId: 'agg-3',
      aggregateType: 'thing',
      payload: {},
      occurredAt: T.tie,
      status: 'processed',
      processedAt: T.tie,
      pool: 'events_change',
      direction: 'change',
      tier: 'domain',
      tenantId: 't1',
      metadata: { rootRunId: ROOT_A, pool: 'events_change', direction: 'change' },
    },
  ]);
}, 180_000);

afterAll(async () => {
  if (!DOCKER_OK) return;
  // Stop the bus poll timer if it ever started (we never call onModuleInit,
  // but be defensive) and tear the container down.
  await eventBus?.onModuleDestroy?.();
  await pool?.end();
  await container?.stop();
});

/**
 * Drain a keyset-paginated read fully, asserting each page is <= limit and
 * collecting the rows in page order. Returns the flattened item list.
 */
async function drainPages<TItem>(
  fetch: (cursor?: string) => Promise<{ items: TItem[]; nextCursor: string | null }>,
  limit: number,
): Promise<TItem[]> {
  const all: TItem[] = [];
  let cursor: string | undefined;
  let guard = 0;
  for (;;) {
    const page = await fetch(cursor);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    all.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    if (++guard > 100) throw new Error('pagination did not terminate');
  }
  return all;
}

const d = describe.skipIf(!DOCKER_OK);

// ════════════════════════════════════════════════════════════════════════════
// DrizzleJobRunService.listJobRuns
// ════════════════════════════════════════════════════════════════════════════

d('DrizzleJobRunService.listJobRuns (real Postgres)', () => {
  it('returns all runs newest-first with the id tie-break', async () => {
    const { items, nextCursor } = await runService.listJobRuns({ limit: 100 });
    expect(items.map((r) => r.runId)).toEqual([
      ID.r6,
      ID.rTieHi, // tie instant, higher id first (id desc)
      ID.rTieLo,
      ID.r4,
      ID.r3,
      ID.r2,
      ID.r1,
    ]);
    expect(nextCursor).toBeNull();
  });

  it('filters by poolId', async () => {
    const { items } = await runService.listJobRuns({ poolId: 'beta', limit: 100 });
    expect(items.map((r) => r.runId).sort()).toEqual([ID.r2, ID.r4].sort());
    expect(items.every((r) => r.pool === 'beta')).toBe(true);
  });

  it('filters by status', async () => {
    const { items } = await runService.listJobRuns({ status: 'failed', limit: 100 });
    expect(items.map((r) => r.runId)).toEqual([ID.r2]);
    expect(items[0]!.errorMessage).toBe('boom');
  });

  it('filters by since (lower bound inclusive on created_at)', async () => {
    const { items } = await runService.listJobRuns({ since: T.e4, limit: 100 });
    // r4 (13:00), tie pair (14:00), r6 (15:00) — created_at >= 13:00
    expect(items.map((r) => r.runId).sort()).toEqual(
      [ID.r4, ID.rTieHi, ID.rTieLo, ID.r6].sort(),
    );
  });

  it('filters by rootRunId', async () => {
    const { items } = await runService.listJobRuns({ rootRunId: ROOT_B, limit: 100 });
    expect(items.map((r) => r.runId).sort()).toEqual([ID.r3, ID.r4, ID.r6].sort());
    expect(items.every((r) => r.rootRunId === ROOT_B)).toBe(true);
  });

  it('filters by tenantId when multi-tenant is ON (= match)', async () => {
    const { items } = await runServiceMT.listJobRuns({ tenantId: 't2', limit: 100 });
    expect(items.map((r) => r.runId)).toEqual([ID.r2]);
  });

  it('filters tenant_id IS NULL when multi-tenant ON + explicit null', async () => {
    const { items } = await runServiceMT.listJobRuns({ tenantId: null, limit: 100 });
    expect(items.map((r) => r.runId)).toEqual([ID.r4]);
  });

  it('paginates via keyset with no gaps/dupes across page boundaries', async () => {
    // limit 2 over 7 rows → 4 pages (2,2,2,1). Exercises the
    // (created_at, id) < (cursor) OR-expansion, including the 14:00 tie split
    // across a page boundary.
    const items = await drainPages<JobRunSummary>(
      (cursor) => runService.listJobRuns({ limit: 2, cursor }),
      2,
    );
    const ids = items.map((r) => r.runId);
    // Exact expected DESC order across boundaries.
    expect(ids).toEqual([
      ID.r6,
      ID.rTieHi,
      ID.rTieLo,
      ID.r4,
      ID.r3,
      ID.r2,
      ID.r1,
    ]);
    // Each row exactly once.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(7);
  });

  it('keyset pagination respects a filter across pages', async () => {
    const items = await drainPages<JobRunSummary>(
      (cursor) => runService.listJobRuns({ rootRunId: ROOT_A, limit: 1, cursor }),
      1,
    );
    // ROOT_A runs newest-first: tie pair (14:00, id desc), r2 (11:00), r1 (10:00)
    expect(items.map((r) => r.runId)).toEqual([
      ID.rTieHi,
      ID.rTieLo,
      ID.r2,
      ID.r1,
    ]);
  });

  it('treats a malformed cursor as start-from-beginning (no throw)', async () => {
    const { items } = await runService.listJobRuns({
      cursor: 'not-a-real-cursor',
      limit: 100,
    });
    expect(items.length).toBe(7);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DrizzleEventBus.listEvents (IEventReadPort)
// ════════════════════════════════════════════════════════════════════════════

d('DrizzleEventBus.listEvents (real Postgres)', () => {
  it('returns all events newest-first with the id tie-break', async () => {
    const { items } = await eventBus.listEvents({ limit: 100 });
    expect(items.map((e) => e.id)).toEqual([
      ID.evTieHi, // 14:00, higher id first
      ID.evTieLo, // 14:00
      ID.ev3, // 12:00
      ID.ev2, // 11:00
      ID.ev1, // 10:00
    ]);
  });

  it('filters by metadata->>\'rootRunId\' (JSON extraction)', async () => {
    const { items } = await eventBus.listEvents({ rootRunId: ROOT_A, limit: 100 });
    // ev1, evTieLo, evTieHi carry rootRunId=ROOT_A; ev2 (no rootRunId) and
    // ev3 (ROOT_B) must be excluded.
    expect(items.map((e) => e.id).sort()).toEqual(
      [ID.ev1, ID.evTieLo, ID.evTieHi].sort(),
    );
    expect(items.every((e) => e.rootRunId === ROOT_A)).toBe(true);
  });

  it('rootRunId filter excludes events with no metadata.rootRunId', async () => {
    const { items } = await eventBus.listEvents({ rootRunId: ROOT_B, limit: 100 });
    expect(items.map((e) => e.id)).toEqual([ID.ev3]);
  });

  it('filters by poolId (first-class column)', async () => {
    const { items } = await eventBus.listEvents({ poolId: 'events_inbound', limit: 100 });
    expect(items.map((e) => e.id)).toEqual([ID.ev2]);
  });

  it('filters by direction', async () => {
    const { items } = await eventBus.listEvents({ direction: 'change', limit: 100 });
    expect(items.map((e) => e.id).sort()).toEqual(
      [ID.ev1, ID.ev3, ID.evTieLo, ID.evTieHi].sort(),
    );
  });

  it('filters by since (lower bound inclusive on occurred_at)', async () => {
    const { items } = await eventBus.listEvents({ since: T.e3, limit: 100 });
    expect(items.map((e) => e.id).sort()).toEqual(
      [ID.ev3, ID.evTieLo, ID.evTieHi].sort(),
    );
  });

  it('filters by tenantId (= match)', async () => {
    const { items } = await eventBus.listEvents({ tenantId: 't2', limit: 100 });
    expect(items.map((e) => e.id)).toEqual([ID.ev2]);
  });

  it('paginates via keyset with no gaps/dupes across page boundaries', async () => {
    const items = await drainPages<EventSummary>(
      (cursor) => eventBus.listEvents({ limit: 2, cursor }),
      2,
    );
    const ids = items.map((e) => e.id);
    expect(ids).toEqual([ID.evTieHi, ID.evTieLo, ID.ev3, ID.ev2, ID.ev1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
  });

  it('keyset pagination respects the rootRunId filter across pages', async () => {
    const items = await drainPages<EventSummary>(
      (cursor) => eventBus.listEvents({ rootRunId: ROOT_A, limit: 1, cursor }),
      1,
    );
    // ROOT_A events newest-first: tie pair (14:00, id desc), ev1 (10:00).
    expect(items.map((e) => e.id)).toEqual([ID.evTieHi, ID.evTieLo, ID.ev1]);
  });

  it('treats a malformed cursor as start-from-beginning (no throw)', async () => {
    const { items } = await eventBus.listEvents({ cursor: '%%%bogus%%%', limit: 100 });
    expect(items.length).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ObservabilityService.getCorrelationTimeline (composes both real backends)
// ════════════════════════════════════════════════════════════════════════════

d('ObservabilityService.getCorrelationTimeline (real Postgres)', () => {
  it('stitches runs + events for ROOT_A into ascending order', async () => {
    const timeline = await obs.getCorrelationTimeline(ROOT_A);

    // ROOT_A runs:   r1 (10:00), r2 (11:00), rTieLo+rTieHi (14:00)
    // ROOT_A events: ev1 (10:00), evTieLo+evTieHi (14:00)
    expect(timeline.summary.runCount).toBe(4);
    expect(timeline.summary.eventCount).toBe(3);
    expect(timeline.summary.startedAt).toEqual(T.e1);
    expect(timeline.summary.lastActivityAt).toEqual(T.tie);

    // Entries strictly ascending by `at`.
    const ats = timeline.entries.map((e) => e.at.getTime());
    for (let i = 1; i < ats.length; i += 1) {
      expect(ats[i]!).toBeGreaterThanOrEqual(ats[i - 1]!);
    }

    // At the 10:00 instant a run and an event coincide → job_run before event.
    const at10 = timeline.entries.filter((e) => e.at.getTime() === T.e1.getTime());
    expect(at10.map((e) => e.kind)).toEqual(['job_run', 'event']);

    // Total entries = runs + events.
    expect(timeline.entries.length).toBe(7);
  });

  it('correlation timeline for ROOT_B stitches the single event + its runs', async () => {
    const timeline = await obs.getCorrelationTimeline(ROOT_B);
    // ROOT_B runs: r3 (12:00), r4 (13:00), r6 (15:00). Event: ev3 (12:00).
    expect(timeline.summary.runCount).toBe(3);
    expect(timeline.summary.eventCount).toBe(1);
    expect(timeline.summary.startedAt).toEqual(T.e3);
    expect(timeline.summary.lastActivityAt).toEqual(T.e6);

    // At 12:00 run r3 and event ev3 coincide → run before event.
    const at12 = timeline.entries.filter((e) => e.at.getTime() === T.e3.getTime());
    expect(at12.map((e) => e.kind)).toEqual(['job_run', 'event']);
  });

  it('combiner listJobRuns / listEvents delegate to the real backends', async () => {
    const runs = await obs.listJobRuns({ poolId: 'beta', limit: 100 });
    expect(runs.items.map((r) => r.runId).sort()).toEqual([ID.r2, ID.r4].sort());

    const events = await obs.listEvents({ rootRunId: ROOT_B, limit: 100 });
    expect(events.items.map((e) => e.id)).toEqual([ID.ev3]);
  });

  it('empty timeline for an unknown rootRunId', async () => {
    const timeline = await obs.getCorrelationTimeline(
      'cccccccc-0000-4000-8000-000000000003',
    );
    expect(timeline.summary.runCount).toBe(0);
    expect(timeline.summary.eventCount).toBe(0);
    expect(timeline.summary.startedAt).toBeNull();
    expect(timeline.summary.lastActivityAt).toBeNull();
    expect(timeline.entries).toEqual([]);
  });
});

// A sanity check that the raw JSON path even reads back what we wrote — guards
// against a metadata column mis-type masking the rootRunId filter result.
d('schema sanity (real Postgres)', () => {
  it('domain_events.metadata round-trips the rootRunId json key', async () => {
    const rows = await db.execute(
      sql`select id, metadata->>'rootRunId' as root from domain_events where id = ${ID.ev1}`,
    );
    // node-postgres returns { rows } on .execute
    const r = (rows as unknown as { rows: Array<{ root: string }> }).rows[0];
    expect(r?.root).toBe(ROOT_A);
  });
});
