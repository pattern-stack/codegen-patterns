/**
 * CAP-3 — `WithCommunication` / `WithActor` against real Postgres.
 *
 * The repositories below extend the REAL runtime bases and mixins and carry the
 * config literal codegen emits for the capability smoke's fixture (the smoke
 * proves that literal type-checks against the mixin; this proves the SQL):
 *
 *   meeting  patterns: [Activity, Communication]
 *            roles: host (one → contact), attendees (many via junction → contact),
 *                   about (one → account)
 *   contact  Actor: individual
 *   account  Actor: group, members: its has_many contacts
 *
 * The meeting repository is `userTracking` + `strict`, so every read needs an
 * ambient requester (ADR-042) and a second user must see nothing (charter I3).
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import type * as Schema from '../schema';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type CapMeeting = typeof Schema.capMeetings.$inferSelect;
type CapContact = typeof Schema.capContacts.$inferSelect;
type CapAccount = typeof Schema.capAccounts.$inferSelect;
type Row = { id: string };

type Setup = typeof import('./setup');

// The repositories are declared inside `beforeAll` (their tables come from a
// dynamic import — `../schema` needs the generated scaffold), so they are
// untyped here, as in the other scaffold suites.
let meetingRepo: any;
let contactRepo: any;
let accountRepo: any;
let withUserScope: typeof import('../../../runtime/base-classes/tenant-context')['withUserScope'];
let schema: typeof Schema;
let db: ReturnType<Setup['getTestDb']>;
let truncateAll: Setup['truncateAll'];
let closeDb: Setup['closeDb'];

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  // The RUNTIME classes, by path. `@shared/base-classes/base-repository`
  // resolves scaffold-first to a hand-written stub with a drifted contract (see
  // its header, #603) that has no `scopeAnd` / `col` for a mixin to use.
  const { ActivityEntityRepository } = await import('../../../runtime/base-classes/activity-entity-repository');
  const { BaseRepository } = await import('../../../runtime/base-classes/base-repository');
  const { WithCommunication } = await import('../../../runtime/base-classes/with-communication');
  const { WithActor } = await import('../../../runtime/base-classes/with-actor');
  ({ withUserScope } = await import('../../../runtime/base-classes/tenant-context'));
  schema = await import('../schema');
  const setup = await import('./setup');
  ({ truncateAll, closeDb } = setup);
  db = setup.getTestDb();
  const { capMeetings, capContacts, capAccounts, capMeetingContacts } = schema;

  class MeetingRepository extends WithCommunication(ActivityEntityRepository<CapMeeting, typeof capMeetings>) {
    readonly table = capMeetings;
    protected override readonly behaviors = { timestamps: true, softDelete: false, userTracking: true };
    protected override readonly scopeEnforcement = 'strict' as const;
    override readonly communicationConfig = {
      roles: {
        host: { cardinality: 'one', target: 'contact', column: 'hostContactId' },
        attendees: {
          cardinality: 'many',
          target: 'contact',
          via: { table: capMeetingContacts, self: 'capMeetingId', target: 'capContactId' },
        },
        about: { cardinality: 'one', target: 'account', column: 'aboutAccountId' },
      },
    } as const;
  }

  class ContactRepository extends WithActor(BaseRepository<CapContact, typeof capContacts>) {
    readonly table = capContacts;
    override readonly actorConfig = { kind: 'individual' } as const;
  }

  class AccountRepository extends WithActor(BaseRepository<CapAccount, typeof capAccounts>) {
    readonly table = capAccounts;
    override readonly actorConfig = {
      kind: 'group',
      members: { table: capContacts, foreignKey: 'capAccountId' },
    } as const;
  }

  meetingRepo = new MeetingRepository(db);
  contactRepo = new ContactRepository(db);
  accountRepo = new AccountRepository(db);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

const ALICE = 'user-alice';
const BOB = 'user-bob';
const asAlice = <T>(fn: () => Promise<T>) => withUserScope(ALICE, null, fn);
const asBob = <T>(fn: () => Promise<T>) => withUserScope(BOB, null, fn);

/** acme (group) ⊃ {ann, ben}; cat is on her own. One meeting, owned by Alice. */
async function seed() {
  const acme = await accountRepo.create({ name: 'Acme' });
  const other = await accountRepo.create({ name: 'Other' });
  const ann = await contactRepo.create({ email: 'ann@acme.test', capAccountId: acme.id });
  const ben = await contactRepo.create({ email: 'ben@acme.test', capAccountId: acme.id });
  const cat = await contactRepo.create({ email: 'cat@solo.test', capAccountId: null });
  const meeting = await asAlice(() =>
    meetingRepo.create({
      userId: ALICE,
      title: 'Kickoff',
      hostContactId: ann.id,
      aboutAccountId: acme.id,
    }),
  );
  await db.insert(schema.capMeetingContacts).values([
    { capMeetingId: meeting.id, capContactId: ben.id },
    { capMeetingId: meeting.id, capContactId: cat.id },
  ]);
  return { acme, other, ann, ben, cat, meeting };
}

