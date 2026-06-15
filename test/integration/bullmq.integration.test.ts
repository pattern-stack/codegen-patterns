/**
 * BULLMQ-VERIFY (ADR-041) — the broker round-trip the unit suites cannot reach.
 *
 * BULLMQ-1 §Verification was explicit that the behavioural claim/dispatch path
 * (`start → queue.add → BullMQJobWorker → completed/failed/retry/cancel`) had
 * NEVER run in-repo: it needs BOTH a live Redis broker AND a live Postgres
 * (`job_run`/`domain_events` are the source of truth), and this repo ships
 * `runtime/` into consumers without a `pg` dependency. This suite closes that
 * gap with testcontainers (an ephemeral `postgres:16` + `redis:7-alpine`) and
 * exercises the real backends end-to-end:
 *
 *   Jobs (BullMQ):
 *     - start → BullMQ dispatch → BullMQJobWorker → job_run.status='completed'
 *     - runAt (future) honoured as a BullMQ delay (JOBS-2)
 *     - collisionMode:'queue' serialises same-key runs (JOBS-3)
 *   Events (BullMQ):
 *     - publish → outbox insert → BullMQ wake → drain → findById + processed
 *     - materializeScheduledEvent slot-key idempotency
 *     - the BullMQ Job Scheduler fires a tick → scheduled domain event lands
 *       (SCHED-1)
 *
 * Self-contained / CI-friendly: spins its own containers and SKIPS gracefully
 * (not fails) when Docker is unavailable — mirrors the other
 * `test/integration/*.drizzle.integration.test.ts` suites. NOT part of
 * `just test-unit`; run via `just test-jobs-bullmq-integration` /
 * `just test-events-bullmq-integration` (both point here).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { GenericContainer, Wait } from 'testcontainers';

import type { DrizzleClient } from '../../runtime/types/drizzle';
import { jobRuns, jobs } from '../../runtime/subsystems/jobs/job-orchestration.schema';
import { domainEvents } from '../../runtime/subsystems/events/domain-events.schema';
import { BullMQJobOrchestrator } from '../../runtime/subsystems/jobs/job-orchestrator.bullmq-backend';
import { BullMQJobWorker } from '../../runtime/subsystems/jobs/job-worker.bullmq-backend';
import {
  resolveBullMqConfig,
  resolvePoolQueueName,
  type BullMqResolvedConfig,
} from '../../runtime/subsystems/jobs/bullmq.config';
import { BullMQEventBus } from '../../runtime/subsystems/events/event-bus.bullmq-backend';
import {
  JOB_HANDLER_REGISTRY,
  JobHandlerBase,
  type JobContext,
  type JobHandlerMeta,
  type JobUpsertEntry,
} from '../../runtime/subsystems/jobs/job-handler.base';
import type { JobPoolDef } from '../../runtime/subsystems/jobs/job-orchestrator.protocol';
import type { IJobStepService } from '../../runtime/subsystems/jobs/job-step-service.protocol';

// ────────────────────────────────────────────────────────────────────────────
// Docker probe → skip gracefully when absent.
// ────────────────────────────────────────────────────────────────────────────

async function dockerIsAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const DOCKER_OK = await dockerIsAvailable();
if (!DOCKER_OK) {
  // eslint-disable-next-line no-console
  console.warn('[bullmq integration] Docker not available — skipping broker round-trip suite.');
}

// ────────────────────────────────────────────────────────────────────────────
// DDL — jobs + events tables (mirrors the schema files).
// ────────────────────────────────────────────────────────────────────────────

const DDL = /* sql */ `
DO $$ BEGIN CREATE TYPE job_run_status AS ENUM
  ('pending','running','waiting','completed','failed','timed_out','canceled');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE job_collision_mode AS ENUM ('queue','reject','replace');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE job_replay_from AS ENUM ('scratch','last_step','last_checkpoint');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE job_parent_close_policy AS ENUM ('terminate','cancel','abandon');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE job_wait_kind AS ENUM ('signal');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE job_trigger_source AS ENUM ('manual','schedule','event','parent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS job (
  type text PRIMARY KEY, version integer NOT NULL DEFAULT 1, pool text NOT NULL,
  scope_entity_type text, retry_policy jsonb NOT NULL, timeout_ms integer,
  concurrency_key_template text, collision_mode job_collision_mode NOT NULL DEFAULT 'queue',
  dedupe_key_template text, dedupe_window_ms integer, priority_default integer NOT NULL DEFAULT 0,
  replay_from job_replay_from NOT NULL DEFAULT 'last_checkpoint',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_type text NOT NULL REFERENCES job(type),
  job_version integer NOT NULL, parent_run_id uuid REFERENCES job_run(id), root_run_id uuid NOT NULL,
  parent_close_policy job_parent_close_policy NOT NULL DEFAULT 'terminate',
  scope_entity_type text, scope_entity_id text, tenant_id text, tags jsonb NOT NULL DEFAULT '{}',
  pool text NOT NULL, priority integer NOT NULL DEFAULT 0, concurrency_key text, dedupe_key text,
  status job_run_status NOT NULL DEFAULT 'pending', input jsonb NOT NULL, output jsonb, error jsonb,
  trigger_source job_trigger_source NOT NULL, trigger_ref text, run_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, finished_at timestamptz, claimed_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  wait_kind job_wait_kind, resume_token text, wait_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_events (
  id uuid PRIMARY KEY, type text NOT NULL, aggregate_id text NOT NULL, aggregate_type text NOT NULL,
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, processed_at timestamptz,
  status text NOT NULL DEFAULT 'pending', error text, metadata jsonb, pool text, direction text,
  tier text NOT NULL DEFAULT 'domain', tenant_id text,
  CONSTRAINT domain_events_tier_routing_check CHECK
    (tier in ('domain','audit') AND ((tier = 'audit') = (pool is null and direction is null)))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_schedule_slot
  ON domain_events (type, (metadata ->> 'scheduleSlot')) WHERE metadata ->> 'scheduleSlot' IS NOT NULL;
`;

