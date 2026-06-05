/**
 * LISTEN-NOTIFY-2 (0.17.2) — `app.close()` must leave ZERO surviving
 * `LISTEN %wake%` backends, against a REAL Postgres (testcontainers).
 *
 * The dogfood leak (swe-brain boot-check on 0.17.1): with `listen_notify: true`
 * on the drizzle jobs backend (and events), a Nest app that boots, resolves
 * providers, and calls `app.close()` never exits — at least one
 * `LISTEN codegen_jobs_wake` client survives close, holding an ESTABLISHED pg
 * socket forever. A healthy running app shows N+1 LISTEN backends (one events
 * drainer + one per jobs pool worker); after close there must be zero.
 *
 * Root cause: a `stop()` racing an in-flight `PgNotifyListener.connect()` — the
 * checkout resolved AFTER `releaseClient()` ran, so the resumed connect()
 * assigned the client and issued `LISTEN`, leaking it. With 5 jobs pools + 1
 * events drainer all starting at bootstrap and `app.close()` arriving ~at once,
 * the race fires on ~1 of 6 listeners. This falsifier reproduces the real path
 * (full Nest context, real pg sockets, real LISTEN) and asserts the leak is
 * gone. The deterministic unit-level proof of the race seam lives in
 * `src/__tests__/runtime/subsystems/listen-notify.spec.ts` §6.
 *
 * Self-contained / CI-friendly: spins its own ephemeral `postgres:16` via
 * testcontainers and skips gracefully (not fails) when Docker is unavailable —
 * mirrors `jobs-fn-concurrency-key.drizzle.integration.test.ts`. NOT part of
 * `just test-unit`; run via `just test-listen-notify-leak-integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Wait } from 'testcontainers';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { DRIZZLE } from '../../runtime/constants/tokens';
import { EventsModule } from '../../runtime/subsystems/events/events.module';
import { JobWorkerModule } from '../../runtime/subsystems/jobs/job-worker.module';
import {
  JobHandlerBase,
  JOB_HANDLER_REGISTRY,
  type JobContext,
  type JobHandlerMeta,
} from '../../runtime/subsystems/jobs/job-handler.base';
import type { DrizzleClient } from '../../runtime/types/drizzle';

// ────────────────────────────────────────────────────────────────────────────
// Docker availability probe → skip gracefully when absent.
// ────────────────────────────────────────────────────────────────────────────

async function dockerIsAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['docker', 'info'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const DOCKER_OK = await dockerIsAvailable();
if (!DOCKER_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    '[listen-notify-leak integration] Docker not available — skipping testcontainers Postgres suite.',
  );
}

// ────────────────────────────────────────────────────────────────────────────
// DDL — jobs (job + job_run) AND the events outbox. Mirrors the schema files
// closely enough to boot the worker module + events drainer end-to-end.
// ────────────────────────────────────────────────────────────────────────────

const DDL = /* sql */ `
DO $$ BEGIN
  CREATE TYPE job_run_status AS ENUM
    ('pending','running','waiting','completed','failed','timed_out','canceled');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE job_collision_mode AS ENUM ('queue','reject','replace');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE job_replay_from AS ENUM ('scratch','last_step','last_checkpoint');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE job_parent_close_policy AS ENUM ('terminate','cancel','abandon');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE job_wait_kind AS ENUM ('signal');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE job_trigger_source AS ENUM ('manual','schedule','event','parent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS job (
  type                     text PRIMARY KEY,
  version                  integer NOT NULL DEFAULT 1,
  pool                     text NOT NULL,
  scope_entity_type        text,
  retry_policy             jsonb NOT NULL,
  timeout_ms               integer,
  concurrency_key_template text,
  collision_mode           job_collision_mode NOT NULL DEFAULT 'queue',
  dedupe_key_template      text,
  dedupe_window_ms         integer,
  priority_default         integer NOT NULL DEFAULT 0,
  replay_from              job_replay_from NOT NULL DEFAULT 'last_checkpoint',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type            text NOT NULL REFERENCES job(type),
  job_version         integer NOT NULL,
  parent_run_id       uuid REFERENCES job_run(id),
  root_run_id         uuid NOT NULL,
  parent_close_policy job_parent_close_policy NOT NULL DEFAULT 'terminate',
  scope_entity_type   text,
  scope_entity_id     text,
  tenant_id           text,
  tags                jsonb NOT NULL DEFAULT '{}',
  pool                text NOT NULL,
  priority            integer NOT NULL DEFAULT 0,
  concurrency_key     text,
  dedupe_key          text,
  status              job_run_status NOT NULL DEFAULT 'pending',
  input               jsonb NOT NULL,
  output              jsonb,
  error               jsonb,
  trigger_source      job_trigger_source NOT NULL,
  trigger_ref         text,
  run_at              timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  claimed_at          timestamptz,
  attempts            integer NOT NULL DEFAULT 0,
  wait_kind           job_wait_kind,
  resume_token        text,
  wait_deadline       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_events (
  id            uuid PRIMARY KEY,
  type          text NOT NULL,
  aggregate_id  text NOT NULL,
  aggregate_type text NOT NULL,
  payload       jsonb NOT NULL,
  occurred_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  status        text NOT NULL DEFAULT 'pending',
  error         text,
  metadata      jsonb,
  pool          text,
  direction     text,
  tier          text NOT NULL DEFAULT 'domain',
  tenant_id     text,
  CONSTRAINT domain_events_tier_routing_check
    CHECK (tier in ('domain','audit')
      AND ((tier = 'audit') = (pool is null and direction is null)))
);
`;

