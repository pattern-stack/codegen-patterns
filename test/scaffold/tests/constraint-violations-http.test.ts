/**
 * A write the database refuses on a constraint is the caller's mistake: a 4xx naming the field, never a 500
 * (`runtime/db-constraint-errors.ts`, `runtime/nest-db-constraint-filter.ts`).
 *
 * - a foreign key that names no row → 422 `foreign_key_violation`
 * - a unique value that is taken → 409 `unique_violation`
 * - deleting a row another still references (`on_delete: restrict`) → 409 `still_referenced`
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import 'reflect-metadata';
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

let app: any;
let request: any;
let truncateAll: any;
let closeDb: any;

/** The placeholder id Swagger prefills (src/derived/examples/): a valid guid that names no row. */
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');
  const supertest = (await import('supertest')).default;
  ({ truncateAll, closeDb } = await import('./setup'));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
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

d('a foreign key that names no row', () => {
  test('POST is a 422 naming the field, not a 500', async () => {
    const res = await request.post('/opportunities').send({ accountId: NO_SUCH_ID, name: 'Ghost deal' }).expect(422);
    expect(res.body).toMatchObject({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: 'foreign_key_violation',
      fields: 'accountId',
    });
    expect(res.body.message).toContain('accountId');
    expect(res.body.message).toContain(NO_SUCH_ID);
    expect(res.body.message).toContain('accounts');
    expect(Object.keys(res.body)).toEqual(['statusCode', 'error', 'code', 'fields', 'constraint', 'message']);
  });

  test('PATCH to an id that names no row is a 422 too', async () => {
    const account = await request.post('/accounts').send({ name: 'Acme' }).expect(201);
    const opp = await request.post('/opportunities').send({ accountId: account.body.id, name: 'Deal' }).expect(201);
    const res = await request.patch(`/opportunities/${opp.body.id}`).send({ accountId: NO_SUCH_ID }).expect(422);
    expect(res.body.fields).toBe('accountId');
  });

  test('a real id still creates', async () => {
    const account = await request.post('/accounts').send({ name: 'Acme' }).expect(201);
    await request.post('/opportunities').send({ accountId: account.body.id, name: 'Deal' }).expect(201);
  });
});

d('a unique value that is taken', () => {
  test('POST is a 409 naming the field and the constraint', async () => {
    const a = await request.post('/accounts').send({ name: 'A' }).expect(201);
    const b = await request.post('/accounts').send({ name: 'B' }).expect(201);
    await request.post('/account_profiles').send({ accountId: a.body.id, handle: 'acme' }).expect(201);
    const res = await request.post('/account_profiles').send({ accountId: b.body.id, handle: 'acme' }).expect(409);
    expect(res.body).toMatchObject({ statusCode: 409, error: 'Conflict', code: 'unique_violation', fields: 'handle' });
    expect(res.body.constraint).toContain('handle');
    expect(res.body.message).toContain('handle');
  });
});

d('deleting a row that is still referenced', () => {
  test('DELETE is a 409, not a 500', async () => {
    const account = await request.post('/accounts').send({ name: 'Acme' }).expect(201);
    await request.post('/opportunities').send({ accountId: account.body.id, name: 'Deal' }).expect(201);
    const res = await request.delete(`/accounts/${account.body.id}`).expect(409);
    expect(res.body).toMatchObject({ statusCode: 409, code: 'still_referenced' });
    expect(res.body.message).toContain('opportunities');
  });
});

d('every other error keeps Nest\'s own handling', () => {
  test('a 404 is still Nest\'s 404', async () => {
    const res = await request.get(`/accounts/${NO_SUCH_ID}`).expect(404);
    expect(res.body.statusCode).toBe(404);
  });
});
