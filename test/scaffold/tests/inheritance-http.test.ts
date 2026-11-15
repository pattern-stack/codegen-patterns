/**
 * RFC-0006 / #875 S5 — the HTTP surface of a joined-table family: flat child DTOs and routes, the base's
 * restricted create, and the three domain errors as HTTP answers (acceptance A10, and the rest of A2).
 *
 * It mounts the GENERATED `MeetingsModule`, `CommunicationsModule`, `CommunicationPartsModule` and
 * `CommunicationNotesModule` as emitted, behind a boundary that installs the requester context from a header
 * (the one `inheritance-scope-http.test.ts` uses). Rows are read back with raw SQL, bypassing every repository,
 * so what a route left in the tables is asserted, not what a read path chose to show.
 *
 * The error mapping is tested through the GENERATED controllers with stub use cases: no request body can reach
 * `KindImmutableError` / `KindRequiresChildError` once the DTOs refuse the key (that is the point of the flat DTOs),
 * so the only way to prove the mapping is to make the use case throw.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const NO_SUCH = 'f0000000-0000-4000-8000-0000000000ff';

let Test: any;
let supertest: any;
let truncateAll: any;
let closeDb: any;
let getTestDb: any;
let sql: any;
let app: any;
let request: any;
let errors: any;
let gen: any;

/** An app that mounts the given generated modules behind the tenant boundary. */
async function mount(modules: any[], overrides: Array<{ provide: any; useValue: any }> = [], controllers: any[] = []) {
  const { withRequester } = await import('@shared/base-classes/tenant-context');
  const { OPENAPI_REGISTRY, OpenApiRegistry } = await import('@shared/openapi');
  const { DatabaseModule } = await import('../shared/database/database.module');

  @Global()
  @Module({
    providers: [{ provide: OPENAPI_REGISTRY, useFactory: () => new OpenApiRegistry() }],
    exports: [OPENAPI_REGISTRY],
  })
  class OpenApiModule {}

  const moduleRef = await Test.createTestingModule(
    controllers.length > 0
      ? { controllers, providers: overrides }
      : { imports: [DatabaseModule, OpenApiModule, ...modules] },
  ).compile();
  const created = moduleRef.createNestApplication();
  created.use((req: any, _res: any, next: () => void) => {
    const tenant = req.headers['x-tenant-id'];
    if (typeof tenant !== 'string') return next();
    return withRequester({ userId: USER, organizationId: null, tenantId: tenant }, () => next());
  });
  await created.init();
  return created;
}

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ Test } = await import('@nestjs/testing'));
  supertest = (await import('supertest')).default;
  ({ truncateAll, closeDb, getTestDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
  errors = await import('@shared/base-classes/inheritance');
  gen = {
    MeetingsModule: (await import('@gen/modules/meetings/meetings.module')).MeetingsModule,
    CommunicationsModule: (await import('@gen/modules/communications/communications.module')).CommunicationsModule,
    CommunicationPartsModule: (await import('@gen/modules/communication-parts/communication-parts.module'))
      .CommunicationPartsModule,
    CommunicationNotesModule: (await import('@gen/modules/communication-notes/communication-notes.module'))
      .CommunicationNotesModule,
  };
  app = await mount([
    gen.MeetingsModule,
    gen.CommunicationsModule,
    gen.CommunicationPartsModule,
    gen.CommunicationNotesModule,
  ]);
  request = supertest(app.getHttpServer());
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await app?.close();
  await closeDb();
});

const rows = async (stmt: any) => (await getTestDb().execute(stmt)).rows as any[];
const at = (hour: number) => `2026-03-01T${String(hour).padStart(2, '0')}:00:00.000Z`;

const meetingBody = (over: Record<string, unknown> = {}) => ({
  occurredAt: at(10),
  source: 'cal',
  externalId: `ext-${Math.random().toString(36).slice(2)}`,
  title: 'standup',
  startsAt: at(10),
  ...over,
});

async function createMeeting(over: Record<string, unknown> = {}, tenant = TENANT_A) {
  const res = await request.post('/meetings').set('x-tenant-id', tenant).send(meetingBody(over));
  expect(res.status).toBe(201);
  return res.body;
}

