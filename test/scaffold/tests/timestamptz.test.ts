/**
 * #796 — every generated time column is `timestamp with time zone`; a
 * `timezone: false` field is the one wall-clock exception.
 *
 * A Drizzle-only JS round trip passes on a naive `timestamp` column too
 * (Drizzle writes `toISOString()` and reads a naive value back as `+0000`), so
 * it proves nothing here. The failures that matter come from the DATABASE's own
 * `DEFAULT now()` under a non-UTC session and from readers that are not Drizzle.
 * So the process runs at America/New_York and the database session at
 * Asia/Kolkata (+05:30, no DST): the two zones can never cancel out, and the
 * size of a failure names its cause (4-5 h is the process zone, 5.5 h the
 * session zone).
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';
import { scaffoldDatabaseUrl } from '../harness-env';

const MINUTE = 60_000;

let savedTz: string | undefined;
let nonUtc: any; // pg.Pool, session TimeZone=Asia/Kolkata
let raw: any; // pg.Pool, default node-postgres type parsers
let db: any; // drizzle over nonUtc
let appointments: any;
let repo: any;
let truncateAll: any;
let closeDb: any;
let sql: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  savedTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  ({ sql } = await import('drizzle-orm'));
  const { relations } = await import('@gen/generated/relations');
  ({ appointments } = await import('../schema'));
  ({ truncateAll, closeDb } = await import('./setup'));
  const { AppointmentRepository } = await import('@gen/modules/appointments/appointment.repository');
  const url = scaffoldDatabaseUrl();
  nonUtc = new Pool({ connectionString: url, options: '-c TimeZone=Asia/Kolkata' });
  raw = new Pool({ connectionString: url });
  db = drizzle({ client: nonUtc, relations });
  repo = new AppointmentRepository(db as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await nonUtc.end();
  await raw.end();
  await closeDb();
  // Every scaffold file runs in one process: restore what `bun test` runs under.
  if (savedTz === undefined) process.env.TZ = 'Etc/UTC';
  else process.env.TZ = savedTz;
});

d('timestamptz columns under a non-UTC process and session (#796)', () => {
  test('T0: the preconditions hold, so T2-T4 cannot pass under UTC by accident', async () => {
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).not.toBe(0);
    const r = await nonUtc.query('SHOW TimeZone');
    expect(r.rows[0].TimeZone).toBe('Asia/Kolkata');
  });

  test('T1: the DDL — only the declared opt-outs are without time zone', async () => {
    const naive = await raw.query(
      `select table_name || '.' || column_name as col from information_schema.columns
        where table_schema = 'public' and data_type = 'timestamp without time zone'`,
    );
    // The declared opt-outs: appointment's `timezone: false` field, and
    // ledger_entry's timestamp behaviors switched off (#845,
    // tests/behavior-timezone.test.ts).
    expect(naive.rows.map((r: any) => r.col).sort()).toEqual([
      'appointments.opens_at',
      'ledger_entries.created_at',
      'ledger_entries.deleted_at',
      'ledger_entries.updated_at',
    ]);

    const tz = await raw.query(
      `select table_name || '.' || column_name as col from information_schema.columns
        where table_schema = 'public' and data_type = 'timestamp with time zone'`,
    );
    const have = new Set(tz.rows.map((r: any) => r.col));
    for (const col of [
      'appointments.starts_at',
      'appointments.created_at',
      'appointments.updated_at',
      'appointments.deleted_at',
      'opportunity_contacts.created_at',
    ]) {
      expect(have.has(col)).toBe(true);
    }
  });

  test('T2: DEFAULT now() under a non-UTC session reads back as the right instant', async () => {
    const before = Date.now();
    const [row] = await db
      .insert(appointments)
      .values({ title: 'default-now', startsAt: new Date() })
      .returning();
    const after = Date.now();
    // `createdAt` is filled by the column's DEFAULT now(), in the Kolkata session.
    const read = await db.select().from(appointments);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(read[0].createdAt.getTime()).toBeGreaterThanOrEqual(before - MINUTE);
    expect(read[0].createdAt.getTime()).toBeLessThanOrEqual(after + MINUTE);
  });

  test('T3: a non-Drizzle reader in a non-UTC process sees the same instant', async () => {
    const created = await repo.create({ title: 'raw-read', startsAt: new Date() });
    const r = await raw.query('select created_at from appointments where id = $1', [created.id]);
    expect(r.rows[0].created_at.getTime()).toBe(created.createdAt.getTime());
  });

  test('T4: a database-side comparison under a non-UTC session agrees', async () => {
    const created = await repo.create({ title: 'db-side', startsAt: new Date() });
    const r = await nonUtc.query(
      `select count(*)::int as n from appointments
        where id = $1 and created_at <= now() and created_at > now() - interval '1 minute'`,
      [created.id],
    );
    expect(r.rows[0].n).toBe(1);
  });

  test('T5: a JS round trip is the same instant (also true on a naive column; guards the JS path)', async () => {
    const instant = new Date('2026-03-08T06:30:00.000Z');
    const created = await repo.create({ title: 'round-trip', startsAt: instant });
    const found = await repo.findById(created.id);
    expect(found.startsAt.getTime()).toBe(instant.getTime());
  });

  test('T6: timezone: false is wall-clock time, unaffected by the session zone', async () => {
    const wall = new Date(Date.UTC(2026, 0, 1, 9, 0));
    const created = await repo.create({ title: 'wall-clock', startsAt: new Date(), opensAt: wall });
    const r = await nonUtc.query('select opens_at::text as t from appointments where id = $1', [created.id]);
    expect(r.rows[0].t).toBe('2026-01-01 09:00:00');
    const found = await repo.findById(created.id);
    expect(found.opensAt.getTime()).toBe(wall.getTime());
  });
});
