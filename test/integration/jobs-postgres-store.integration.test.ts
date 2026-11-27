/**
 * `@pattern-stack/jobs` on real Postgres (JOBS-3): `PostgresJobStore` passes `storeContract`, over the package's own
 * tables (`@pattern-stack/jobs/postgres` `jobTables`, the ones a generated app's schema re-exports), created here by
 * drizzle-kit from those Drizzle definitions, so the DDL under test is the DDL an app migrates to.
 *
 * Each case runs on empty job tables: `claimChunks` reads across tenants. Runs in CI's `test-integration` job
 * (`just test-jobs-integration`); without Docker it fails rather than skip, because a gate that can't run can't fail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Wait } from 'testcontainers';

import { jobTables, PostgresJobStore, type JobDatabase } from '@pattern-stack/jobs/postgres';
import {
  executorContract,
  fakeClock,
  type StoreHarness,
  storeContract,
} from '@pattern-stack/jobs/testing';
import { jobsDdl, TENANTS, USER } from './_jobs-postgres';

const START = new Date('2026-11-15T12:00:00Z');

let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let pool: Pool;
let db: JobDatabase;

beforeAll(async () => {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer('postgres:16')
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(60_000)
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  db = drizzle({ client: pool }) as unknown as JobDatabase;
  for (const statement of await jobsDdl()) await pool.query(statement);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const harness = (): StoreHarness => {
  const clock = fakeClock(START);
  return {
    store: new PostgresJobStore(db, jobTables, { now: () => clock.now() }),
    clock,
    tenants: [TENANTS[0], TENANTS[1]],
    user: USER,
  };
};

describe('PostgresJobStore on real Postgres', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM job_runs');
    // Item results outlive their run (the cache), so a run's delete leaves them: clear them too.
    await pool.query('DELETE FROM job_item_results');
  });

  for (const c of storeContract(harness)) it(c.name, c.run, 30_000);

  it('the tables are the package’s: one open run per (tenant, job, dry, dedupe key) is a unique index', async () => {
    const rows = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'job_runs' AND indexname = 'job_runs_one_open_per_dedupe_key'",
    );
    expect(rows.rowCount).toBe(1);
    // The tenant is text: a non-uuid tenant id is a tenant.
    await db.execute(sql`SELECT 1`);
  });
});

// JOBS-3's executor changes on Postgres: two in-process executors over one database act as two replicas (the open-run
// sweep, the advance lease, the scope hook). Real time: the store's clock is the system's.
describe('the in-process executor over PostgresJobStore', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM job_runs');
    await pool.query('DELETE FROM job_item_results');
  });

  for (const c of executorContract(() => ({
    store: new PostgresJobStore(db, jobTables),
    tenants: [TENANTS[0], TENANTS[1]],
  })))
    it(c.name, c.run, 30_000);
});
