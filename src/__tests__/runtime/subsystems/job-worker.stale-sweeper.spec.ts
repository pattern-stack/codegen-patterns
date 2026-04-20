/**
 * Stale-claim sweep SQL inspection (JOB-3 OQ-2 resolution).
 *
 * Per-worker sweeper is safe because the candidate select uses
 * `FOR UPDATE SKIP LOCKED`, so simultaneously-firing sweepers never
 * collide on the same row. This test pins that invariant at the SQL
 * level.
 */
import { describe, it, expect } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { buildStaleSweepQuery } from '../../../../runtime/subsystems/jobs/job-worker';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';

function makeDb(): DrizzleClient {
  return drizzle(async () => ({ rows: [] })) as unknown as DrizzleClient;
}

describe('JobWorker stale-claim sweeper — SQL invariants', () => {
  const db = makeDb();
  const sql = buildStaleSweepQuery(db, 5 * 60_000).toSQL();
  const normalised = sql.sql.toUpperCase().replace(/\s+/g, ' ');

  it('uses FOR UPDATE SKIP LOCKED to tolerate multi-worker races', () => {
    expect(normalised).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('filters status = running and claimed_at < threshold', () => {
    expect(normalised).toContain('"STATUS" =');
    expect(sql.params).toContain('running');
    expect(normalised).toContain('"CLAIMED_AT" <');
  });
});
