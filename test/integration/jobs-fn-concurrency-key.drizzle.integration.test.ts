/**
 * JOB-FN-KEY (0.16.2) — function-form concurrency keys serialize at the DB
 * level against a REAL Postgres (testcontainers).
 *
 * Regression coverage for the swe-brain ADR-0009 Amendment B §B3 drain: a
 * `@JobHandler` authored with `concurrency.key: (input) => …` (the typed
 * function form) was silently dropped to `null` at registration
 * (`upsertJobRows`' `typeof === 'string' ? … : null`). The persisted
 * `job.concurrency_key_template` was NULL, so `start()` wrote a NULL
 * `job_run.concurrency_key`, and the worker's queue-release gate (which keys
 * off `claimed.concurrencyKey`) never engaged — three "shared-lane"
 * inbound-sync runs raced the same message row fully concurrently.
 *
 * Pure-memory unit coverage (`job-orchestrator.unit.spec.ts` Group 2b) proves
 * the function form serializes in the memory backend. This suite proves the
 * SAME for the Drizzle backend against a real database, where the contract is
 * subtler: `start()` reads the `job` definition row out of Postgres (the
 * function can't be persisted), so it MUST re-resolve the live function from
 * the in-process `JOB_HANDLER_REGISTRY`. Two orchestrator instances over ONE
 * pool must still produce matching, non-null `concurrency_key`s and the
 * DB-level queue gate must hold the second behind the first.
 *
 * Self-contained / CI-friendly: spins its own ephemeral `postgres:16` via
 * testcontainers and skips gracefully (not fails) when Docker is unavailable —
 * mirrors `observability-list-reads.drizzle.integration.test.ts`. NOT part of
 * `just test-unit`; run via `just test-jobs-fnkey-integration`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { Wait } from 'testcontainers';

import type { DrizzleClient } from '../../runtime/types/drizzle';
import {
  jobRuns,
  jobs,
} from '../../runtime/subsystems/jobs/job-orchestration.schema';
import { DrizzleJobOrchestrator } from '../../runtime/subsystems/jobs/job-orchestrator.drizzle-backend';
import { buildClaimQuery } from '../../runtime/subsystems/jobs/job-worker';
import {
  FN_KEY_SENTINEL,
  JOB_HANDLER_REGISTRY,
  JobHandlerBase,
  type JobContext,
  type JobHandlerMeta,
  type JobUpsertEntry,
} from '../../runtime/subsystems/jobs/job-handler.base';
import type { JobPoolDef } from '../../runtime/subsystems/jobs/job-orchestrator.protocol';

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
    '[jobs-fnkey integration] Docker not available — skipping testcontainers Postgres suite.',
  );
}

// ────────────────────────────────────────────────────────────────────────────
// DDL — just the two jobs tables (no domain_events). Mirrors the schema file.
// ────────────────────────────────────────────────────────────────────────────

const JOBS_DDL = /* sql */ `
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
`;

// ────────────────────────────────────────────────────────────────────────────
// Handler with a FUNCTION concurrency key. The lane is the channel — two
// different messages (different ts) on the same channel share a lane. This is
// the swe-brain inbound-sync shape: per-channel ordering, NOT per-message.
// ────────────────────────────────────────────────────────────────────────────

const JOB_TYPE = 'inbound_sync_fnkey_it';
const POOL = 'batch';

interface InboundInput extends Record<string, unknown> {
  channel: string;
  ts: string;
}

class InboundHandler extends JobHandlerBase<InboundInput, void> {
  async run(_ctx: JobContext<InboundInput>): Promise<void> {}
}

const META: JobHandlerMeta<InboundInput> = {
  pool: POOL,
  concurrency: {
    key: (input) => `chan:${input.channel}`,
    collisionMode: 'queue',
  },
};

const POOL_CONFIG: ReadonlyMap<string, JobPoolDef> = new Map([
  [POOL, { queue: POOL, concurrency: 4, reserved: false }],
]);

// ────────────────────────────────────────────────────────────────────────────
// Container + clients.
// ────────────────────────────────────────────────────────────────────────────

let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let pool: Pool;
let db: DrizzleClient;
let orchestratorA: DrizzleJobOrchestrator;
let orchestratorB: DrizzleJobOrchestrator;

beforeAll(async () => {
  if (!DOCKER_OK) return;

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer('postgres:16')
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(60_000)
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool) as unknown as DrizzleClient;
  await pool.query(JOBS_DDL);

  // The live function key lives in the in-process registry — the Drizzle
  // backend re-resolves it there at start() (the DB only stores the sentinel).
  // Register directly (no @JobHandler decorator) for an isolated, deterministic
  // registry entry under this test's job type.
  JOB_HANDLER_REGISTRY.set(JOB_TYPE, {
    type: JOB_TYPE,
    meta: META as JobHandlerMeta<unknown>,
    handlerClass: InboundHandler as unknown as new (
      ...args: unknown[]
    ) => JobHandlerBase<unknown>,
  });

  // Two orchestrator instances over the SAME pool — single-tenant, no
  // listen/notify. They model two app processes contending on one DB.
  orchestratorA = new DrizzleJobOrchestrator(db, false);
  orchestratorB = new DrizzleJobOrchestrator(db, false);

  // Boot-time definition upsert — this is the path that previously dropped the
  // function key to null.
  const entries: JobUpsertEntry[] = [
    {
      type: JOB_TYPE,
      meta: META as JobHandlerMeta<unknown>,
      handlerClass: InboundHandler as unknown as new (...args: unknown[]) => unknown,
    },
  ];
  await orchestratorA.upsertJobRows(entries, POOL_CONFIG);
}, 90_000);

