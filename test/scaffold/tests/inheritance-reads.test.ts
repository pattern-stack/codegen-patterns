/**
 * RFC-0006 / #875 S3 — the family reads and the child's scope, against real Postgres
 * (acceptance A8, A9).
 *
 * Rows go in through raw SQL, bypassing every repository: the subject is what a READ
 * returns and refuses, not what a write path creates (S4). Every read goes through a
 * GENERATED repository, which is the path a consumer takes, or through a hand-written
 * `db.query.*` for the HOP cases — the relations manifest carries the scope with the
 * relation, so a traversal that never touches a repository is scoped too (charter I3).
 *
 *   - `communication_part` declares `soft_delete`: a child whose base row is soft-deleted
 *     is absent at the root and at a hop into it (the `EXISTS` on the base);
 *   - `communication` is tenant-only: another tenant's child is absent at the root and at
 *     a hop, through the child's OWN tenant column (no `EXISTS` is needed or emitted);
 *   - `findAllKinds` returns the union — each child under its kind's key, the base-only
 *     kind bare — and throws `OrphanBaseError` on a base row whose child is missing, which
 *     `findOrphans` returns.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import 'reflect-metadata';
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ids = {
  meetingA: 'a0000000-0000-4000-8000-000000000001',
  emailA: 'a0000000-0000-4000-8000-000000000002',
  messageA: 'a0000000-0000-4000-8000-000000000003',
  meetingB: 'a0000000-0000-4000-8000-000000000004',
  orphan: 'a0000000-0000-4000-8000-000000000005',
  transcript: 'b0000000-0000-4000-8000-000000000001',
  role: 'c0000000-0000-4000-8000-000000000001',
  participant: 'd0000000-0000-4000-8000-000000000001',
  partLive: 'e0000000-0000-4000-8000-000000000001',
  partDeleted: 'e0000000-0000-4000-8000-000000000002',
};

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let sql: any;
let withRequester: any;
let OrphanBaseError: any;
let CommunicationRepository: any;
let MeetingRepository: any;
let countingDb: any;
let statementCount = 0;
let endCountingPool: any;
let TranscriptCommunicationPartRepository: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
  ({ withRequester } = await import('@shared/base-classes/tenant-context'));
  ({ OrphanBaseError } = await import('@shared/base-classes/inheritance'));
  // A client that counts the statements it is handed: the one-statement claim (charter I4) is about the GENERATED
  // reads, so it is measured on them, not on a hand copy.
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { relations } = await import('@gen/generated/relations');
  const { scaffoldDatabaseUrl } = await import('../harness-env');
  const pool = new Pool({ connectionString: scaffoldDatabaseUrl() });
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as any).query = (...args: unknown[]) => {
    statementCount++;
    return query(...args);
  };
  countingDb = drizzle({ client: pool, relations });
  endCountingPool = () => pool.end();
  ({ CommunicationRepository } = await import('@gen/modules/communications/communication.repository'));
  ({ MeetingRepository } = await import('@gen/modules/meetings/meeting.repository'));
  ({ TranscriptCommunicationPartRepository } = await import(
    '@gen/modules/transcript-communication-parts/transcript-communication-part.repository'
  ));
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await endCountingPool?.();
  await closeDb();
});

const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  withRequester({ userId: USER, organizationId: null, tenantId }, fn);
const asA = <T>(fn: () => Promise<T>) => asTenant(TENANT_A, fn);

const run = (stmt: any) => getTestDb().execute(stmt);

const insertComm = (id: string, kind: string, tenant = TENANT_A, occurredAt = '2026-01-01T00:00:00Z') =>
  run(sql`INSERT INTO communications (id, tenant_id, kind, occurred_at, source, external_id)
          VALUES (${id}, ${tenant}, ${kind}, ${occurredAt}, 'src', ${`ext-${id}`})`);
const insertMeeting = (id: string, tenant = TENANT_A, title = 'standup') =>
  run(sql`INSERT INTO meetings (id, tenant_id, title, starts_at) VALUES (${id}, ${tenant}, ${title}, now())`);
const insertEmail = (id: string, tenant = TENANT_A) =>
  run(sql`INSERT INTO emails (id, tenant_id, subject) VALUES (${id}, ${tenant}, 'hello')`);

/** Tenant A: a meeting, an email and a message. Tenant B: a meeting. */
async function seedCommunications() {
  await insertComm(ids.meetingA, 'meeting', TENANT_A, '2026-01-03T00:00:00Z');
  await insertMeeting(ids.meetingA);
  await insertComm(ids.emailA, 'email', TENANT_A, '2026-01-02T00:00:00Z');
  await insertEmail(ids.emailA);
  await insertComm(ids.messageA, 'message', TENANT_A, '2026-01-01T00:00:00Z');
  await insertComm(ids.meetingB, 'meeting', TENANT_B, '2026-01-04T00:00:00Z');
  await insertMeeting(ids.meetingB, TENANT_B, 'b-standup');
}

