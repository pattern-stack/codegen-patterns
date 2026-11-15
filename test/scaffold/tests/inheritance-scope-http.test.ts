/**
 * RFC-0006 / #875 S3 — a joined-table child over HTTP is tenant-scoped (A8, charter I3).
 *
 * Until S3 a child was `tableScope(schema.meetings, UNSCOPED)` and `MeetingRepository`
 * declared no tenant scope, so `GET /meetings` and `GET /meetings/:id` read across
 * tenants: the child declares no `tenant_scoped` of its own (R5), and nothing derived
 * it from the base. This suite mounts the GENERATED `MeetingsModule` as emitted, behind
 * a boundary that installs the requester context from a header — the one thing this
 * harness's other HTTP suites lack, because they mount deliberately unscoped entities.
 *
 * It goes red on the S2 tree: the list returns tenant B's row to tenant A, and the
 * by-id route returns 200 where it must return 404.
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
const ids = {
  meetingA: 'a0000000-0000-4000-8000-000000000001',
  meetingB: 'a0000000-0000-4000-8000-000000000002',
};

let Test: any;
let supertest: any;
let truncateAll: any;
let closeDb: any;
let getTestDb: any;
let sql: any;
let app: any;
let request: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ Test } = await import('@nestjs/testing'));
  supertest = (await import('supertest')).default;
  ({ truncateAll, closeDb, getTestDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
  const { withRequester } = await import('@shared/base-classes/tenant-context');
  const { OPENAPI_REGISTRY, OpenApiRegistry } = await import('@shared/openapi');
  const { DatabaseModule } = await import('../shared/database/database.module');
  const { MeetingsModule } = await import('@gen/modules/meetings/meetings.module');

  // The generated module registers its Zod DTOs with the shared registry at init.
  @Global()
  @Module({
    providers: [{ provide: OPENAPI_REGISTRY, useFactory: () => new OpenApiRegistry() }],
    exports: [OPENAPI_REGISTRY],
  })
  class OpenApiModule {}

  @Module({ imports: [DatabaseModule, OpenApiModule, MeetingsModule] })
  class ScopedMeetingsApp {}

  const moduleRef = await Test.createTestingModule({ imports: [ScopedMeetingsApp] }).compile();
  app = moduleRef.createNestApplication();
  // The boundary a real app's auth installs: the requester context, from a header here.
  app.use((req: any, _res: any, next: () => void) => {
    const tenant = req.headers['x-tenant-id'];
    if (typeof tenant !== 'string') return next();
    return withRequester({ userId: USER, organizationId: null, tenantId: tenant }, () => next());
  });
  await app.init();
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

const run = (stmt: any) => getTestDb().execute(stmt);

async function seed() {
  for (const [id, tenant, title] of [
    [ids.meetingA, TENANT_A, 'a-standup'],
    [ids.meetingB, TENANT_B, 'b-standup'],
  ] as const) {
    await run(sql`INSERT INTO communications (id, tenant_id, kind, occurred_at, source, external_id)
                  VALUES (${id}, ${tenant}, 'meeting', now(), 'src', ${`ext-${id}`})`);
    await run(sql`INSERT INTO meetings (id, tenant_id, title, starts_at) VALUES (${id}, ${tenant}, ${title}, now())`);
  }
}

d('GET /meetings and GET /meetings/:id are tenant-scoped (A8)', () => {
  test('GET /meetings returns only the caller`s tenant', async () => {
    await seed();
    const a = await request.get('/meetings').set('x-tenant-id', TENANT_A).expect(200);
    expect(a.body.items.map((m: any) => m.id)).toEqual([ids.meetingA]);
    const b = await request.get('/meetings').set('x-tenant-id', TENANT_B).expect(200);
    expect(b.body.items.map((m: any) => m.id)).toEqual([ids.meetingB]);
  });

  test('GET /meetings/:id is 200 for the caller`s own row and 404 for another tenant`s', async () => {
    await seed();
    const own = await request.get(`/meetings/${ids.meetingA}`).set('x-tenant-id', TENANT_A).expect(200);
    expect(own.body.title).toBe('a-standup');
    await request.get(`/meetings/${ids.meetingB}`).set('x-tenant-id', TENANT_A).expect(404);
  });

  test('with no tenant boundary the scope is strict: the read fails, it never returns the union', async () => {
    await seed();
    const res = await request.get('/meetings');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain(ids.meetingB);
  });
});