// ────────────────────────────────────────────────────────────────────────────
// Test helpers.
// ────────────────────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const POOL = 'batch';
const POOL_CONFIG: ReadonlyMap<string, JobPoolDef> = new Map([
  [POOL, { queue: POOL, concurrency: 4, reserved: false }],
]);

// Handler execution recorder — shared mutable state the tests assert against.
const executions: string[] = [];
let currentlyRunning = 0;
let maxConcurrent = 0;

class EchoHandler extends JobHandlerBase<Record<string, unknown>, { ok: true }> {
  async run(ctx: JobContext<Record<string, unknown>>): Promise<{ ok: true }> {
    executions.push(ctx.run.id);
    return { ok: true };
  }
}

class SlowSerialHandler extends JobHandlerBase<Record<string, unknown>, { ok: true }> {
  async run(_ctx: JobContext<Record<string, unknown>>): Promise<{ ok: true }> {
    currentlyRunning += 1;
    maxConcurrent = Math.max(maxConcurrent, currentlyRunning);
    await new Promise((r) => setTimeout(r, 400));
    currentlyRunning -= 1;
    return { ok: true };
  }
}

const ECHO_TYPE = 'bullmq_echo_it';
const SERIAL_TYPE = 'bullmq_serial_it';

const ECHO_META: JobHandlerMeta<Record<string, unknown>> = { pool: POOL };
const SERIAL_META: JobHandlerMeta<Record<string, unknown>> = {
  pool: POOL,
  concurrency: { key: '{{group}}', collisionMode: 'queue' },
};

// Minimal step-service stub — the test handlers never call ctx.step.
const stepStub: IJobStepService = {
  findStep: async () => null,
  recordStep: async () => undefined,
} as unknown as IJobStepService;

// Fake ModuleRef — resolves the pre-built handler instance by class.
const handlerInstances = new Map<unknown, unknown>([
  [EchoHandler, new EchoHandler()],
  [SlowSerialHandler, new SlowSerialHandler()],
]);
const fakeModuleRef = {
  get: (cls: unknown) => handlerInstances.get(cls),
} as unknown as import('@nestjs/core').ModuleRef;

// ────────────────────────────────────────────────────────────────────────────
// Containers + clients.
// ────────────────────────────────────────────────────────────────────────────

