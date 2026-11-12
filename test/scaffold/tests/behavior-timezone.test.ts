/**
 * #845 (#796 follow-up) — behavior columns over a host's
 * `timestamp without time zone` columns.
 *
 * The case: an adopted host stores `created_at` / `updated_at` / `deleted_at`
 * as naive timestamps holding UTC. Codegen used to
 * declare every behavior column `withTimezone: true`, and Drizzle parses a
 * column by its DECLARED type, not the database's: a `timestamptz` column's
 * value goes through `new Date(<text>)`, and Postgres returns a naive column's
 * text with no offset, so JS reads it in the PROCESS zone. A naive declaration
 * reads it as UTC. Measured on an adopted host: DB `2026-10-22 18:33:55.99`, read
 * `2026-10-22T22:33:55.990Z` — 4 h, America/New_York on that date.
 *
 * `ledger_entry` switches both timestamp behaviors off
 * (`options: { timezone: false }`). The process runs at America/New_York, so a
 * wrong declaration cannot pass by accident; the size of the skew names its
 * cause (4 h = the process zone, EDT; 5.5 h = an Asia/Kolkata session).
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';
import { scaffoldDatabaseUrl } from '../harness-env';

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The host value from #845, as the host wrote it (naive, UTC by convention). */
const HOST_NAIVE = '2026-10-22 18:33:55.99';
const HOST_INSTANT = '2026-10-22T18:33:55.990Z';

let savedTz: string | undefined;
let utcPool: any; // pg.Pool, server-default session (UTC)
let kolkataPool: any; // pg.Pool, session TimeZone=Asia/Kolkata
let db: any; // drizzle over utcPool
let ledgerEntries: any;
let asTimestamptz: any; // the same table declared the old way: withTimezone: true
let repo: any;
let truncateAll: any;
let closeDb: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  savedTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { pgTable, uuid, timestamp } = await import('drizzle-orm/pg-core');
  const { relations } = await import('@gen/generated/relations');
  ({ ledger_entries: ledgerEntries } = await import('../schema'));
  ({ truncateAll, closeDb } = await import('./setup'));
  const { LedgerEntryRepository } = await import('@gen/modules/ledger-entries/ledger-entry.repository');
  const url = scaffoldDatabaseUrl();
  utcPool = new Pool({ connectionString: url });
  kolkataPool = new Pool({ connectionString: url, options: '-c TimeZone=Asia/Kolkata' });
  db = drizzle({ client: utcPool, relations });
  repo = new LedgerEntryRepository(db as any);
  // What codegen emitted for every behavior column before the knob — over the
  // same (naive) database column.
  asTimestamptz = pgTable('ledger_entries', {
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  });
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await utcPool.end();
  await kolkataPool.end();
  await closeDb();
  // Every scaffold file runs in one process: restore what `bun test` runs under.
  if (savedTz === undefined) process.env.TZ = 'Etc/UTC';
  else process.env.TZ = savedTz;
});

async function insertHostRow(): Promise<string> {
  const r = await utcPool.query(
    `insert into ledger_entries (memo, created_at, updated_at) values ('host', $1, $1) returning id`,
    [HOST_NAIVE],
  );
  return r.rows[0].id;
}

d('behavior columns with timezone: false over naive host columns (#845)', () => {
  test('B0: the preconditions hold — the process is not at UTC, the default session is', async () => {
    expect(new Date(HOST_INSTANT).getTimezoneOffset()).toBe(240); // EDT
    const r = await utcPool.query('SHOW TimeZone');
    expect(['UTC', 'Etc/UTC']).toContain(r.rows[0].TimeZone);
  });

  test('B1: the DDL — the three behavior columns are timestamp without time zone', async () => {
    const r = await utcPool.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'ledger_entries'
          and column_name in ('created_at', 'updated_at', 'deleted_at') order by column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp without time zone' },
      { column_name: 'deleted_at', data_type: 'timestamp without time zone' },
      { column_name: 'updated_at', data_type: 'timestamp without time zone' },
    ]);
  });

  test('B2: a host-written naive UTC value reads back exactly through the generated repository', async () => {
    const id = await insertHostRow();
    const found = await repo.findById(id);
    expect(found.createdAt.toISOString()).toBe(HOST_INSTANT);
    expect(found.updatedAt.toISOString()).toBe(HOST_INSTANT);
  });

  test('B3: declared withTimezone (the old emission), the same value is skewed by the process offset', async () => {
    const id = await insertHostRow();
    const [row] = await db.select().from(asTimestamptz);
    expect(row.id).toBe(id);
    // `new Date('2026-10-22 18:33:55.99')` in America/New_York (EDT, UTC-4).
    expect(row.createdAt.getTime() - new Date(HOST_INSTANT).getTime()).toBe(4 * HOUR);
  });

  test('B4: our writes round-trip — create and update stamp a JS Date, soft delete sets deleted_at', async () => {
    const before = Date.now();
    const created = await repo.create({ memo: 'ours' });
    const after = Date.now();
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - MINUTE);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(after + MINUTE);

    // A JS Date write is `toISOString()`; Postgres drops the `Z` into a naive
    // column, which leaves the UTC wall time — the host's convention.
    // (`repo.update` re-stamps `updatedAt`, so write the explicit instant directly.)
    const at = new Date('2026-03-08T06:30:00.000Z');
    await db.update(ledgerEntries).set({ updatedAt: at });
    const text = await utcPool.query('select updated_at::text as t from ledger_entries where id = $1', [created.id]);
    expect(text.rows[0].t).toBe('2026-03-08 06:30:00');
    const [read] = await db.select().from(ledgerEntries);
    expect(read.updatedAt.getTime()).toBe(at.getTime());

    await repo.delete(created.id);
    expect(await repo.findById(created.id)).toBeNull();
    const del = await utcPool.query('select deleted_at from ledger_entries where id = $1', [created.id]);
    expect(del.rows[0].deleted_at).not.toBeNull();
  });

  test('B5: the knob assumes UTC sessions — DEFAULT now() under a non-UTC session writes local wall time', async () => {
    // Not a codegen defect: a naive column cannot record which zone `now()`
    // was cast in. The host's convention (UTC sessions) is what makes its
    // values UTC; this pins the precondition the docs state.
    const r = await kolkataPool.query(
      `insert into ledger_entries (memo) values ('kolkata-default') returning id`,
    );
    const found = await repo.findById(r.rows[0].id);
    const skew = found.createdAt.getTime() - Date.now();
    expect(Math.abs(skew - 5.5 * HOUR)).toBeLessThan(MINUTE);
  });
});