/** A meeting with a live transcript part and a part whose base is soft-deleted. */
async function seedParts() {
  await insertComm(ids.meetingA, 'meeting');
  await insertMeeting(ids.meetingA);
  await run(sql`INSERT INTO meeting_transcripts (id, meeting_id) VALUES (${ids.transcript}, ${ids.meetingA})`);
  await run(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.role}, 'meeting', 'host')`);
  await run(sql`INSERT INTO communication_participants (id, communication_id, role_id, communication_kind, tenant_id)
                VALUES (${ids.participant}, ${ids.meetingA}, ${ids.role}, 'meeting', ${TENANT_A})`);
  const part = async (id: string, sequence: number, deleted: boolean) => {
    await run(sql`INSERT INTO communication_parts (id, communication_id, tenant_id, kind, sequence, deleted_at)
                  VALUES (${id}, ${ids.meetingA}, ${TENANT_A}, 'meeting', ${sequence}, ${deleted ? new Date() : null})`);
    await run(sql`INSERT INTO transcript_communication_parts (id, tenant_id, transcript_id, participant_id, text)
                  VALUES (${id}, ${TENANT_A}, ${ids.transcript}, ${ids.participant}, ${deleted ? 'deleted' : 'live'})`);
  };
  await part(ids.partLive, 1, false);
  await part(ids.partDeleted, 2, true);
}

d('A9 — findAllKinds returns the union', () => {
  test('each child sits under its kind key; the base-only kind is bare; other tenants are absent', async () => {
    await seedCommunications();
    const rows = await asA(() => new CommunicationRepository(getTestDb()).findAllKinds({
      sort: [{ column: 'occurredAt', direction: 'desc' }],
    }));
    expect(rows.map((r: any) => r.id)).toEqual([ids.meetingA, ids.emailA, ids.messageA]);

    const [meeting, email, message] = rows as any[];
    expect(meeting.kind).toBe('meeting');
    expect(meeting.meeting.title).toBe('standup');
    expect('email' in meeting).toBe(false);
    expect(email.kind).toBe('email');
    expect(email.email.subject).toBe('hello');
    expect('meeting' in email).toBe(false);
    // The base-only kind narrows to the base alone.
    expect(message.kind).toBe('message');
    expect('meeting' in message).toBe(false);
    expect('email' in message).toBe(false);
  });

  test('`kinds` filters the scan and joins only those children', async () => {
    await seedCommunications();
    const rows = await asA(() => new CommunicationRepository(getTestDb()).findAllKinds({ kinds: ['meeting'] }));
    expect(rows.map((r: any) => r.id)).toEqual([ids.meetingA]);
  });

  test('findKindById, listKind (flat, sorted on a BASE column) and countKind', async () => {
    await seedCommunications();
    const repo = new CommunicationRepository(getTestDb());
    await asA(async () => {
      const one = await repo.findKindById(ids.emailA);
      expect(one?.kind).toBe('email');
      expect((one as any).email.subject).toBe('hello');
      expect(await repo.findKindById(ids.meetingB)).toBeNull(); // another tenant's

      const flat = await repo.listKind('meeting', { sort: [{ column: 'occurredAt', direction: 'desc' }] });
      expect(flat).toHaveLength(1);
      // Base columns and child columns at one level.
      expect((flat[0] as any).title).toBe('standup');
      expect((flat[0] as any).source).toBe('src');
      expect('meeting' in (flat[0] as any)).toBe(false);

      expect(await repo.countKind('meeting')).toBe(1);
      expect(await repo.countKind('message')).toBe(1);
    });
  });

  test('the child reads flat, with its base joined in', async () => {
    await seedCommunications();
    const repo = new MeetingRepository(getTestDb());
    await asA(async () => {
      const flat = await repo.findWithBase(ids.meetingA);
      expect(flat?.title).toBe('standup');
      expect(flat?.source).toBe('src');
      expect('communication' in (flat as any)).toBe(false);
      expect(await repo.findWithBase(ids.meetingB)).toBeNull();
      expect((await repo.findManyWithBase([ids.meetingA, ids.meetingB])).map((r: any) => r.id)).toEqual([ids.meetingA]);
    });
  });

  test('an orphan base row makes findAllKinds throw OrphanBaseError, and findOrphans returns exactly it', async () => {
    await seedCommunications();
    // The base row of kind meeting, inserted ALONE: legal to Postgres (the base goes first, RFC §2.2).
    await insertComm(ids.orphan, 'meeting');
    const repo = new CommunicationRepository(getTestDb());
    await asA(async () => {
      await expect(repo.findAllKinds()).rejects.toBeInstanceOf(OrphanBaseError);
      await expect(repo.findAllKinds()).rejects.toThrow(new RegExp(`${ids.orphan}.*meeting`));
      await expect(repo.findKindById(ids.orphan)).rejects.toBeInstanceOf(OrphanBaseError);
      const orphans = await repo.findOrphans();
      expect(orphans.map((r: any) => r.id)).toEqual([ids.orphan]);
    });
  });

  test('findOrphans is empty for a healthy family, and never lists another tenant`s orphan', async () => {
    await seedCommunications();
    await insertComm(ids.orphan, 'email', TENANT_B);
    await asA(async () => {
      expect(await new CommunicationRepository(getTestDb()).findOrphans()).toEqual([]);
    });
  });
});