afterAll(async () => {
  JOB_HANDLER_REGISTRY.delete(JOB_TYPE);
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!DOCKER_OK) return;
  await db.delete(jobRuns);
});

const maybe = DOCKER_OK ? describe : describe.skip;

maybe('DrizzleJobOrchestrator — function concurrency key (DB-level)', () => {
  it('persists the function key as FN_KEY_SENTINEL in the job definition row', async () => {
    const [def] = await db
      .select({ template: jobs.concurrencyKeyTemplate, mode: jobs.collisionMode })
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPE));
    // The bug stored NULL here; the fix stores the sentinel (non-null), which
    // is exactly what makes start()'s collision path engage.
    expect(def.template).toBe(FN_KEY_SENTINEL);
    expect(def.mode).toBe('queue');
  });

  it('two concurrent same-lane starts both persist the SAME non-null concurrency_key', async () => {
    // Two DIFFERENT messages (different ts) on the SAME channel → one lane.
    // Pre-0.16.2 both rows got concurrency_key = NULL (fn dropped). Now the
    // live fn is re-resolved at start() against each payload.
    const [a, b] = await Promise.all([
      orchestratorA.start(JOB_TYPE, { channel: 'C1', ts: '100' }),
      orchestratorB.start(JOB_TYPE, { channel: 'C1', ts: '200' }),
    ]);

    expect(a.concurrencyKey).toBe('chan:C1');
    expect(b.concurrencyKey).toBe('chan:C1');
    expect(a.concurrencyKey).not.toBeNull();

    // Both landed in Postgres with the resolved key.
    const rows = await db
      .select({ id: jobRuns.id, key: jobRuns.concurrencyKey })
      .from(jobRuns)
      .where(eq(jobRuns.concurrencyKey, 'chan:C1'));
    expect(rows).toHaveLength(2);
  });

  it('different lanes (different channels) get different concurrency_keys', async () => {
    const [a, b] = await Promise.all([
      orchestratorA.start(JOB_TYPE, { channel: 'C1', ts: '1' }),
      orchestratorB.start(JOB_TYPE, { channel: 'C2', ts: '1' }),
    ]);
    expect(a.concurrencyKey).toBe('chan:C1');
    expect(b.concurrencyKey).toBe('chan:C2');
  });

  it('the DB-level queue-release gate holds the second same-lane run behind the first', async () => {
    // Enqueue two same-lane runs.
    const first = await orchestratorA.start(JOB_TYPE, { channel: 'C1', ts: '100' });
    const second = await orchestratorB.start(JOB_TYPE, { channel: 'C1', ts: '200' });
    expect(first.concurrencyKey).toBe('chan:C1');
    expect(second.concurrencyKey).toBe('chan:C1');

    // ── Claim #1 via the REAL claim query (FOR UPDATE SKIP LOCKED), then mark
    //    running — this is what the worker does on the first run. ────────────
    const claimRow = async () => {
      return db.transaction(async (tx) => {
        const [cand] = await buildClaimQuery(tx as unknown as DrizzleClient, POOL);
        if (!cand) return null;
        const [claimed] = await tx
          .update(jobRuns)
          .set({ status: 'running', claimedAt: new Date(), startedAt: new Date() })
          .where(eq(jobRuns.id, cand.id))
          .returning();
        return claimed ?? null;
      });
    };

    const claimedFirst = await claimRow();
    expect(claimedFirst?.status).toBe('running');

    // ── Claim #2: the second pending row is claimable by the query, but the
    //    worker's queue-release GATE defers it back to pending because another
    //    run on the same concurrency_key is already 'running'. Replicate the
    //    exact gate SQL from JobWorker.processRun (lines 497-519). ───────────
    const claimedSecond = await claimRow();
    expect(claimedSecond).not.toBeNull();

    const gateDefer = async (claimed: { id: string; concurrencyKey: string | null }) => {
      if (!claimed.concurrencyKey) return false;
      const inflight = await db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.concurrencyKey, claimed.concurrencyKey),
            eq(jobRuns.status, 'running'),
          ),
        );
      const other = inflight.find((r) => r.id !== claimed.id);
      if (other) {
        await db
          .update(jobRuns)
          .set({ status: 'pending', claimedAt: null, startedAt: null, updatedAt: new Date() })
          .where(eq(jobRuns.id, claimed.id));
        return true;
      }
      return false;
    };

    const deferred = await gateDefer(claimedSecond!);
    // The gate fired — the second run was pushed back to pending. THIS is the
    // serialization the bug defeated (with concurrency_key NULL the gate's
    // `if (claimed.concurrencyKey)` guard was falsy and both ran at once).
    expect(deferred).toBe(true);

    // Exactly one run is `running`; the other is back to `pending`.
    const running = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(jobRuns)
      .where(and(eq(jobRuns.concurrencyKey, 'chan:C1'), eq(jobRuns.status, 'running')));
    expect(running[0].c).toBe(1);

    const pending = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(jobRuns)
      .where(and(eq(jobRuns.concurrencyKey, 'chan:C1'), eq(jobRuns.status, 'pending')));
    expect(pending[0].c).toBe(1);
  });
});
