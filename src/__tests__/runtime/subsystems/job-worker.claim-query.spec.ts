/**
 * Claim-query SQL inspection (JOB-3 AC).
 *
 * Builds the claim-candidate query via the exported `buildClaimQuery` helper
 * and asserts the generated SQL contains the four invariants from ADR-022:
 *   - `FOR UPDATE SKIP LOCKED`
 *   - `ORDER BY priority DESC, run_at ASC`
 *   - `LIMIT 1`
 *   - filters on `status = 'pending'`, `pool = $`, `run_at <=`.
 *
 * No Postgres — pure Drizzle `.toSQL()` inspection.
 */
import { describe, it, expect } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { buildClaimQuery } from '../../../../runtime/subsystems/jobs/job-worker';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';

function makeDb(): DrizzleClient {
  // pg-proxy driver: pure callback shape, no real Postgres connection.
  // Query-builder `.toSQL()` works without ever firing the callback.
  return drizzle(async () => ({ rows: [] })) as unknown as DrizzleClient;
}

describe('JobWorker claim query — SQL invariants (JOB-3 AC)', () => {
  const db = makeDb();
  const sql = buildClaimQuery(db, 'default').toSQL();
  const normalised = sql.sql.toUpperCase().replace(/\s+/g, ' ');

  it('uses FOR UPDATE SKIP LOCKED', () => {
    expect(normalised).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('orders by priority DESC then run_at ASC', () => {
    expect(normalised).toMatch(/ORDER BY\s+[^,]*"PRIORITY"\s+DESC,\s+[^,]*"RUN_AT"\s+ASC/);
  });

  it('limits to a single row', () => {
    expect(normalised).toContain('LIMIT');
    // Parameter binding is positional; at least assert LIMIT is present.
    expect(sql.params).toContain(1);
  });

  it('filters by status = pending, pool, and run_at <= now', () => {
    expect(normalised).toContain('"STATUS" =');
    expect(normalised).toContain('"POOL" =');
    expect(normalised).toContain('"RUN_AT" <=');
    expect(sql.params).toContain('pending');
    expect(sql.params).toContain('default');
  });
});