d('a child over HTTP is flat (A10)', () => {
  test('POST /meetings with a flat body creates both rows and returns the flat shape', async () => {
    const body = await createMeeting({ title: 'planning', link: 'https://example.test/m' });
    expect(body).toMatchObject({
      kind: 'meeting',
      title: 'planning',
      link: 'https://example.test/m',
      source: 'cal',
      tenantId: TENANT_A,
    });
    // the base's columns and the child's, at one level — no nested `communication`
    expect(body.communication).toBeUndefined();
    expect(typeof body.occurredAt).toBe('string');
    expect(typeof body.createdAt).toBe('string');

    const base = await rows(sql`SELECT kind, tenant_id, source FROM communications WHERE id = ${body.id}`);
    const child = await rows(sql`SELECT title, tenant_id FROM meetings WHERE id = ${body.id}`);
    expect(base).toEqual([{ kind: 'meeting', tenant_id: TENANT_A, source: 'cal' }]);
    expect(child).toEqual([{ title: 'planning', tenant_id: TENANT_A }]);
  });

  test('GET /meetings/:id returns the flat row', async () => {
    const created = await createMeeting({ title: 'retro' });
    const res = await request.get(`/meetings/${created.id}`).set('x-tenant-id', TENANT_A).expect(200);
    expect(res.body).toMatchObject({ id: created.id, kind: 'meeting', title: 'retro', source: 'cal' });
    expect(res.body.communication).toBeUndefined();
    expect(res.body.occurredAt).toBe(created.occurredAt);
  });

  test('GET /meetings lists flat rows, sorted on a BASE column', async () => {
    await createMeeting({ title: 'noon', occurredAt: at(12) });
    await createMeeting({ title: 'dawn', occurredAt: at(6) });
    await createMeeting({ title: 'dusk', occurredAt: at(18) });

    const desc = await request.get('/meetings?sort_by=occurred_at&sort_order=desc').set('x-tenant-id', TENANT_A).expect(200);
    expect(desc.body.items.map((m: any) => m.title)).toEqual(['dusk', 'noon', 'dawn']);
    expect(desc.body.items.every((m: any) => m.kind === 'meeting' && m.source === 'cal')).toBe(true);
    expect(desc.body.total).toBe(3);

    const asc = await request.get('/meetings?sort_by=occurred_at&sort_order=asc').set('x-tenant-id', TENANT_A).expect(200);
    expect(asc.body.items.map((m: any) => m.title)).toEqual(['dawn', 'noon', 'dusk']);
  });

  test('the default list sort is the base`s created_at desc, and total counts this kind only', async () => {
    const first = await createMeeting({ title: 'first' });
    const second = await createMeeting({ title: 'second' });
    // a base-only row must not appear in, or count towards, the meetings list
    await request
      .post('/communications')
      .set('x-tenant-id', TENANT_A)
      .send({ kind: 'message', occurredAt: at(9), source: 'chat', externalId: 'm-1' })
      .expect(201);
    const res = await request.get('/meetings').set('x-tenant-id', TENANT_A).expect(200);
    expect(res.body.items.map((m: any) => m.id)).toEqual([second.id, first.id]);
    expect(res.body.total).toBe(2);
  });

  test('GET /meetings?include=transcripts: the allowlisted include rides the page, flat, with no base key', async () => {
    const m = await createMeeting({ title: 'with-transcript' });
    await createMeeting({ title: 'without' });
    await rows(sql`INSERT INTO meeting_transcripts (id, meeting_id) VALUES (${'b0000000-0000-4000-8000-000000000001'}, ${m.id})`);
    const res = await request.get('/meetings?include=transcripts').set('x-tenant-id', TENANT_A).expect(200);
    const item = res.body.items.find((i: any) => i.id === m.id);
    expect(item.kind).toBe('meeting');
    expect(item.transcripts).toHaveLength(1);
    expect(item.communication).toBeUndefined();
    expect(res.body.items.find((i: any) => i.title === 'without').transcripts).toEqual([]);
    // the by-id route has no allowlist entry, so the same include is refused there
    await request.get(`/meetings/${m.id}?include=transcripts`).set('x-tenant-id', TENANT_A).expect(400);
  });

  test('GET /meetings?sort_by=title orders on the CHILD column (it does not fall back to the default)', async () => {
    await createMeeting({ title: 'bravo' });
    await createMeeting({ title: 'alpha' });
    await createMeeting({ title: 'charlie' });
    const asc = await request.get('/meetings?sort_by=title&sort_order=asc').set('x-tenant-id', TENANT_A).expect(200);
    expect(asc.body.items.map((m: any) => m.title)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(asc.body.total).toBe(3);
    expect(asc.body.items[0]).toMatchObject({ kind: 'meeting', source: 'cal' });
    const desc = await request.get('/meetings?sort_by=title&sort_order=desc').set('x-tenant-id', TENANT_A).expect(200);
    expect(desc.body.items.map((m: any) => m.title)).toEqual(['charlie', 'bravo', 'alpha']);
  });

  test('a base-column sort_by together with a child filter is a 400, not another order (RFC-0006 §8)', async () => {
    await createMeeting({ title: 'quarterly review' });
    const { SearchMeetingsUseCase } = await import('@gen/modules/meetings/use-cases/search-meetings.use-case');
    const { withRequester } = await import('@shared/base-classes/tenant-context');
    const asA = (input: any) =>
      withRequester({ userId: USER, organizationId: null, tenantId: TENANT_A }, () => app.get(SearchMeetingsUseCase).execute(input));
    const err: any = await asA({ search: 'quarterly', sort_by: 'occurred_at' }).catch((e: any) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ statusCode: 400, error: 'Bad Request', code: 'sort_not_combinable' });
    expect(err.getResponse().message).toContain('occurred_at');
    // controls: the same filter sorted on a child column, or with no sort_by, is answered
    expect((await asA({ search: 'quarterly', sort_by: 'title' })).items).toHaveLength(1);
    expect((await asA({ search: 'quarterly' })).items).toHaveLength(1);
    // and a base-column sort with no filter is the base-rooted path, still 200
    await request.get('/meetings?sort_by=occurred_at').set('x-tenant-id', TENANT_A).expect(200);
  });

  test('an UNFILTERED child search is the plain list: its default order and a base-column sort, never a 400', async () => {
    const { SearchMeetingsUseCase } = await import('@gen/modules/meetings/use-cases/search-meetings.use-case');
    const { withRequester } = await import('@shared/base-classes/tenant-context');
    const asA = (input: any) =>
      withRequester({ userId: USER, organizationId: null, tenantId: TENANT_A }, () => app.get(SearchMeetingsUseCase).execute(input));
    await createMeeting({ title: 'first' });
    await createMeeting({ title: 'second' });
    await createMeeting({ title: 'third' });
    // no filter set: the same default order as GET /meetings (created_at desc, id desc), not `id desc`
    const listed = await request.get('/meetings').set('x-tenant-id', TENANT_A).expect(200);
    const searched = await asA({});
    expect(searched.items.map((m: any) => m.id)).toEqual(listed.body.items.map((m: any) => m.id));
    expect(searched.total).toBe(3);
    // a base-column sort with no filter is answered (it is the base-rooted read), not refused as "combined with a filter"
    const bySource = await asA({ sort_by: 'occurred_at' });
    expect(bySource.items).toHaveLength(3);
    // empty-string filters are not filters either
    expect((await asA({ search: '', sort_by: 'occurred_at' })).items).toHaveLength(3);
    // a filter on a column both tables carry sorts the child-rooted read: `id` is not "a column of communication"
    expect((await asA({ search: 'first', sort_by: 'id' })).items).toHaveLength(1);
  });

  test('a child search filters on its own column, flat, scoped to the tenant', async () => {
    await createMeeting({ title: 'quarterly review' });
    await createMeeting({ title: 'standup' });
    await createMeeting({ title: 'quarterly review (theirs)' }, TENANT_B);
    const { SearchMeetingsUseCase } = await import('@gen/modules/meetings/use-cases/search-meetings.use-case');
    const useCase = app.get(SearchMeetingsUseCase);
    const { withRequester } = await import('@shared/base-classes/tenant-context');
    const page = await withRequester({ userId: USER, organizationId: null, tenantId: TENANT_A }, () =>
      useCase.execute({ search: 'quarterly' }),
    );
    expect(page.items.map((m: any) => m.title)).toEqual(['quarterly review']);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ kind: 'meeting', source: 'cal' });
    expect(page.items[0].communication).toBeUndefined();
  });

  test('PATCH /meetings/:id updates both tables and returns the flat row', async () => {
    const created = await createMeeting({ title: 'before' });
    const baseBefore = (await rows(sql`SELECT updated_at FROM communications WHERE id = ${created.id}`))[0];
    await new Promise((r) => setTimeout(r, 15));

    const res = await request
      .patch(`/meetings/${created.id}`)
      .set('x-tenant-id', TENANT_A)
      .send({ title: 'after', source: 'cal-2' })
      .expect(200);
    expect(res.body).toMatchObject({ id: created.id, kind: 'meeting', title: 'after', source: 'cal-2' });

    expect(await rows(sql`SELECT title FROM meetings WHERE id = ${created.id}`)).toEqual([{ title: 'after' }]);
    const baseAfter = (await rows(sql`SELECT source, updated_at FROM communications WHERE id = ${created.id}`))[0];
    expect(baseAfter.source).toBe('cal-2');
    expect(new Date(baseAfter.updated_at).getTime()).toBeGreaterThan(new Date(baseBefore.updated_at).getTime());
  });

  test('PATCH of an absent id is a 404', async () => {
    await request.patch(`/meetings/${NO_SUCH}`).set('x-tenant-id', TENANT_A).send({ title: 'x' }).expect(404);
  });

  test('DELETE /meetings/:id removes both rows', async () => {
    const created = await createMeeting();
    await request.delete(`/meetings/${created.id}`).set('x-tenant-id', TENANT_A).expect(200);
    expect(await rows(sql`SELECT id FROM meetings WHERE id = ${created.id}`)).toEqual([]);
    expect(await rows(sql`SELECT id FROM communications WHERE id = ${created.id}`)).toEqual([]);
    await request.get(`/meetings/${created.id}`).set('x-tenant-id', TENANT_A).expect(404);
  });

  test('another tenant`s meeting cannot be patched or deleted through the route', async () => {
    const theirs = await createMeeting({ title: 'theirs' }, TENANT_B);
    await request.patch(`/meetings/${theirs.id}`).set('x-tenant-id', TENANT_A).send({ title: 'mine' }).expect(404);
    await request.delete(`/meetings/${theirs.id}`).set('x-tenant-id', TENANT_A);
    // whatever the delete answered, both rows are still there
    expect(await rows(sql`SELECT title FROM meetings WHERE id = ${theirs.id}`)).toEqual([{ title: 'theirs' }]);
    expect(await rows(sql`SELECT id FROM communications WHERE id = ${theirs.id}`)).toHaveLength(1);
  });
});