let pgContainer: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let redisContainer: import('testcontainers').StartedTestContainer;
let pool: Pool;
let db: DrizzleClient;
let resolvedConfig: BullMqResolvedConfig;
let orchestrator: BullMQJobOrchestrator;
let worker: BullMQJobWorker;

beforeAll(async () => {
  if (!DOCKER_OK) return;

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16')
      .withWaitStrategy(Wait.forHealthCheck())
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(60_000)
      .start(),
  ]);

  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as DrizzleClient;
  await pool.query(DDL);

  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  resolvedConfig = resolveBullMqConfig({ redis_url: redisUrl });

  // Register handlers (no @JobHandler decorator — deterministic registry).
  JOB_HANDLER_REGISTRY.set(ECHO_TYPE, {
    type: ECHO_TYPE,
    meta: ECHO_META as JobHandlerMeta<unknown>,
    handlerClass: EchoHandler as unknown as new (...a: unknown[]) => JobHandlerBase<unknown>,
  });
  JOB_HANDLER_REGISTRY.set(SERIAL_TYPE, {
    type: SERIAL_TYPE,
    meta: SERIAL_META as JobHandlerMeta<unknown>,
    handlerClass: SlowSerialHandler as unknown as new (...a: unknown[]) => JobHandlerBase<unknown>,
  });

  orchestrator = new BullMQJobOrchestrator(db, false, resolvedConfig.connection, resolvedConfig);

  const entries: JobUpsertEntry[] = [
    { type: ECHO_TYPE, meta: ECHO_META as JobHandlerMeta<unknown>, handlerClass: EchoHandler as never },
    { type: SERIAL_TYPE, meta: SERIAL_META as JobHandlerMeta<unknown>, handlerClass: SlowSerialHandler as never },
  ];
  await orchestrator.upsertJobRows(entries, POOL_CONFIG);

  worker = new BullMQJobWorker(
    db,
    orchestrator,
    stepStub,
    {
      pool: POOL,
      queueName: resolvePoolQueueName(POOL, resolvedConfig),
      concurrency: 4,
      connection: resolvedConfig.connection,
    },
    fakeModuleRef,
  );
  await worker.onModuleInit();
}, 120_000);

afterAll(async () => {
  JOB_HANDLER_REGISTRY.delete(ECHO_TYPE);
  JOB_HANDLER_REGISTRY.delete(SERIAL_TYPE);
  await worker?.onModuleDestroy().catch(() => undefined);
  await orchestrator?.closeConnections().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await Promise.all([
    pgContainer?.stop().catch(() => undefined),
    redisContainer?.stop().catch(() => undefined),
  ]);
});

beforeEach(() => {
  executions.length = 0;
  currentlyRunning = 0;
  maxConcurrent = 0;
});

const maybe = DOCKER_OK ? describe : describe.skip;

maybe('BullMQ jobs — broker round-trip (BULLMQ-1 gate)', () => {
  it('start → BullMQ dispatch → worker → job_run.status=completed', async () => {
    const run = await orchestrator.start(ECHO_TYPE, { n: 1 });
    expect(run.status).toBe('pending');

    const done = await waitFor(async () => {
      const [row] = await db.select({ s: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, run.id));
      return row?.s === 'completed';
    });
    expect(done).toBe(true);
    expect(executions).toContain(run.id);

    const [row] = await db.select().from(jobRuns).where(eq(jobRuns.id, run.id));
    expect(row?.output).toEqual({ ok: true });
    expect(row?.finishedAt).not.toBeNull();
  }, 20_000);

  it('runAt (future) is honoured as a BullMQ delay — not consumed immediately (JOBS-2)', async () => {
    const runAt = new Date(Date.now() + 2_000);
    const run = await orchestrator.start(ECHO_TYPE, { n: 2 }, { runAt });

    // Shortly after start it must NOT be completed (the delay holds it).
    await new Promise((r) => setTimeout(r, 600));
    const [early] = await db.select({ s: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, run.id));
    expect(early?.s).not.toBe('completed');

    // After the delay elapses it completes.
    const done = await waitFor(async () => {
      const [row] = await db.select({ s: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, run.id));
      return row?.s === 'completed';
    }, { timeoutMs: 8_000 });
    expect(done).toBe(true);
  }, 20_000);

  it('cancel before dispatch removes the BullMQ job — handler never runs', async () => {
    const run = await orchestrator.start(ECHO_TYPE, { n: 3 }, { runAt: new Date(Date.now() + 5_000) });
    await orchestrator.cancel(run.id);
    const [row] = await db.select({ s: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, run.id));
    expect(row?.s).toBe('canceled');
    // Give the (now-removed) delayed job's window time to NOT fire.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(executions).not.toContain(run.id);
  }, 20_000);

  it('collisionMode:queue serialises same-concurrency-key runs (JOBS-3)', async () => {
    // Two runs, same group → same concurrency_key → must run serially.
    const [a, b] = await Promise.all([
      orchestrator.start(SERIAL_TYPE, { group: 'g1', i: 1 }),
      orchestrator.start(SERIAL_TYPE, { group: 'g1', i: 2 }),
    ]);
    const bothDone = await waitFor(async () => {
      const rows = await db
        .select({ s: jobRuns.status })
        .from(jobRuns)
        .where(eq(jobRuns.concurrencyKey, 'g1'));
      return rows.length === 2 && rows.every((r) => r.s === 'completed');
    }, { timeoutMs: 12_000 });
    expect(bothDone).toBe(true);
    expect(a.concurrencyKey).toBe('g1');
    expect(b.concurrencyKey).toBe('g1');
    // The gate held: never two same-key handlers running at once.
    expect(maxConcurrent).toBe(1);
  }, 20_000);
});

