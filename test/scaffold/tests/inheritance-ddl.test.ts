/**
 * RFC-0006 / #875 S2 -- the DDL `drizzle-kit push` builds from the generated
 * joined-table-inheritance and `match:` entity files (acceptance A4, A5).
 *
 * Rows go in through raw SQL, bypassing the repository: the subject is the
 * constraint, and the repository's pair write is S4. Every rejection is
 * asserted by SQLSTATE AND by constraint name, read from `(err.cause ?? err)`,
 * so a case is tied to the emitted constraint and not to some other one that
 * happens to fire first. Each rejection also has a control that succeeds, so a
 * constraint cannot "pass" by the insert being malformed.
 *
 * Not here: A5's "the matched column is filled by the insert, not by the
 * caller". That is the repository's insert (a scalar subquery on the parent),
 * which lands in S4; S2 only emits the derived column and the composite FK.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 -- see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ids = {
  meetingComm: 'a0000000-0000-4000-8000-000000000001',
  emailComm: 'a0000000-0000-4000-8000-000000000002',
  messageComm: 'a0000000-0000-4000-8000-000000000003',
  transcript: 'b0000000-0000-4000-8000-000000000001',
  meetingRole: 'c0000000-0000-4000-8000-000000000001',
  emailRole: 'c0000000-0000-4000-8000-000000000002',
  participant: 'd0000000-0000-4000-8000-000000000001',
  part: 'e0000000-0000-4000-8000-000000000001',
};

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let sql: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

/** Run `fn`, return the (unwrapped) driver error it throws, or null. */
async function violation(fn: () => Promise<unknown>): Promise<any | null> {
  try {
    await fn();
    return null;
  } catch (err: any) {
    return err?.cause ?? err;
  }
}