d('a body cannot set what the server owns', () => {
  // Unknown keys are stripped, as for every DTO: the property that matters is that the key sets NOTHING.
  test('POST /meetings: a kind or tenant column in the body sets nothing', async () => {
    const res = await request
      .post('/meetings')
      .set('x-tenant-id', TENANT_A)
      .send(meetingBody({ kind: 'email', tenantId: TENANT_B }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'meeting', tenantId: TENANT_A });
    expect(await rows(sql`SELECT kind, tenant_id FROM communications WHERE id = ${res.body.id}`)).toEqual([
      { kind: 'meeting', tenant_id: TENANT_A },
    ]);
    expect(await rows(sql`SELECT tenant_id FROM meetings WHERE id = ${res.body.id}`)).toEqual([{ tenant_id: TENANT_A }]);
  });

  test('PATCH /meetings/:id: a kind or tenant column in the body changes nothing', async () => {
    const created = await createMeeting({ title: 'keep' });
    const res = await request
      .patch(`/meetings/${created.id}`)
      .set('x-tenant-id', TENANT_A)
      .send({ title: 'changed', kind: 'email', tenantId: TENANT_B });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'meeting', tenantId: TENANT_A, title: 'changed' });
    expect(await rows(sql`SELECT kind, tenant_id FROM communications WHERE id = ${created.id}`)).toEqual([
      { kind: 'meeting', tenant_id: TENANT_A },
    ]);
    expect(await rows(sql`SELECT tenant_id FROM meetings WHERE id = ${created.id}`)).toEqual([{ tenant_id: TENANT_A }]);
  });

  test('a derived match: column is never client input (communication_note.communication_kind)', async () => {
    const meeting = await createMeeting({ title: 'noted' });
    const res = await request
      .post('/communication_notes')
      .set('x-tenant-id', TENANT_A)
      .send({ body: 'hello', communicationId: meeting.id, communicationKind: 'email' });
    expect(res.status).toBe(201);
    // the column follows the foreign key: the meeting's kind, whatever the body said
    expect(await rows(sql`SELECT communication_kind FROM communication_notes WHERE id = ${res.body.id}`)).toEqual([
      { communication_kind: 'meeting' },
    ]);
  });
});