d('A8 — tenant: another tenant`s child is absent at the root and at a hop', () => {
  test('at the root, through the generated repository', async () => {
    await seedCommunications();
    const repo = new MeetingRepository(getTestDb());
    await asA(async () => {
      expect((await repo.list()).map((m: any) => m.id)).toEqual([ids.meetingA]);
      expect(await repo.findById(ids.meetingB)).toBeNull();
      expect(await repo.findById(ids.meetingA)).not.toBeNull();
    });
    // …and B reads B's own, which proves the filter is the tenant and not an empty table.
    await asTenant(TENANT_B, async () => {
      expect((await repo.list()).map((m: any) => m.id)).toEqual([ids.meetingB]);
    });
  });

  test('at a hop INTO the child, through a hand-written db.query (the manifest carries the scope)', async () => {
    await seedCommunications();
    await asA(async () => {
      const rows = await getTestDb().query.communications.findMany({ with: { meeting: true } });
      const byId = new Map(rows.map((r: any) => [r.id, r]));
      expect((byId.get(ids.meetingA) as any).meeting.title).toBe('standup');
      // The root is unscoped (raw db.query), so B's base row comes back; its CHILD does not.
      expect((byId.get(ids.meetingB) as any).meeting).toBeNull();
    });
  });

  test('at a hop into the BASE from the child, the base of another tenant is absent too', async () => {
    await seedCommunications();
    await asA(async () => {
      const rows = await getTestDb().query.meetings.findMany({ with: { communication: true } });
      const byId = new Map(rows.map((r: any) => [r.id, r]));
      expect((byId.get(ids.meetingA) as any).communication.source).toBe('src');
      expect((byId.get(ids.meetingB) as any).communication).toBeNull();
    });
  });

  test('strict: a read with no ambient tenant throws, never reading the union of every tenant', async () => {
    await seedCommunications();
    await expect(new MeetingRepository(getTestDb()).list()).rejects.toThrow();
  });
});

