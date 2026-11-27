/**
 * LISTEN-NOTIFY-2 (0.17.2) — `app.close()` must leave ZERO surviving
 * `LISTEN %wake%` backends, against a REAL Postgres (testcontainers).
 *
 * The dogfood leak (swe-brain boot-check on 0.17.1): a Nest app that booted
 * with `listen_notify: true`, resolved providers and called `app.close()` never
 * exited — a `LISTEN` client survived close, holding an ESTABLISHED pg socket.
 *
 * Root cause: a `stop()` racing an in-flight `PgNotifyListener.connect()` — the
 * checkout resolved AFTER `releaseClient()` ran, so the resumed connect()
 * assigned the client and issued `LISTEN`, leaking it. ADR-022's jobs workers
 * were five of the six listeners then; JOBS-3 removed them (the
 * `@pattern-stack/jobs` executor polls), so the events outbox drainer is the
 * one `PgNotifyListener` left, and this falsifier keeps it honest: full Nest
 * context, real pg sockets, real LISTEN, many boot/close cycles. The
 * deterministic unit-level proof of the race seam lives in
 * `src/__tests__/runtime/subsystems/listen-notify.spec.ts`.
 *
 * Self-contained / CI-friendly: spins its own ephemeral `postgres:16` via
 * testcontainers and skips gracefully (not fails) when Docker is unavailable.
 * NOT part of `just test-unit`; run via `just test-listen-notify-leak-integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Wait } from 'testcontainers';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { DRIZZLE } from '../../runtime/constants/tokens';
import { EventsModule } from '../../runtime/subsystems/events/events.module';
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
// DDL — the events outbox. Mirrors the schema file closely enough to boot the
// events drainer end-to-end.
// ────────────────────────────────────────────────────────────────────────────

const DDL = /* sql */ `
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
}, 90_000);

afterAll(async () => {
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

// One app module wiring the events subsystem with listen_notify ON. The DRIZZLE
// provider is exposed via a @Global() module — mirrors the consumer's own
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
    ],
  })
  class AppModule {}
  return { module: AppModule } as unknown as DynamicModule;
}

const maybe = DOCKER_OK ? describe : describe.skip;

maybe('LISTEN-NOTIFY-2 — app.close() releases every wake listener', () => {
  it('boots a real Nest context (the drainer\'s LISTEN backend), then close() leaves zero', async () => {
    // Dedicated observer connection — never counted by the LISTEN query.
    const observer = new Pool({ connectionString, max: 1 });

    try {
      // Loop several boot/close cycles so the connect-vs-stop race actually
      // fires (a single run can pass by luck). Each cycle: boot → confirm
      // listeners came up → close → assert zero survive.
      for (let cycle = 0; cycle < 5; cycle++) {
        const pool = new Pool({ connectionString });
        const db = drizzle({ client: pool }) as unknown as DrizzleClient;

        const app = await NestFactory.createApplicationContext(
          makeAppModule(db),
          { logger: false },
        );

        // Healthy app: the events drainer's LISTEN backend. Allow a beat for it
        // to issue LISTEN.
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
        const db = drizzle({ client: pool }) as unknown as DrizzleClient;
        const app = await NestFactory.createApplicationContext(
          makeAppModule(db),
          { logger: false },
        );
        // NO settle delay — close() races the listeners' in-flight connect()s
        // as hard as possible.
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
