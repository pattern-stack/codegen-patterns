/**
 * RFC-0006 §4.2 / S7b (#917) — an Integrated child's repository writes and reads THROUGH its base, against real
 * Postgres. `mail_message` and `calendar_event` are `pattern: Integrated` children of `inbox_item`, which owns
 * `external_id` / `provider` and the one `(tenant, provider, external_id)` unique.
 *
 * Every call is the one the generated sink makes on a plain entity — `integrationUpsertOne`,
 * `findByExternalIdProjected`, `softDeleteByExternalId` — so a child cannot be told from one. Rows are read back with
 * raw SQL, past every repository.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import 'reflect-metadata';
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let sql: any;
let withRequester: any;
let errors: any;
let InboxItemRepository: any;
let MailMessageRepository: any;
let CalendarEventRepository: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
  ({ withRequester } = await import('@shared/base-classes/tenant-context'));
  errors = await import('@shared/base-classes/inheritance');
  ({ InboxItemRepository } = await import('@gen/modules/inbox-items/inbox-item.repository'));
  ({ MailMessageRepository } = await import('@gen/modules/mail-messages/mail-message.repository'));
  ({ CalendarEventRepository } = await import('@gen/modules/calendar-events/calendar-event.repository'));
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

const db = () => getTestDb();
const rows = async (statement: string): Promise<any[]> => (await db().execute(sql.raw(statement))).rows;
const count = async (table: string, where = 'true') =>
  Number((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n);

const inboxRepo = () => new InboxItemRepository(db());
// The fixture's sink excludes `title` from the write (S7a, `exclude_fields`) while the base requires it, so a write
// here widens the write columns by it — the one deviation from the generated config.
const withTitle = <T>(repo: T): T => {
  const r = repo as any;
  r.integrationConfig = { ...r.integrationConfig, writeColumns: [...r.integrationConfig.writeColumns, 'title'] };
  return repo;
};
const mailRepo = () => withTitle(new MailMessageRepository(db(), inboxRepo()));
const calRepo = () => withTitle(new CalendarEventRepository(db(), inboxRepo()));

const mailWrite = (over: Record<string, unknown> = {}) => ({
  externalId: 'ext-1',
  title: 'hello',
  subject: 'hello',
  sentAt: new Date('2026-01-03T09:00:00Z'),
  ...over,
});
const calWrite = (over: Record<string, unknown> = {}) => ({
  externalId: 'ext-1',
  title: 'standup',
  startsAt: new Date('2026-01-03T09:00:00Z'),
  endsAt: null,
  ...over,
});

d('integrationUpsertOne on an Integrated child', () => {
  test('creates the pair, then updates it in place; the identity lives on the base row only', async () => {
    const created = await asA(() => mailRepo().integrationUpsertOne(mailWrite(), 'google'));
    expect(created.externalId).toBe('ext-1');
    expect(created.title).toBe('hello');
    expect(created.tenantId).toBe(TENANT_A);
    expect(await count('inbox_items', `id = '${created.id}' AND kind = 'mail_message' AND provider = 'google' AND external_id = 'ext-1'`)).toBe(1);
    expect(await count('mail_messages', `id = '${created.id}' AND subject = 'hello'`)).toBe(1);
    // the child table has no identity columns at all
    expect(await count('information_schema.columns', `table_name = 'mail_messages' AND column_name IN ('external_id', 'provider', 'provider_metadata')`)).toBe(0);

    const again = await asA(() => mailRepo().integrationUpsertOne(mailWrite({ subject: 'edited', title: 'edited' }), 'google'));
    expect(again.id).toBe(created.id);
    expect(await count('inbox_items')).toBe(1);
    expect(await count('mail_messages')).toBe(1);
    expect((await rows(`SELECT subject FROM mail_messages`))[0].subject).toBe('edited');
    expect((await rows(`SELECT title FROM inbox_items`))[0].title).toBe('edited');
  });

  test('the same external id under the other child is KindMismatchError and writes nothing', async () => {
    await asA(() => calRepo().integrationUpsertOne(calWrite(), 'google'));
    await expect(asA(() => mailRepo().integrationUpsertOne(mailWrite(), 'google'))).rejects.toBeInstanceOf(errors.KindMismatchError);
    expect(await count('mail_messages')).toBe(0);
    expect(await count('inbox_items', `kind = 'calendar_event'`)).toBe(1);
    expect((await rows(`SELECT title FROM inbox_items`))[0].title).toBe('standup');
  });

  test('an orphan base row (a mail_message kind with no child row) is repaired', async () => {
    await db().execute(
      sql`INSERT INTO inbox_items (id, tenant_id, kind, title, provider, external_id) VALUES ('a0000000-0000-4000-8000-0000000000aa', ${TENANT_A}, 'mail_message', 'orphan', 'google', 'ext-1')`,
    );
    const repaired = await asA(() => mailRepo().integrationUpsertOne(mailWrite(), 'google'));
    expect(repaired.id).toBe('a0000000-0000-4000-8000-0000000000aa');
    expect(await count('inbox_items')).toBe(1);
    expect(await count('mail_messages', `id = '${repaired.id}'`)).toBe(1);
  });
});

d('the reads forward to the base, scoped to the child kind', () => {
  test('findByExternalIdProjected / findByExternalId / findManyByExternalIds', async () => {
    const mail = await asA(() => mailRepo().integrationUpsertOne(mailWrite(), 'google'));
    await asA(() => calRepo().integrationUpsertOne(calWrite({ externalId: 'ext-2' }), 'google'));

    const projected = await asA(() => mailRepo().findByExternalIdProjected('ext-1', 'google'));
    expect(projected).toEqual(mail);
    expect(await asA(() => mailRepo().findByExternalIdProjected('ext-1', 'other-provider'))).toBeNull();
    // ext-2 is a calendar_event: no row of THIS kind
    expect(await asA(() => mailRepo().findByExternalIdProjected('ext-2', 'google'))).toBeNull();

    const flat = await asA(() => mailRepo().findByExternalId('ext-1'));
    expect(flat?.subject).toBe('hello');
    expect(flat?.title).toBe('hello');
    expect(await asA(() => mailRepo().findByExternalId('ext-2'))).toBeNull();
    expect((await asA(() => mailRepo().findManyByExternalIds(['ext-1', 'ext-2']))).map((r: any) => r.id)).toEqual([mail.id]);
    expect(await asA(() => mailRepo().findManyByExternalIds([]))).toEqual([]);
  });

  test("another tenant's row is never found", async () => {
    await asA(() => mailRepo().integrationUpsertOne(mailWrite(), 'google'));
    expect(await asTenant(TENANT_B, () => mailRepo().findByExternalIdProjected('ext-1', 'google'))).toBeNull();
  });
});

d('the tombstone acts on the base row, only for this kind (D4)', () => {
  test('calendar_event (delete: soft): soft-deletes the base row; the differ still sees it, plain reads do not', async () => {
    const cal = await asA(() => calRepo().integrationUpsertOne(calWrite(), 'google'));
    expect(await asA(() => calRepo().softDeleteByExternalId('ext-1', 'google'))).toEqual({ id: cal.id });
    expect(await count('inbox_items', `id = '${cal.id}' AND deleted_at IS NOT NULL AND external_id = 'ext-1'`)).toBe(1);
    expect(await count('calendar_events')).toBe(1);
    expect((await asA(() => calRepo().findByExternalIdProjected('ext-1', 'google')))?.id).toBe(cal.id);
    expect(await asA(() => calRepo().findByExternalId('ext-1'))).toBeNull();
  });

  test('mail_message (delete: tombstone): nulls provider / external_id on the base row; the pair is detached and the child stays', async () => {
    const mail = await asA(() => mailRepo().integrationUpsertOne(mailWrite(), 'google'));
    expect(await asA(() => mailRepo().softDeleteByExternalId('ext-1', 'google'))).toEqual({ id: mail.id });
    expect(await count('inbox_items', `id = '${mail.id}' AND provider IS NULL AND external_id IS NULL AND deleted_at IS NULL`)).toBe(1);
    expect(await count('mail_messages', `id = '${mail.id}'`)).toBe(1);
    expect(await asA(() => mailRepo().findByExternalIdProjected('ext-1', 'google'))).toBeNull();
  });

  test("an id held by calendar_event, tombstoned through mail_message, touches nothing", async () => {
    const cal = await asA(() => calRepo().integrationUpsertOne(calWrite(), 'google'));
    expect(await asA(() => mailRepo().softDeleteByExternalId('ext-1', 'google'))).toBeNull();
    expect(await count('inbox_items', `id = '${cal.id}' AND deleted_at IS NULL AND external_id = 'ext-1'`)).toBe(1);
    // and through its own kind it does
    expect(await asA(() => calRepo().softDeleteByExternalId('ext-1', 'google'))).toEqual({ id: cal.id });
  });
});

d('upsertByNaturalKey refuses a NULL natural-key value (the base, directly)', () => {
  test('a null provider or an absent external id throws NaturalKeyNullError before any statement', async () => {
    await expect(
      asA(() => inboxRepo().upsertByNaturalKey({ kind: 'note', title: 'x', provider: null, externalId: 'e' })),
    ).rejects.toBeInstanceOf(errors.NaturalKeyNullError);
    await expect(
      asA(() => inboxRepo().upsertByNaturalKey({ kind: 'note', title: 'x', provider: 'p' })),
    ).rejects.toBeInstanceOf(errors.NaturalKeyNullError);
    expect(await count('inbox_items')).toBe(0);
  });

  test('base-only rows with no identity do not collide (NULLs stay distinct in the one unique)', async () => {
    await asA(() => inboxRepo().create({ kind: 'note', title: 'a' }));
    await asA(() => inboxRepo().create({ kind: 'note', title: 'b' }));
    expect(await count('inbox_items', `provider IS NULL`)).toBe(2);
  });
});