d('A8 — soft_delete on the base: a child whose base is deleted is absent', () => {
  test('at the root, through the generated repository', async () => {
    await seedParts();
    const repo = new TranscriptCommunicationPartRepository(getTestDb());
    await asA(async () => {
      expect((await repo.list()).map((p: any) => p.id)).toEqual([ids.partLive]);
      expect(await repo.findById(ids.partLive)).not.toBeNull();
      // The child row exists and is tenant A's; only its base is deleted.
      expect(await repo.findById(ids.partDeleted)).toBeNull();
      expect((await repo.findByIds([ids.partLive, ids.partDeleted])).map((p: any) => p.id)).toEqual([ids.partLive]);
    });
    // The child row is really there.
    const raw = await run(sql`SELECT count(*)::int AS n FROM transcript_communication_parts WHERE id = ${ids.partDeleted}`);
    expect(raw.rows[0].n).toBe(1);
  });

  test('at a hop INTO the child, through a hand-written db.query', async () => {
    await seedParts();
    await asA(async () => {
      // Root unscoped (raw): both base rows come back; the soft-deleted one has no child.
      const rows = await getTestDb().query.communication_parts.findMany({ with: { transcriptCommunicationPart: true } });
      const byId = new Map(rows.map((r: any) => [r.id, r]));
      expect((byId.get(ids.partLive) as any).transcriptCommunicationPart.text).toBe('live');
      expect((byId.get(ids.partDeleted) as any).transcriptCommunicationPart).toBeNull();
    });
  });

  test('the base is the guard: restoring it brings the child back', async () => {
    await seedParts();
    const repo = new TranscriptCommunicationPartRepository(getTestDb());
    await run(sql`UPDATE communication_parts SET deleted_at = NULL WHERE id = ${ids.partDeleted}`);
    await asA(async () => {
      expect((await repo.list()).map((p: any) => p.id).sort()).toEqual([ids.partLive, ids.partDeleted].sort());
    });
  });
});

/** Statements issued by `fn`, as the counting client saw them. */
async function statementsOf(fn: () => Promise<unknown>): Promise<number> {
  statementCount = 0;
  await fn();
  return statementCount;
}

d('A9 — each generated family read is ONE statement (charter I4), measured on the generated code', () => {
  test('control: the counter sees more than one when more than one is issued', async () => {
    await seedCommunications();
    const repo = new MeetingRepository(countingDb);
    const n = await statementsOf(() => asA(async () => {
      await repo.list();
      await repo.list();
    }));
    expect(n).toBe(2);
  });

  test('findAllKinds (all kinds, and filtered), findKindById, listKind, countKind, findOrphans', async () => {
    await seedCommunications();
    const repo = new CommunicationRepository(countingDb);
    const one = (fn: () => Promise<unknown>) => statementsOf(() => asA(fn));
    expect(await one(() => repo.findAllKinds())).toBe(1);
    expect(await one(() => repo.findAllKinds({ kinds: ['meeting', 'email'], limit: 10 }))).toBe(1);
    expect(await one(() => repo.findKindById(ids.meetingA))).toBe(1);
    expect(await one(() => repo.listKind('meeting'))).toBe(1);
    expect(await one(() => repo.countKind('meeting'))).toBe(1);
    expect(await one(() => repo.findOrphans())).toBe(1);
  });

  test('findWithBase and findManyWithBase', async () => {
    await seedCommunications();
    const repo = new MeetingRepository(countingDb);
    const one = (fn: () => Promise<unknown>) => statementsOf(() => asA(fn));
    expect(await one(() => repo.findWithBase(ids.meetingA))).toBe(1);
    expect(await one(() => repo.findManyWithBase([ids.meetingA, ids.meetingB]))).toBe(1);
  });
});
