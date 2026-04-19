/**
 * HTTP integration tests — full NestJS stack via supertest.
 *
 * Validates DI wiring, controller routing, use case integration,
 * and the full request/response lifecycle against real Postgres.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 * Requires the consumer scaffold's own devDependencies (supertest),
 * which are installed by `run-integration.ts`.
 */
import 'reflect-metadata';
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

let Test: any;
let AppModule: any;
let supertest: any;
let truncateAll: any;
let closeDb: any;

let app: any;
let request: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ Test } = await import('@nestjs/testing'));
  ({ AppModule } = await import('../src/app.module'));
  supertest = (await import('supertest')).default;
  ({ truncateAll, closeDb } = await import('./setup'));

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

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

d('POST /contacts', () => {
  test('creates a contact and returns 201', async () => {
    const res = await request
      .post('/contacts')
      .send({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.firstName).toBe('Ada');
    expect(res.body.lastName).toBe('Lovelace');
    expect(res.body.email).toBe('ada@example.com');
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.deletedAt).toBeNull();
  });
});

d('GET /contacts', () => {
  test('returns empty array when no contacts', async () => {
    const res = await request.get('/contacts').expect(200);
    expect(res.body).toEqual([]);
  });

  test('returns all non-deleted contacts', async () => {
    await request
      .post('/contacts')
      .send({ firstName: 'Alice', lastName: 'A', email: 'alice@example.com' });
    await request
      .post('/contacts')
      .send({ firstName: 'Bob', lastName: 'B', email: 'bob@example.com' });

    const res = await request.get('/contacts').expect(200);
    expect(res.body).toHaveLength(2);
  });
});

d('GET /contacts/:id', () => {
  test('returns the correct contact', async () => {
    const created = await request
      .post('/contacts')
      .send({ firstName: 'Ada', lastName: 'L', email: 'ada@example.com' });

    const res = await request.get(`/contacts/${created.body.id}`).expect(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.firstName).toBe('Ada');
  });

  test('returns empty body for nonexistent ID', async () => {
    const res = await request
      .get('/contacts/00000000-0000-0000-0000-000000000000')
      .expect(200);
    expect(res.body.id).toBeUndefined();
  });
});

d('PUT /contacts/:id', () => {
  test('updates fields and returns updated contact', async () => {
    const created = await request
      .post('/contacts')
      .send({ firstName: 'Ada', lastName: 'L', email: 'ada@example.com' });

    const res = await request
      .put(`/contacts/${created.body.id}`)
      .send({ title: 'Mathematician' })
      .expect(200);

    expect(res.body.title).toBe('Mathematician');
    expect(res.body.firstName).toBe('Ada');
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.body.updatedAt).getTime(),
    );
  });
});

d('DELETE /contacts/:id', () => {
  test('soft-deletes and returns the entity with deletedAt set', async () => {
    const created = await request
      .post('/contacts')
      .send({ firstName: 'Ada', lastName: 'L', email: 'ada@example.com' });

    const res = await request
      .delete(`/contacts/${created.body.id}`)
      .expect(200);

    expect(res.body.id).toBe(created.body.id);
    expect(res.body.deletedAt).toBeDefined();
    expect(res.body.deletedAt).not.toBeNull();
  });

  test('soft-deleted contacts excluded from GET /contacts', async () => {
    const created = await request
      .post('/contacts')
      .send({ firstName: 'Ada', lastName: 'L', email: 'ada@example.com' });

    await request.delete(`/contacts/${created.body.id}`);

    const res = await request.get('/contacts').expect(200);
    expect(res.body).toEqual([]);
  });
});

d('full CRUD lifecycle', () => {
  test('create → read → update → delete → verify gone from list', async () => {
    const createRes = await request
      .post('/contacts')
      .send({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@test.com' })
      .expect(201);
    const id = createRes.body.id;

    const getRes = await request.get(`/contacts/${id}`).expect(200);
    expect(getRes.body.firstName).toBe('Ada');

    const putRes = await request
      .put(`/contacts/${id}`)
      .send({ title: 'Pioneer' })
      .expect(200);
    expect(putRes.body.title).toBe('Pioneer');

    const listRes = await request.get('/contacts').expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].title).toBe('Pioneer');

    const delRes = await request.delete(`/contacts/${id}`).expect(200);
    expect(delRes.body.deletedAt).not.toBeNull();

    const listAfter = await request.get('/contacts').expect(200);
    expect(listAfter.body).toEqual([]);
  });
});
