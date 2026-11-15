/**
 * RFC-0006 / #875 S4 — the pair writes, the pair upsert and the `match:` fill, against real
 * Postgres (acceptance A6, A7, A11, and A5's "the matched column is filled by the insert").
 *
 * Every write goes through a GENERATED repository or service — the path a consumer takes. Rows
 * are read back with raw SQL, bypassing every repository, so what the write left in the tables is
 * asserted and not what a read path chose to show.
 *
 *   - A6  `create` writes both rows in one transaction and a failing child insert rolls the base
 *         row back; `update` across both tables bumps the base's `updated_at`; a `kind` key throws
 *         `KindImmutableError`; `delete` removes the pair (hard), or the child leaves child reads
 *         (soft, `communication_part`).
 *   - A7  `upsertByNaturalKey` twice leaves one pair and reports `created: false`; a key under
 *         another kind throws `KindMismatchError` and writes nothing; one tenant never touches
 *         another's row; a soft-deleted match is updated and stays deleted.
 *   - A5  a derived `match:` column is filled by the insert (the caller passes none) and
 *         re-derived when the foreign key changes.
 *   - A11 a child write emits under the child's name and the base's, with each one's own slice.
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
  meetingRole: 'c0000000-0000-4000-8000-000000000001',
  emailRole: 'c0000000-0000-4000-8000-000000000002',
  transcript: 'b0000000-0000-4000-8000-000000000001',
  missing: 'f0000000-0000-4000-8000-0000000000ff',
  orphan: 'a0000000-0000-4000-8000-0000000000aa',
};

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let sql: any;
let withRequester: any;
let errors: any;
let CommunicationRepository: any;
let CommunicationService: any;
let MeetingRepository: any;
let MeetingService: any;
let EmailRepository: any;
let MeetingTranscriptRepository: any;
let CommunicationPartRepository: any;
let TranscriptCommunicationPartRepository: any;
let CommunicationParticipantRepository: any;
let CommunicationNoteRepository: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
  ({ withRequester } = await import('@shared/base-classes/tenant-context'));
  errors = await import('@shared/base-classes/inheritance');
  ({ CommunicationRepository } = await import('@gen/modules/communications/communication.repository'));
  ({ CommunicationService } = await import('@gen/modules/communications/communication.service'));
  ({ MeetingRepository } = await import('@gen/modules/meetings/meeting.repository'));
  ({ MeetingService } = await import('@gen/modules/meetings/meeting.service'));
  ({ EmailRepository } = await import('@gen/modules/emails/email.repository'));
  ({ MeetingTranscriptRepository } = await import('@gen/modules/meeting-transcripts/meeting-transcript.repository'));
  ({ CommunicationPartRepository } = await import('@gen/modules/communication-parts/communication-part.repository'));
  ({ TranscriptCommunicationPartRepository } = await import(
    '@gen/modules/transcript-communication-parts/transcript-communication-part.repository'
  ));
  ({ CommunicationParticipantRepository } = await import(
    '@gen/modules/communication-participants/communication-participant.repository'
  ));
  ({ CommunicationNoteRepository } = await import('@gen/modules/communication-notes/communication-note.repository'));
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  withRequester({ userId: USER, organizationId: null, tenantId }, fn);
const asA = <T>(fn: () => Promise<T>) => asTenant(TENANT_A, fn);
const asB = <T>(fn: () => Promise<T>) => asTenant(TENANT_B, fn);

const db = () => getTestDb();
const rows = async (statement: string): Promise<any[]> => (await db().execute(sql.raw(statement))).rows;
const count = async (table: string, where = 'true') =>
  Number((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n);

// A child's repository injects its base's (RFC-0006 §4.1).
const commRepo = () => new CommunicationRepository(db());
const meetingRepo = () => new MeetingRepository(db(), commRepo());
const emailRepo = () => new EmailRepository(db(), commRepo());
const partRepo = () => new TranscriptCommunicationPartRepository(db(), new CommunicationPartRepository(db()));

const meetingInput = (over: Record<string, unknown> = {}) => ({
  occurredAt: new Date('2026-01-03T00:00:00Z'),
  source: 'src',
  externalId: 'ext-1',
  title: 'standup',
  startsAt: new Date('2026-01-03T09:00:00Z'),
  ...over,
});

/** The SQLSTATE of a rejection, read from `(err.cause ?? err)` — the driver error under drizzle's wrapper. */
async function sqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err: any) {
    return (err?.cause ?? err)?.code ?? `non-database: ${err?.name}`;
  }
}