d('the base`s create takes only base-only kinds (§4.1, §5)', () => {
  test('POST /communications accepts a base-only kind', async () => {
    const res = await request
      .post('/communications')
      .set('x-tenant-id', TENANT_A)
      .send({ kind: 'message', occurredAt: at(8), source: 'chat', externalId: 'm-9' })
      .expect(201);
    expect(res.body).toMatchObject({ kind: 'message', source: 'chat', tenantId: TENANT_A });
    expect(await rows(sql`SELECT kind FROM communications WHERE id = ${res.body.id}`)).toEqual([{ kind: 'message' }]);
  });

  test('POST /communications refuses a kind that has a child table, and writes nothing', async () => {
    for (const kind of ['meeting', 'email']) {
      const res = await request
        .post('/communications')
        .set('x-tenant-id', TENANT_A)
        .send({ kind, occurredAt: at(8), source: 'chat', externalId: `x-${kind}` });
      expect(res.status).toBe(400);
    }
    expect(await rows(sql`SELECT id FROM communications`)).toEqual([]);
  });

  test('PATCH /communications/:id cannot change kind; a base field of any kind can be updated', async () => {
    const meeting = await createMeeting();
    // a row does not change kind: the update schema has no `kind`, so it is stripped and nothing changes
    await request.patch(`/communications/${meeting.id}`).set('x-tenant-id', TENANT_A).send({ kind: 'message' }).expect(200);
    expect(await rows(sql`SELECT kind FROM communications WHERE id = ${meeting.id}`)).toEqual([{ kind: 'meeting' }]);
    const ok = await request.patch(`/communications/${meeting.id}`).set('x-tenant-id', TENANT_A).send({ source: 'moved' }).expect(200);
    expect(ok.body).toMatchObject({ id: meeting.id, kind: 'meeting', source: 'moved' });
  });

  test('a base whose every kind has a child gets no create route at all', async () => {
    // communication_part: email, meeting and message each have a child table
    // the controller is mounted (its read route answers), so the 404 below is the missing route and not a missing path
    await request.get('/communication_parts').set('x-tenant-id', TENANT_A).expect(200);
    const res = await request
      .post('/communication_parts')
      .set('x-tenant-id', TENANT_A)
      .send({ kind: 'email', sequence: 1, communicationId: NO_SUCH });
    expect(res.status).toBe(404);
    // ...while the same shape of route exists where the base has a base-only kind
    await request.post('/communications').set('x-tenant-id', TENANT_A).send({ kind: 'message', occurredAt: at(8), source: 'c', externalId: 'p-1' }).expect(201);
  });
});