maybe('BullMQ events — durable dispatch over the outbox', () => {
  let bus: BullMQEventBus;

  afterAll(async () => {
    await bus?.onModuleDestroy().catch(() => undefined);
  });

  it('publish → outbox insert → BullMQ wake → drain → findById + processed', async () => {
    bus = new BullMQEventBus(db, resolvedConfig.connection, { backend: 'bullmq' });
    await bus.onModuleInit();

    const id = crypto.randomUUID();
    await bus.publish({
      id,
      type: 'thing_happened',
      aggregateId: 'agg-1',
      aggregateType: 'thing',
      payload: { x: 1 },
      occurredAt: new Date(),
      metadata: { pool: 'events_change', direction: 'change', tier: 'domain' },
    });

    // findById reads the committed outbox row immediately.
    const found = await bus.findById(id);
    expect(found?.id).toBe(id);

    // The BullMQ wake drains it → processed.
    const processed = await waitFor(async () => {
      const [row] = await db.select({ s: domainEvents.status }).from(domainEvents).where(eq(domainEvents.id, id));
      return row?.s === 'processed';
    }, { timeoutMs: 8_000 });
    expect(processed).toBe(true);
  }, 20_000);

  it('materializeScheduledEvent is slot-key idempotent (created once)', async () => {
    const spec = {
      type: 'tick_event',
      slotKey: '@schedule/tick_event/0',
      slotStart: new Date(0),
      direction: 'change',
      pool: 'events_change',
    };
    const first = await bus.materializeScheduledEvent(spec);
    const second = await bus.materializeScheduledEvent(spec);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const rows = await db.select().from(domainEvents).where(eq(domainEvents.type, 'tick_event'));
    expect(rows).toHaveLength(1);
  }, 20_000);
});

maybe('BullMQ scheduler — Job Scheduler fires a tick (SCHED-1)', () => {
  let bus: BullMQEventBus;

  afterAll(async () => {
    await bus?.onModuleDestroy().catch(() => undefined);
  });

  it('a registered schedule materializes a scheduled domain event', async () => {
    // every=1s; the BullMQ Job Scheduler fires → worker calls
    // materializeScheduledEvent → a scheduled `recurring_tick` row appears.
    bus = new BullMQEventBus(db, resolvedConfig.connection, {
      backend: 'bullmq',
      eventRegistry: {
        recurring_tick: {
          schedule: { every: '1s' },
          direction: 'change',
          pool: 'events_change',
        },
      },
    });
    await bus.onModuleInit();
    await bus.onApplicationBootstrap();

    const fired = await waitFor(async () => {
      const rows = await db
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(eq(domainEvents.type, 'recurring_tick'));
      return rows.length >= 1;
    }, { timeoutMs: 12_000, intervalMs: 250 });
    expect(fired).toBe(true);
  }, 25_000);
});