// A trivial handler so the worker module's boot validator + spawn proceed.
const JOB_TYPE = 'listen_notify_leak_noop';
class NoopHandler extends JobHandlerBase<Record<string, unknown>, void> {
  async run(_ctx: JobContext<Record<string, unknown>>): Promise<void> {}
}
const META: JobHandlerMeta<Record<string, unknown>> = { pool: 'batch' };

// ────────────────────────────────────────────────────────────────────────────
// Container + connection string.
// ────────────────────────────────────────────────────────────────────────────

let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  if (!DOCKER_OK) return;
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer('postgres:16')
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(60_000)
    .start();
  connectionString = container.getConnectionUri();

  const ddlPool = new Pool({ connectionString });
  await ddlPool.query(DDL);
  await ddlPool.end();

  // Register the noop handler once for all boots in this suite.
  JOB_HANDLER_REGISTRY.set(JOB_TYPE, {
    type: JOB_TYPE,
    meta: META as JobHandlerMeta<unknown>,
    handlerClass: NoopHandler as unknown as new (
      ...args: unknown[]
    ) => JobHandlerBase<unknown>,
  });
}, 90_000);

afterAll(async () => {
  JOB_HANDLER_REGISTRY.delete(JOB_TYPE);
  await container?.stop();
});

// ────────────────────────────────────────────────────────────────────────────
// Count surviving LISTEN %wake% backends via a SEPARATE pg connection (so the
// observer itself is never counted). Polls briefly to allow async teardown.
// ────────────────────────────────────────────────────────────────────────────

async function countWakeListeners(observer: Pool): Promise<number> {
  const { rows } = await observer.query<{ c: string }>(
    `SELECT count(*)::text AS c
       FROM pg_stat_activity
      WHERE query ILIKE 'LISTEN %wake%'
        AND state = 'idle'`,
  );
  return Number(rows[0]?.c ?? '0');
}

async function pollUntilZeroWakeListeners(
  observer: Pool,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = await countWakeListeners(observer);
  while (last > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await countWakeListeners(observer);
  }
  return last;
}

// One app module wiring both subsystems with listen_notify ON. The DRIZZLE
// provider is exposed via a @Global() module so the (global) EventsModule and
// JobsDomainModule contexts can both inject it — mirrors the consumer's own
// global DatabaseModule.
function makeAppModule(db: DrizzleClient): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: DRIZZLE, useValue: db }],
    exports: [DRIZZLE],
  })
  class DatabaseModule {}

  @Module({
    imports: [
      DatabaseModule,
      EventsModule.forRoot({ backend: 'drizzle', listenNotify: true }),
      JobWorkerModule.forRoot({
        backend: 'drizzle',
        mode: 'embedded',
        allPools: true, // → one worker (one listener) per framework pool
        domainModuleExtensions: { drizzle: { listenNotify: true } },
      }),
    ],
  })
  class AppModule {}
  return { module: AppModule } as unknown as DynamicModule;
}

const maybe = DOCKER_OK ? describe : describe.skip;

maybe('LISTEN-NOTIFY-2 — app.close() releases every wake listener', () => {
  it('boots a real Nest context (6 LISTEN backends), then close() leaves zero', async () => {
    // Dedicated observer connection — never counted by the LISTEN query.
    const observer = new Pool({ connectionString, max: 1 });

    try {
      // Loop several boot/close cycles so the connect-vs-stop race actually
      // fires (a single run can pass by luck). Each cycle: boot → confirm
      // listeners came up → close → assert zero survive.
      for (let cycle = 0; cycle < 5; cycle++) {
        const pool = new Pool({ connectionString });
        const db = drizzle(pool) as unknown as DrizzleClient;

        const app = await NestFactory.createApplicationContext(
          makeAppModule(db),
          { logger: false },
        );

        // Healthy app: events drainer (1) + one worker per framework pool (5)
        // = 6 LISTEN backends. Allow a beat for the listeners to issue LISTEN.
        await new Promise((r) => setTimeout(r, 250));
        const live = await countWakeListeners(observer);
        expect(live).toBeGreaterThan(0);

        // The race window: close arrives while listeners may still be
        // mid-connect. This is the exact swe-brain boot-check shape.
        await app.close();
        await pool.end();

        const survivors = await pollUntilZeroWakeListeners(observer);
        expect(survivors).toBe(0);
      }
    } finally {
      await observer.end();
    }
  }, 120_000);

  it('survives an immediate close() with no settle delay (tight race)', async () => {
    const observer = new Pool({ connectionString, max: 1 });
    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        const pool = new Pool({ connectionString });
        const db = drizzle(pool) as unknown as DrizzleClient;
        const app = await NestFactory.createApplicationContext(
          makeAppModule(db),
          { logger: false },
        );
        // NO settle delay — close() races the listeners' in-flight connect()s
        // as hard as possible. This is what made ~1 of 6 leak pre-fix.
        await app.close();
        await pool.end();
        const survivors = await pollUntilZeroWakeListeners(observer);
        expect(survivors).toBe(0);
      }
    } finally {
      await observer.end();
    }
  }, 120_000);
});