d('the family`s domain errors are HTTP answers', () => {
  const stubbed = async (error: Error) => {
    const { MeetingController } = await import('@gen/modules/meetings/meeting.controller');
    const { CommunicationController } = await import('@gen/modules/communications/communication.controller');
    const { FindMeetingByIdUseCase } = await import('@gen/modules/meetings/use-cases/find-meeting-by-id.use-case');
    const { ListMeetingsUseCase } = await import('@gen/modules/meetings/use-cases/list-meetings.use-case');
    const { CreateMeetingUseCase } = await import('@gen/modules/meetings/use-cases/create-meeting.use-case');
    const { UpdateMeetingUseCase } = await import('@gen/modules/meetings/use-cases/update-meeting.use-case');
    const { DeleteMeetingUseCase } = await import('@gen/modules/meetings/use-cases/delete-meeting.use-case');
    const { FindCommunicationByIdUseCase } = await import('@gen/modules/communications/use-cases/find-communication-by-id.use-case');
    const { ListCommunicationsUseCase } = await import('@gen/modules/communications/use-cases/list-communications.use-case');
    const { CreateCommunicationUseCase } = await import('@gen/modules/communications/use-cases/create-communication.use-case');
    const { UpdateCommunicationUseCase } = await import('@gen/modules/communications/use-cases/update-communication.use-case');
    const { DeleteCommunicationUseCase } = await import('@gen/modules/communications/use-cases/delete-communication.use-case');
    const throwing = { execute: async () => { throw error; } };
    return mount(
      [],
      [
        FindMeetingByIdUseCase, ListMeetingsUseCase, CreateMeetingUseCase, UpdateMeetingUseCase, DeleteMeetingUseCase,
        FindCommunicationByIdUseCase, ListCommunicationsUseCase, CreateCommunicationUseCase,
        UpdateCommunicationUseCase, DeleteCommunicationUseCase,
      ].map((provide) => ({ provide, useValue: throwing })),
      [MeetingController, CommunicationController],
    );
  };

  // The whole body, not a subset: a regression that dropped `error`, `message`, `kind` or `createPath` must fail.
  const bodyOf = (err: any, status: number, code: string) => ({
    statusCode: status,
    error: status === 400 ? 'Bad Request' : 'Conflict',
    code,
    ...(code === 'kind_requires_child' ? { kind: err.kind, createPath: err.createPath } : {}),
    message: err.message,
  });

  const cases: Array<[string, () => Error, number, string]> = [
    ['KindImmutableError', () => new errors.KindImmutableError('meeting'), 400, 'kind_immutable'],
    ['KindRequiresChildError', () => new errors.KindRequiresChildError('communication', 'meeting', 'POST /meetings'), 400, 'kind_requires_child'],
    ['KindMismatchError', () => new errors.KindMismatchError('meeting', 'meeting'), 409, 'kind_mismatch'],
  ];

  for (const [name, make, status, code] of cases) {
    test(`${name} is a ${status} with code ${code}, on a child and on the base`, async () => {
      const local = await stubbed(make());
      try {
        const http = supertest(local.getHttpServer());
        const meeting = meetingBody();
        const viaChild = await http.post('/meetings').send(meeting);
        expect(viaChild.status).toBe(status);
        expect(viaChild.body).toEqual(bodyOf(make(), status, code));
        if (code === 'kind_requires_child') expect(viaChild.body.createPath).toBe('POST /meetings');
        const patchChild = await http.patch(`/meetings/${NO_SUCH}`).send({ title: 'x' });
        expect(patchChild.status).toBe(status);
        expect(patchChild.body).toEqual(bodyOf(make(), status, code));
        const viaBase = await http
          .post('/communications')
          .send({ kind: 'message', occurredAt: at(1), source: 's', externalId: 'e' });
        expect(viaBase.status).toBe(status);
        expect(viaBase.body).toEqual(bodyOf(make(), status, code));
        const patchBase = await http.patch(`/communications/${NO_SUCH}`).send({ source: 'x' });
        expect(patchBase.status).toBe(status);
        expect(patchBase.body).toEqual(bodyOf(make(), status, code));
      } finally {
        await local.close();
      }
    });
  }

  test('an error the family does not own is not swallowed into a 4xx', async () => {
    const local = await stubbed(new Error('boom'));
    try {
      const res = await supertest(local.getHttpServer()).post('/meetings').send(meetingBody());
      expect(res.status).toBe(500);
    } finally {
      await local.close();
    }
  });
});