const run = (stmt: any) => getTestDb().execute(stmt);
const count = async (table: string, id: string) =>
  Number((await run(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE id = '${id}'`))).rows[0].n);

const insertComm = (id: string, kind: string, tenant = TENANT_A) =>
  run(sql`INSERT INTO communications (id, tenant_id, kind, occurred_at, source, external_id)
          VALUES (${id}, ${tenant}, ${kind}, now(), 'src', ${`ext-${id}`})`);

const insertMeeting = (id: string, tenant = TENANT_A) =>
  run(sql`INSERT INTO meetings (id, tenant_id, title, starts_at) VALUES (${id}, ${tenant}, 'standup', now())`);

d('child of a base: meetings under communications (A4)', () => {
  test('control: a meeting under a meeting-kind communication inserts', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await insertMeeting(ids.meetingComm);
    expect(await count('meetings', ids.meetingComm)).toBe(1);
  });

  test('a meeting under an email communication fails with 23503 on the kind FK', async () => {
    await insertComm(ids.emailComm, 'email');
    const err = await violation(() => insertMeeting(ids.emailComm));
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('meetings_communication_kind_fk');
    expect(await count('meetings', ids.emailComm)).toBe(0);
  });

  test('a meeting under a message communication (a base-only kind) fails the same way', async () => {
    await insertComm(ids.messageComm, 'message');
    const err = await violation(() => insertMeeting(ids.messageComm));
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('meetings_communication_kind_fk');
  });

  test('a meeting with no base row fails with 23503', async () => {
    const err = await violation(() => insertMeeting(ids.meetingComm));
    expect(err?.code).toBe('23503');
  });

  test("the child's kind is fixed: a row that says another kind fails the CHECK (23514)", async () => {
    // Under an email communication the FK is satisfied by kind = 'email', so the CHECK is what refuses it.
    await insertComm(ids.emailComm, 'email');
    const err = await violation(() =>
      run(sql`INSERT INTO meetings (id, kind, tenant_id, title, starts_at)
              VALUES (${ids.emailComm}, 'email', ${TENANT_A}, 'x', now())`),
    );
    expect(err?.code).toBe('23514');
    expect(err?.constraint).toBe('meetings_kind_check');
  });

  test('the child id has no default: an insert with no id fails NOT NULL (23502)', async () => {
    const err = await violation(() =>
      run(sql`INSERT INTO meetings (tenant_id, title, starts_at) VALUES (${TENANT_A}, 'x', now())`),
    );
    expect(err?.code).toBe('23502');
    expect(err?.column).toBe('id');
  });

  test("a child whose tenant differs from its base row's fails with 23503 on the tenant FK", async () => {
    await insertComm(ids.meetingComm, 'meeting', TENANT_A);
    const err = await violation(() => insertMeeting(ids.meetingComm, TENANT_B));
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('meetings_communication_tenant_fk');
  });

  test('UPDATE of the base kind fails while a child row exists', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await insertMeeting(ids.meetingComm);
    const err = await violation(() =>
      run(sql`UPDATE communications SET kind = 'email' WHERE id = ${ids.meetingComm}`),
    );
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('meetings_communication_kind_fk');
  });

  test('control: the kind of a base row with no child can change', async () => {
    await insertComm(ids.messageComm, 'message');
    await run(sql`UPDATE communications SET kind = 'email' WHERE id = ${ids.messageComm}`);
  });

  test("UPDATE of the base tenant fails while a child row exists", async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await insertMeeting(ids.meetingComm);
    const err = await violation(() =>
      run(sql`UPDATE communications SET tenant_id = ${TENANT_B} WHERE id = ${ids.meetingComm}`),
    );
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('meetings_communication_tenant_fk');
  });

  test('a hard DELETE of the base removes the child', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await insertMeeting(ids.meetingComm);
    expect(await count('meetings', ids.meetingComm)).toBe(1);
    await run(sql`DELETE FROM communications WHERE id = ${ids.meetingComm}`);
    expect(await count('communications', ids.meetingComm)).toBe(0);
    expect(await count('meetings', ids.meetingComm)).toBe(0);
  });
});

/** The chain a transcript part needs: a meeting, its transcript, a role of the meeting kind, a participant. */
async function meetingChain() {
  await insertComm(ids.meetingComm, 'meeting');
  await insertMeeting(ids.meetingComm);
  await run(sql`INSERT INTO meeting_transcripts (id, meeting_id) VALUES (${ids.transcript}, ${ids.meetingComm})`);
  await run(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.meetingRole}, 'meeting', 'host')`);
  await run(sql`INSERT INTO communication_participants (id, communication_id, role_id, communication_kind, tenant_id)
                VALUES (${ids.participant}, ${ids.meetingComm}, ${ids.meetingRole}, 'meeting', ${TENANT_A})`);
}

const insertPart = (comm: string, kind: string) =>
  run(sql`INSERT INTO communication_parts (id, communication_id, tenant_id, kind, sequence)
          VALUES (${ids.part}, ${comm}, ${TENANT_A}, ${kind}, 1)`);

d('match: on the discriminator -- a part of kind meeting sits only under a meeting (A5)', () => {
  test('control: a transcript part (kind meeting) under a meeting communication inserts, base then child', async () => {
    await meetingChain();
    await insertPart(ids.meetingComm, 'meeting');
    await run(sql`INSERT INTO transcript_communication_parts (id, tenant_id, transcript_id, participant_id, text)
                  VALUES (${ids.part}, ${TENANT_A}, ${ids.transcript}, ${ids.participant}, 'hello')`);
    expect(await count('transcript_communication_parts', ids.part)).toBe(1);
  });

  test('a part of kind meeting under an email communication fails with 23503 on the match FK', async () => {
    await insertComm(ids.emailComm, 'email');
    const err = await violation(() => insertPart(ids.emailComm, 'meeting'));
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('communication_parts_communication_match_fk');
    expect(await count('communication_parts', ids.part)).toBe(0);
  });

  test('the part child pins its kind to its part base: a transcript part over an email-kind part fails', async () => {
    await meetingChain();
    await insertComm(ids.emailComm, 'email');
    await insertPart(ids.emailComm, 'email');
    const err = await violation(() =>
      run(sql`INSERT INTO transcript_communication_parts (id, tenant_id, transcript_id, participant_id, text)
              VALUES (${ids.part}, ${TENANT_A}, ${ids.transcript}, ${ids.participant}, 'x')`),
    );
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('transcript_communication_parts_communication_part_kind_fk');
  });
});

d('match: on a role lookup -- a participant role is one of the communication kind (A5)', () => {
  test('control: a participant whose role is a role of the communication kind inserts', async () => {
    await meetingChain();
    expect(await count('communication_participants', ids.participant)).toBe(1);
  });

  test('a participant whose role belongs to another kind fails with 23503 on the role match FK', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await run(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.emailRole}, 'email', 'sender')`);
    const err = await violation(() =>
      run(sql`INSERT INTO communication_participants (id, communication_id, role_id, communication_kind, tenant_id)
              VALUES (${ids.participant}, ${ids.meetingComm}, ${ids.emailRole}, 'meeting', ${TENANT_A})`),
    );
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('communication_participants_role_match_fk');
  });

  test("a participant whose derived kind is not its communication's fails with 23503 on the communication match FK", async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await run(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.emailRole}, 'email', 'sender')`);
    const err = await violation(() =>
      run(sql`INSERT INTO communication_participants (id, communication_id, role_id, communication_kind, tenant_id)
              VALUES (${ids.participant}, ${ids.meetingComm}, ${ids.emailRole}, 'email', ${TENANT_A})`),
    );
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('communication_participants_communication_match_fk');
  });

  test('the derived column is NOT NULL: a participant that names no kind fails with 23502', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await run(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.meetingRole}, 'meeting', 'host')`);
    const err = await violation(() =>
      run(sql`INSERT INTO communication_participants (id, communication_id, role_id, tenant_id)
              VALUES (${ids.participant}, ${ids.meetingComm}, ${ids.meetingRole}, ${TENANT_A})`),
    );
    expect(err?.code).toBe('23502');
    expect(err?.column).toBe('communication_kind');
  });
});

d('match: with nullable FKs sharing a derived column -- a SET FK always has its derived column', () => {
  // MATCH SIMPLE skips a composite FK that has a NULL in any column, so a set communication_id with a NULL
  // communication_kind would never be checked against the communication at all. The emitted CHECK closes that.
  // The reverse is allowed: a column set by one nullable FK while the other is NULL.
  const insertNote = (comm: string | null, role: string | null, kind: string | null) =>
    run(sql`INSERT INTO communication_notes (communication_id, role_id, communication_kind, body)
            VALUES (${comm}, ${role}, ${kind}, 'n')`);
  const insertRole = (id: string, kind: string) =>
    run(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${id}, ${kind}, 'r')`);

  test('control: no FK and no kind inserts', async () => {
    await insertNote(null, null, null);
  });

  test('control: a communication with its own kind inserts', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    await insertNote(ids.meetingComm, null, 'meeting');
  });

  test('allowed: one nullable FK set while the other is NULL, sharing the derived column', async () => {
    await insertRole(ids.meetingRole, 'meeting');
    // role set, communication NULL: the column is set, the role FK is checked against it
    await insertNote(null, ids.meetingRole, 'meeting');
    await insertComm(ids.meetingComm, 'meeting');
    // communication set, role NULL
    await insertNote(ids.meetingComm, null, 'meeting');
    // both set, agreeing
    await insertNote(ids.meetingComm, ids.meetingRole, 'meeting');
  });

  test('allowed: a derived column with no FK set', async () => {
    await insertNote(null, null, 'meeting');
  });

  test('a set FK with a NULL derived column fails the CHECK (23514) instead of skipping the composite FK', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    const err = await violation(() => insertNote(ids.meetingComm, null, null));
    expect(err?.code).toBe('23514');
    expect(err?.constraint).toBe('communication_notes_communication_match_check');
  });

  test('a set role with a NULL derived column fails its own CHECK (23514)', async () => {
    await insertRole(ids.meetingRole, 'meeting');
    const err = await violation(() => insertNote(null, ids.meetingRole, null));
    expect(err?.code).toBe('23514');
    expect(err?.constraint).toBe('communication_notes_role_match_check');
  });

  test('a set FK with the wrong kind still fails the composite FK (23503)', async () => {
    await insertComm(ids.meetingComm, 'meeting');
    const err = await violation(() => insertNote(ids.meetingComm, null, 'email'));
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('communication_notes_communication_match_fk');
  });

  test('a role of another kind than the shared column fails the role composite FK (23503)', async () => {
    await insertRole(ids.emailRole, 'email');
    const err = await violation(() => insertNote(null, ids.emailRole, 'meeting'));
    expect(err?.code).toBe('23503');
    expect(err?.constraint).toBe('communication_notes_role_match_fk');
  });
});