d('A6 — the pair write', () => {
  test('create writes both rows, stamped with the ambient tenant, and returns the flat row', async () => {
    const flat = await asA(() => meetingRepo().create(meetingInput()));
    expect(flat.kind).toBe('meeting');
    expect(flat.tenantId).toBe(TENANT_A);
    expect(flat.title).toBe('standup');
    expect(flat.source).toBe('src');
    expect(await count('communications', `id = '${flat.id}' AND kind = 'meeting' AND tenant_id = '${TENANT_A}'`)).toBe(1);
    expect(await count('meetings', `id = '${flat.id}' AND tenant_id = '${TENANT_A}' AND title = 'standup'`)).toBe(1);
  });

  test('a failing child insert rolls the base row back', async () => {
    // `title` is NOT NULL on meetings and absent: the base insert succeeds, the child insert fails.
    const { title: _omitted, ...withoutTitle } = meetingInput();
    expect(await sqlState(() => asA(() => meetingRepo().create(withoutTitle as any)))).toBe('23502');
    expect(await count('communications')).toBe(0);
    expect(await count('meetings')).toBe(0);
  });

  test('create inside a caller-owned transaction joins it: rolling the caller back removes both rows', async () => {
    await expect(
      asA(() =>
        db().transaction(async (tx: any) => {
          await meetingRepo().create(meetingInput(), tx);
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(await count('communications')).toBe(0);
    expect(await count('meetings')).toBe(0);
  });

  test('an input that names another kind is refused', async () => {
    await expect(asA(() => meetingRepo().create(meetingInput({ kind: 'email' })))).rejects.toBeInstanceOf(
      errors.KindMismatchError,
    );
    expect(await count('communications')).toBe(0);
  });

  test('update across both tables bumps the base updated_at', async () => {
    const created = await asA(() => meetingRepo().create(meetingInput()));
    await db().execute(sql`UPDATE communications SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ${created.id}`);

    const updated = await asA(() =>
      meetingRepo().update(created.id, { title: 'retro', occurredAt: new Date('2026-02-01T00:00:00Z') }),
    );
    expect(updated.title).toBe('retro');
    expect(updated.occurredAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(await count('meetings', `id = '${created.id}' AND title = 'retro'`)).toBe(1);
    expect(await count('communications', `id = '${created.id}' AND occurred_at = '2026-02-01T00:00:00Z'`)).toBe(1);
    expect(await count('communications', `id = '${created.id}' AND updated_at > '2025-01-01'`)).toBe(1);
  });

  test('a patch of only the child\'s columns still bumps the base updated_at', async () => {
    const created = await asA(() => meetingRepo().create(meetingInput()));
    await db().execute(sql`UPDATE communications SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ${created.id}`);
    await asA(() => meetingRepo().update(created.id, { title: 'only child' }));
    expect(await count('communications', `id = '${created.id}' AND updated_at > '2025-01-01'`)).toBe(1);
  });

  test('a `kind` key in an update throws KindImmutableError, and nothing changes', async () => {
    const created = await asA(() => meetingRepo().create(meetingInput()));
    await expect(
      asA(() => meetingRepo().update(created.id, { kind: 'email', title: 'changed' } as any)),
    ).rejects.toBeInstanceOf(errors.KindImmutableError);
    expect(await count('meetings', `id = '${created.id}' AND title = 'standup'`)).toBe(1);
  });

  test('update and delete through a child never touch a row of another kind', async () => {
    const email = await asA(() => emailRepo().create({ ...meetingInput({ externalId: 'ext-mail' }), subject: 'hi' } as any));
    expect(await asA(() => meetingRepo().update(email.id, { source: 'hijack' }))).toBeUndefined();
    await asA(() => meetingRepo().delete(email.id));
    expect(await count('communications', `id = '${email.id}' AND source = 'src'`)).toBe(1);
    expect(await count('emails', `id = '${email.id}'`)).toBe(1);
  });

  test('delete (hard) removes the pair', async () => {
    const created = await asA(() => meetingRepo().create(meetingInput()));
    await asA(() => meetingRepo().delete(created.id));
    expect(await count('communications')).toBe(0);
    expect(await count('meetings')).toBe(0);
  });
});

/** A meeting, a transcript, a participant, then a transcript part under it (the soft-delete family). */
async function seedPartFamily() {
  const meeting = await asA(() => meetingRepo().create(meetingInput()));
  await db().execute(sql`INSERT INTO meeting_transcripts (id, meeting_id) VALUES (${ids.transcript}, ${meeting.id})`);
  await db().execute(sql`INSERT INTO communication_participant_roles (id, kind, role)
                         VALUES (${ids.meetingRole}, 'meeting', 'host')`);
  const participant = await asA(() =>
    new CommunicationParticipantRepository(db()).create({ communicationId: meeting.id, roleId: ids.meetingRole }),
  );
  return { meeting, participant };
}

const partInput = (meetingId: string, participantId: string, over: Record<string, unknown> = {}) => ({
  communicationId: meetingId,
  sequence: 1,
  transcriptId: ids.transcript,
  participantId,
  text: 'hello',
  ...over,
});

d('A6 — a child of a soft-delete base', () => {
  test('create fills the base kind from the write path, and delete soft-deletes the base: the child leaves child reads', async () => {
    const { meeting, participant } = await seedPartFamily();
    const part = await asA(() => partRepo().create(partInput(meeting.id, participant.id) as any));
    expect(part.kind).toBe('meeting');
    expect(await count('communication_parts', `id = '${part.id}' AND kind = 'meeting'`)).toBe(1);

    await asA(() => partRepo().delete(part.id));
    expect(await count('communication_parts', `id = '${part.id}' AND deleted_at IS NOT NULL`)).toBe(1);
    // The child row is still in its table; it left the child's READS through the base's `EXISTS`.
    expect(await count('transcript_communication_parts', `id = '${part.id}'`)).toBe(1);
    expect(await asA(() => partRepo().findWithBase(part.id))).toBeNull();
    expect(await asA(() => partRepo().list())).toHaveLength(0);
  });
});

d('A7 — upsertByNaturalKey', () => {
  test('twice with one key: one base row, one child row, the second call created: false', async () => {
    const first = await asA(() => meetingRepo().upsertByNaturalKey(meetingInput({ link: 'https://a.example' })));
    expect(first.created).toBe(true);
    expect(first.row.kind).toBe('meeting');

    const second = await asA(() => meetingRepo().upsertByNaturalKey(meetingInput({ title: 'renamed' })));
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await count('communications')).toBe(1);
    expect(await count('meetings')).toBe(1);
    // The key left out (`link`) is left alone; the one carried is written.
    expect(await count('meetings', `title = 'renamed' AND link = 'https://a.example'`)).toBe(1);
  });

  test('an explicit null clears a column; an absent key leaves it', async () => {
    await asA(() => meetingRepo().upsertByNaturalKey(meetingInput({ link: 'https://a.example' })));
    await asA(() => meetingRepo().upsertByNaturalKey(meetingInput({ link: null })));
    expect(await count('meetings', 'link IS NULL')).toBe(1);
  });

  test('the SET never rewrites the key, the kind, the tenant or created_at, and bumps updated_at', async () => {
    const first = await asA(() => meetingRepo().upsertByNaturalKey(meetingInput()));
    await db().execute(
      sql`UPDATE communications SET created_at = '2019-01-01T00:00:00Z', updated_at = '2020-01-01T00:00:00Z' WHERE id = ${first.row.id}`,
    );
    await asA(() => meetingRepo().upsertByNaturalKey(meetingInput({ occurredAt: new Date('2026-05-05T00:00:00Z') })));
    expect(await count('communications', `created_at = '2019-01-01T00:00:00Z'`)).toBe(1);
    expect(await count('communications', `updated_at > '2025-01-01' AND occurred_at = '2026-05-05T00:00:00Z'`)).toBe(1);
    expect(await count('communications', `kind = 'meeting' AND tenant_id = '${TENANT_A}'`)).toBe(1);
  });

  test('a key that exists under another kind throws KindMismatchError and writes nothing', async () => {
    const meeting = await asA(() => meetingRepo().upsertByNaturalKey(meetingInput()));
    await expect(
      asA(() => emailRepo().upsertByNaturalKey({ ...meetingInput({ occurredAt: new Date('2030-01-01T00:00:00Z') }), subject: 'hi' } as any)),
    ).rejects.toBeInstanceOf(errors.KindMismatchError);
    expect(await count('emails')).toBe(0);
    expect(await count('communications', `id = '${meeting.row.id}' AND occurred_at = '2026-01-03T00:00:00Z'`)).toBe(1);
  });

  test('…also when the caller owns the transaction and swallows the error: the transaction stays usable and commits', async () => {
    const meeting = await asA(() => meetingRepo().upsertByNaturalKey(meetingInput()));
    await asA(() =>
      db().transaction(async (tx: any) => {
        const refused = await emailRepo()
          .upsertByNaturalKey({ ...meetingInput({ occurredAt: new Date('2030-01-01T00:00:00Z') }), subject: 'hi' } as any, tx)
          .catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(errors.KindMismatchError);
        // The refusal happened BEFORE any write, so the caller's transaction is not aborted: this write commits.
        // (A guard that let the base UPDATE run and failed later, on the child insert's FK, would abort the
        // transaction and fail this statement.)
        await commRepo().create({ occurredAt: new Date('2026-02-02T00:00:00Z'), source: 'src', externalId: 'ext-after', kind: 'message' }, tx);
      }),
    );
    expect(await count('communications', `external_id = 'ext-after'`)).toBe(1);
    expect(await count('communications', `id = '${meeting.row.id}' AND occurred_at = '2026-01-03T00:00:00Z'`)).toBe(1);
  });

  test('one tenant\'s upsert never touches another tenant\'s row with the same key', async () => {
    const a = await asA(() => meetingRepo().upsertByNaturalKey(meetingInput({ title: 'a-title' })));
    const b = await asB(() => meetingRepo().upsertByNaturalKey(meetingInput({ title: 'b-title' })));
    expect(b.created).toBe(true);
    expect(b.row.id).not.toBe(a.row.id);
    expect(await count('communications')).toBe(2);
    expect(await count('meetings', `id = '${a.row.id}' AND title = 'a-title' AND tenant_id = '${TENANT_A}'`)).toBe(1);
    expect(await count('meetings', `id = '${b.row.id}' AND title = 'b-title' AND tenant_id = '${TENANT_B}'`)).toBe(1);
  });

  test('a soft-deleted match is updated and stays deleted', async () => {
    const { meeting, participant } = await seedPartFamily();
    const first = await asA(() => partRepo().upsertByNaturalKey(partInput(meeting.id, participant.id) as any));
    expect(first.created).toBe(true);
    await asA(() => partRepo().delete(first.row.id));

    const again = await asA(() => partRepo().upsertByNaturalKey(partInput(meeting.id, participant.id, { text: 'edited' }) as any));
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    expect(await count('transcript_communication_parts', `id = '${first.row.id}' AND text = 'edited'`)).toBe(1);
    expect(await count('communication_parts', `id = '${first.row.id}' AND deleted_at IS NOT NULL`)).toBe(1);
    expect(await count('communication_parts')).toBe(1);
  });
});

d('A5 — the derived `match:` column is filled by the insert', () => {
  test('communication_participant: create passes no communication_kind and the row carries it', async () => {
    await db().execute(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.meetingRole}, 'meeting', 'host')`);
    const meeting = await asA(() => meetingRepo().create(meetingInput()));
    const participant = await asA(() =>
      new CommunicationParticipantRepository(db()).create({ communicationId: meeting.id, roleId: ids.meetingRole }),
    );
    expect(participant.communicationKind).toBe('meeting');
    expect(await count('communication_participants', `id = '${participant.id}' AND communication_kind = 'meeting'`)).toBe(1);
  });

  test('a caller-supplied value is ignored: the parent decides', async () => {
    await db().execute(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.meetingRole}, 'meeting', 'host')`);
    const meeting = await asA(() => meetingRepo().create(meetingInput()));
    const participant = await asA(() =>
      new CommunicationParticipantRepository(db()).create({
        communicationId: meeting.id,
        roleId: ids.meetingRole,
        communicationKind: 'email',
      } as any),
    );
    expect(participant.communicationKind).toBe('meeting');
  });

  test('an update that changes the foreign keys re-derives it; the column alone is refused (M4)', async () => {
    await db().execute(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES
      (${ids.meetingRole}, 'meeting', 'host'), (${ids.emailRole}, 'email', 'sender')`);
    const meeting = await asA(() => meetingRepo().create(meetingInput()));
    const email = await asA(() => emailRepo().create({ ...meetingInput({ externalId: 'ext-mail' }), subject: 'hi' } as any));
    const repo = new CommunicationParticipantRepository(db());
    const participant = await asA(() => repo.create({ communicationId: email.id, roleId: ids.emailRole }));
    expect(participant.communicationKind).toBe('email');

    const moved = await asA(() => repo.update(participant.id, { communicationId: meeting.id, roleId: ids.meetingRole }));
    expect(moved.communicationKind).toBe('meeting');
    expect(await count('communication_participants', `id = '${participant.id}' AND communication_kind = 'meeting'`)).toBe(1);

    await expect(asA(() => repo.update(participant.id, { communicationKind: 'email' } as any))).rejects.toBeInstanceOf(
      errors.MatchColumnImmutableError,
    );
    // A patch that leaves the keys alone leaves the column alone.
    const untouched = await asA(() => repo.update(participant.id, { partyId: null }));
    expect(untouched.communicationKind).toBe('meeting');
  });

  test('a missing parent fails the insert: NOT NULL on the derived column when no parent resolves, the FK when one does', async () => {
    await db().execute(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.meetingRole}, 'meeting', 'host')`);
    const repo = new CommunicationParticipantRepository(db());
    // The communication is missing but the role resolves: the column derives, and the communication FK refuses it.
    expect(await sqlState(() => asA(() => repo.create({ communicationId: ids.missing, roleId: ids.meetingRole })))).toBe('23503');
    // Neither resolves: the derived column is NULL.
    expect(await sqlState(() => asA(() => repo.create({ communicationId: ids.missing, roleId: ids.missing })))).toBe('23502');
    expect(await count('communication_participants')).toBe(0);
  });

  test('communication_note (every FK nullable): the column follows whichever parent is set', async () => {
    await db().execute(sql`INSERT INTO communication_participant_roles (id, kind, role) VALUES (${ids.emailRole}, 'email', 'sender')`);
    const repo = new CommunicationNoteRepository(db());
    const viaRole = await asA(() => repo.create({ body: 'b', roleId: ids.emailRole }));
    expect(viaRole.communicationKind).toBe('email');
    const neither = await asA(() => repo.create({ body: 'c' }));
    expect(neither.communicationKind).toBeNull();
  });
});

/** An in-memory event bus: records what a service publishes. */
function recordingBus() {
  const published: any[] = [];
  return {
    published,
    publish: async (event: any) => void published.push(event),
    publishMany: async (events: any[]) => void published.push(...events),
  };
}

const meetingService = (bus: ReturnType<typeof recordingBus>) => {
  const service = new MeetingService(meetingRepo(), new MeetingTranscriptRepository(db()));
  (service as any).eventBus = bus;
  return service;
};
const typesOf = (bus: ReturnType<typeof recordingBus>) => bus.published.map((e) => e.type).sort();
const eventOf = (bus: ReturnType<typeof recordingBus>, type: string) => bus.published.find((e) => e.type === type);

d('A11 — a child write emits under both names', () => {
  test('create: meeting.created carries the flat snapshot, communication.created the base slice', async () => {
    const bus = recordingBus();
    await asA(() => meetingService(bus).create(meetingInput()));
    expect(typesOf(bus)).toEqual(['communication.created', 'meeting.created']);
    const child = eventOf(bus, 'meeting.created').payload.snapshot;
    const base = eventOf(bus, 'communication.created').payload.snapshot;
    expect(child.title).toBe('standup');
    expect(child.source).toBe('src');
    expect(base.source).toBe('src');
    expect(base.title).toBeUndefined();
    expect(eventOf(bus, 'communication.created').aggregateId).toBe(eventOf(bus, 'meeting.created').aggregateId);
  });

  test('update: the pre-read is the flat row, so only the fields that changed are announced', async () => {
    const bus = recordingBus();
    const service = meetingService(bus);
    const created = await asA(() => service.create(meetingInput()));
    bus.published.length = 0;

    await asA(() => service.update(created.id, { title: 'retro' }));
    expect(typesOf(bus)).toEqual(['communication.updated', 'meeting.field_changed', 'meeting.updated']);
    expect(eventOf(bus, 'meeting.field_changed').payload.fieldName).toBe('title');
    expect(eventOf(bus, 'communication.updated').payload.snapshot.title).toBeUndefined();

    bus.published.length = 0;
    await asA(() => service.update(created.id, { occurredAt: new Date('2026-09-09T00:00:00Z') }));
    expect(typesOf(bus)).toEqual([
      'communication.field_changed',
      'communication.updated',
      'meeting.field_changed',
      'meeting.updated',
    ]);
    expect(eventOf(bus, 'communication.field_changed').payload.fieldName).toBe('occurredAt');
  });

  test('upsert: created / updated from the flag, under both names, no per-field events', async () => {
    const bus = recordingBus();
    const service = meetingService(bus);
    await asA(() => service.upsertByNaturalKey(meetingInput()));
    expect(typesOf(bus)).toEqual(['communication.created', 'meeting.created']);
    bus.published.length = 0;
    await asA(() => service.upsertByNaturalKey(meetingInput({ title: 'again' })));
    expect(typesOf(bus)).toEqual(['communication.updated', 'meeting.updated']);
  });

  test('delete: an id that is another kind\'s row emits nothing, and the row is untouched', async () => {
    const bus = recordingBus();
    const email = await asA(() => emailRepo().create({ ...meetingInput({ externalId: 'ext-mail' }), subject: 'hi' } as any));
    await asA(() => meetingService(bus).delete(email.id));
    expect(bus.published).toEqual([]);
    expect(await count('communications', `id = '${email.id}'`)).toBe(1);
    expect(await count('emails', `id = '${email.id}'`)).toBe(1);
  });

  test('delete: both names; a delete through the BASE emits the base name only', async () => {
    const bus = recordingBus();
    const service = meetingService(bus);
    const first = await asA(() => service.create(meetingInput()));
    bus.published.length = 0;
    await asA(() => service.delete(first.id));
    expect(typesOf(bus)).toEqual(['communication.deleted', 'meeting.deleted']);

    const second = await asA(() => service.create(meetingInput({ externalId: 'ext-2' })));
    bus.published.length = 0;
    const baseService = new CommunicationService(commRepo());
    (baseService as any).eventBus = bus;
    await asA(() => baseService.delete(second.id));
    expect(typesOf(bus)).toEqual(['communication.deleted']);
  });
});

d('the base guards (RFC-0006 §4.1)', () => {
  const baseInput = (over: Record<string, unknown> = {}) => ({
    occurredAt: new Date('2026-01-03T00:00:00Z'),
    source: 'src',
    externalId: 'ext-base',
    ...over,
  });

  test('the base service refuses a kind that has a child table, naming the child\'s create path', async () => {
    const service = new CommunicationService(commRepo());
    const err: any = await asA(() => service.create(baseInput({ kind: 'meeting' }))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errors.KindRequiresChildError);
    expect(err.createPath).toBe('MeetingService.create');
    await expect(asA(() => service.upsertByNaturalKey(baseInput({ kind: 'email' })))).rejects.toBeInstanceOf(
      errors.KindRequiresChildError,
    );
    expect(await count('communications')).toBe(0);
  });

  test('a base-only kind creates and upserts normally', async () => {
    const service = new CommunicationService(commRepo());
    const created = await asA(() => service.create(baseInput({ kind: 'message' })));
    expect(created.kind).toBe('message');
    const upserted = await asA(() => service.upsertByNaturalKey(baseInput({ kind: 'message', externalId: 'ext-m2' })));
    expect(upserted.created).toBe(true);
    const again = await asA(() => service.upsertByNaturalKey(baseInput({ kind: 'message', externalId: 'ext-m2' })));
    expect(again.created).toBe(false);
    expect(await count('communications', `kind = 'message'`)).toBe(2);
  });

  test('a base upsert onto a row of another kind is refused too', async () => {
    await asA(() => meetingRepo().create(meetingInput()));
    await expect(
      asA(() => commRepo().upsertByNaturalKey(baseInput({ kind: 'message', externalId: 'ext-1' }))),
    ).rejects.toBeInstanceOf(errors.KindMismatchError);
  });

  test('the base repository refuses a kind key on update', async () => {
    const message = await asA(() => commRepo().create({ ...baseInput({ kind: 'message' }) }));
    await expect(asA(() => commRepo().update(message.id, { kind: 'email' }))).rejects.toBeInstanceOf(
      errors.KindImmutableError,
    );
    // A base field updates through the base for any kind.
    const meeting = await asA(() => meetingRepo().create(meetingInput({ externalId: 'ext-9' })));
    const renamed = await asA(() => commRepo().update(meeting.id, { source: 'other' }));
    expect(renamed.source).toBe('other');
  });

  test('a delete through the base cascades to the child', async () => {
    const meeting = await asA(() => meetingRepo().create(meetingInput()));
    await asA(() => commRepo().delete(meeting.id));
    expect(await count('meetings')).toBe(0);
  });
});

d('the emitted SQL (RFC-0006 §4.2)', () => {
  /** A client that records every statement it is handed. */
  async function recordingDb() {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { relations } = await import('@gen/generated/relations');
    const { scaffoldDatabaseUrl } = await import('../harness-env');
    const pool = new Pool({ connectionString: scaffoldDatabaseUrl() });
    const statements: string[] = [];
    const record = (first: any) =>
      statements.push(String(typeof first === 'string' ? first : first.text).replace(/\s+/g, ' ').trim());
    // A transaction runs on a client checked out of the pool, so both are wrapped.
    const poolQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    (pool as any).query = (...args: unknown[]) => {
      record(args[0]);
      return poolQuery(...args);
    };
    const connect = pool.connect.bind(pool) as () => Promise<any>;
    (pool as any).connect = async () => {
      const client = await connect();
      const clientQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = (...args: unknown[]) => {
        record(args[0]);
        return clientQuery(...args);
      };
      return client;
    };
    return { db: drizzle({ client: pool, relations }), statements, end: () => pool.end() };
  }

  test('the pair upsert is two statements in one transaction; the base one is ON CONFLICT on the tenant-prefixed key', async () => {
    const recorder = await recordingDb();
    try {
      const commRepoOnRecorder = new CommunicationRepository(recorder.db);
      const repo = new MeetingRepository(recorder.db, commRepoOnRecorder);
      await asA(() => repo.upsertByNaturalKey(meetingInput()));
      const [begin, baseUpsert, childUpsert, commit] = recorder.statements;
      expect(begin).toBe('begin');
      expect(commit).toBe('commit');
      expect(recorder.statements).toHaveLength(4);
      expect(baseUpsert).toMatch(/^insert into "communications" \(/);
      expect(baseUpsert).toContain('on conflict ("tenant_id","source","external_id") do update set');
      expect(baseUpsert).toContain('where "communications"."kind" = excluded."kind"');
      expect(baseUpsert).toContain('returning');
      expect(baseUpsert).toContain('(xmax = 0)');
      // `SET` never rewrites the key, the kind, the tenant or created_at.
      const set = baseUpsert!.slice(baseUpsert!.indexOf('do update set'), baseUpsert!.indexOf(' where '));
      for (const column of ['"id" =', '"kind" =', '"tenant_id" =', '"source" =', '"external_id" =', '"created_at" =']) {
        expect(set).not.toContain(column);
      }
      expect(set).toContain('"updated_at" =');
      expect(childUpsert).toMatch(/^insert into "meetings" \(/);
      expect(childUpsert).toContain('on conflict ("id") do update set');
      if (process.env.SHOW_SQL) console.log(`\n${baseUpsert}\n${childUpsert}\n`);
    } finally {
      await recorder.end();
    }
  });
});

d('A6 — a guard that refuses an update leaves nothing half written', () => {
  test('a swallowed base guard error (a re-parent into another tenant) leaves the child row untouched, and the transaction commits', async () => {
    const created = await asA(() => meetingRepo().create(meetingInput()));
    await asA(() =>
      db().transaction(async (tx: any) => {
        const refused = await meetingRepo()
          .update(created.id, { title: 'half written', tenantId: TENANT_B }, tx)
          .catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(Error);
        await commRepo().create({ occurredAt: new Date(), source: 'src', externalId: 'ext-after', kind: 'message' }, tx);
      }),
    );
    expect(await count('meetings', `id = '${created.id}' AND title = 'standup'`)).toBe(1);
    expect(await count('communications', `external_id = 'ext-after'`)).toBe(1);
  });
});

d('A7 — repairing an orphan base row', () => {
  test('the child is created under an updated base: created is the child\'s, baseCreated the base\'s, and the events say so', async () => {
    // A base row of a kind that has a child table, with no child row: what the database allows (RFC-0006 §2.2).
    await db().execute(sql`INSERT INTO communications (id, tenant_id, kind, occurred_at, source, external_id)
                           VALUES (${ids.orphan}, ${TENANT_A}, 'meeting', now(), 'src', 'ext-1')`);
    const bus = recordingBus();
    const service = meetingService(bus);
    const result = await asA(() => service.upsertByNaturalKey(meetingInput()));
    expect(result.row.id).toBe(ids.orphan);
    expect(result.created).toBe(true);
    expect(result.baseCreated).toBe(false);
    expect(await count('meetings', `id = '${ids.orphan}'`)).toBe(1);
    expect(typesOf(bus)).toEqual(['communication.updated', 'meeting.created']);
  });
});

let CatalogEntryRepository: any;
const USER_B = '44444444-4444-4444-8444-444444444444';
const asUser = <T>(tenantId: string, userId: string, fn: () => Promise<T>): Promise<T> =>
  withRequester({ userId, organizationId: null, tenantId }, fn);
const entry = (userId: string, over: Record<string, unknown> = {}) => ({ sku: 'sku-1', title: 'first', userId, ...over });

d('#780 — upsertByNaturalKey on a plain natural_key entity (tenant-scoped, soft-deletable, user-tracked)', () => {
  beforeAll(async () => {
    if (!SHOULD_RUN_SCAFFOLD) return;
    ({ CatalogEntryRepository } = await import('@gen/modules/catalog-entries/catalog-entry.repository'));
  });
  const repo = () => new CatalogEntryRepository(db());
  const asOwner = <T>(fn: () => Promise<T>) => asUser(TENANT_A, USER, fn);
  const asOther = <T>(fn: () => Promise<T>) => asUser(TENANT_A, USER_B, fn);

  test('insert, then update on conflict: one row, created true then false, the carried columns written', async () => {
    const first = await asOwner(() => repo().upsertByNaturalKey(entry(USER)));
    expect(first.created).toBe(true);
    const second = await asOwner(() => repo().upsertByNaturalKey(entry(USER, { title: 'second', priceCents: 5 })));
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await count('catalog_entries')).toBe(1);
    expect(await count('catalog_entries', `title = 'second' AND price_cents = 5`)).toBe(1);
  });

  test('a soft-deleted match is updated and stays deleted (OQ-14)', async () => {
    const first = await asOwner(() => repo().upsertByNaturalKey(entry(USER)));
    await asOwner(() => repo().delete(first.row.id));
    const again = await asOwner(() => repo().upsertByNaturalKey(entry(USER, { title: 'edited' })));
    expect(again.created).toBe(false);
    expect(await count('catalog_entries', `id = '${first.row.id}' AND title = 'edited' AND deleted_at IS NOT NULL`)).toBe(1);
    expect(await count('catalog_entries')).toBe(1);
  });

  test('another user\'s row in the same tenant is never overwritten: the call is refused and the row is untouched', async () => {
    await asOwner(() => repo().upsertByNaturalKey(entry(USER)));
    await expect(asOther(() => repo().upsertByNaturalKey(entry(USER_B, { title: 'hijacked' })))).rejects.toBeInstanceOf(
      errors.OutOfScopeWriteError,
    );
    expect(await count('catalog_entries', `title = 'first' AND user_id = '${USER}'`)).toBe(1);
    expect(await count('catalog_entries')).toBe(1);
  });

  test('the owner\'s own upsert never rewrites the user column', async () => {
    await asOwner(() => repo().upsertByNaturalKey(entry(USER)));
    await asOwner(() => repo().upsertByNaturalKey(entry(USER, { userId: USER_B, title: 'again' })));
    expect(await count('catalog_entries', `title = 'again' AND user_id = '${USER}'`)).toBe(1);
  });

  test('another tenant\'s same key is its own row', async () => {
    await asOwner(() => repo().upsertByNaturalKey(entry(USER)));
    const b = await asUser(TENANT_B, USER, () => repo().upsertByNaturalKey(entry(USER, { title: 'b' })));
    expect(b.created).toBe(true);
    expect(await count('catalog_entries')).toBe(2);
  });
});