d('WithCommunication.findByRole', () => {
  test("many-role: findByRole('attendees', contactId) returns the meeting", async () => {
    const { ben, cat, ann, meeting } = await seed();
    for (const attendee of [ben, cat]) {
      const found = await asAlice(() => meetingRepo.findByRole('attendees', attendee.id));
      expect(found.map((m: Row) => m.id)).toEqual([meeting.id]);
    }
    // The host is not an attendee.
    expect(await asAlice(() => meetingRepo.findByRole('attendees', ann.id))).toEqual([]);
  });

  test("one-role: findByRole('host', contactId) returns the meeting", async () => {
    const { ann, ben, acme, meeting } = await seed();
    const hosted = await asAlice(() => meetingRepo.findByRole('host', ann.id));
    expect(hosted.map((m: Row) => m.id)).toEqual([meeting.id]);
    expect(await asAlice(() => meetingRepo.findByRole('host', ben.id))).toEqual([]);
    const about = await asAlice(() => meetingRepo.findByRole('about', acme.id));
    expect(about.map((m: Row) => m.id)).toEqual([meeting.id]);
  });

  test('a second scope sees nothing (charter I3)', async () => {
    const { ann, ben } = await seed();
    expect(await asBob(() => meetingRepo.findByRole('attendees', ben.id))).toEqual([]);
    expect(await asBob(() => meetingRepo.findByRole('host', ann.id))).toEqual([]);
  });

  test('no ambient scope on a strict repository throws — it never reads unscoped', async () => {
    const { ann } = await seed();
    await expect(meetingRepo.findByRole('host', ann.id)).rejects.toThrow(/No requester context/);
  });

  test('an undeclared role throws', async () => {
    const { ann } = await seed();
    await expect(asAlice(() => meetingRepo.findByRole('organizer', ann.id))).rejects.toThrow(
      /no role 'organizer'/,
    );
  });
});

d('WithCommunication.participants', () => {
  test('every role, as ids, in one statement', async () => {
    const { ann, ben, cat, acme, meeting } = await seed();
    const participants = await asAlice(() => meetingRepo.participants(meeting.id));
    const key = (p: { role: string; id: string }) => `${p.role}:${p.id}`;
    expect(participants.map(key).sort()).toEqual(
      [
        `about:${acme.id}`,
        `attendees:${ben.id}`,
        `attendees:${cat.id}`,
        `host:${ann.id}`,
      ].sort(),
    );
    expect(participants.find((p: { role: string }) => p.role === 'about')).toEqual({
      role: 'about',
      target: 'account',
      id: acme.id,
    });
  });

  test('an unset one-role contributes nothing', async () => {
    const { meeting } = await seed();
    await asAlice(() => meetingRepo.update(meeting.id, { hostContactId: null }));
    const participants = await asAlice(() => meetingRepo.participants(meeting.id));
    expect(participants.some((p: { role: string }) => p.role === 'host')).toBe(false);
  });

  test('a second scope sees no participants — from any branch (charter I3)', async () => {
    const { meeting } = await seed();
    expect(await asBob(() => meetingRepo.participants(meeting.id))).toEqual([]);
  });
});

d('WithActor.memberPredicate', () => {
  test('group: the accounts a contact belongs to', async () => {
    const { acme, ben, cat } = await seed();
    const ofBen = await accountRepo.list({ where: accountRepo.memberPredicate(ben.id) });
    expect(ofBen.map((a: Row) => a.id)).toEqual([acme.id]);
    expect(await accountRepo.list({ where: accountRepo.memberPredicate(cat.id) })).toEqual([]);
  });

  test('individual: the identity predicate', async () => {
    const { ann } = await seed();
    const self = await contactRepo.list({ where: contactRepo.memberPredicate(ann.id) });
    expect(self.map((c: Row) => c.id)).toEqual([ann.id]);
  });
});
