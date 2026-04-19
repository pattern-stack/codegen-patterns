/**
 * SyncedEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByExternalId, findManyByExternalIds,
 * findAllByUserId, syncUpsert (stub), findVisibleByUserId (stub).
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type CrmEntity = any;
let SyncedEntityRepository: any;
let crmEntities: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let syncedEntityFactory: any;
let repo: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ SyncedEntityRepository } = await import(
    '@shared/base-classes/synced-entity-repository'
  ));
  ({ crmEntities } = await import('../schema'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ syncedEntityFactory } = await import('./helpers'));

  class TestCrmRepository extends SyncedEntityRepository<CrmEntity> {
    readonly table = crmEntities;
    protected readonly behaviors = { timestamps: true, softDelete: true, userTracking: false };
  }

  repo = new TestCrmRepository(getTestDb() as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

d('inherited CRUD', () => {
  test('create + findById round-trip', async () => {
    const data = syncedEntityFactory();
    const created = await repo.create(data);
    expect(created.id).toBeDefined();
    expect(created.name).toBe(data.name);

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });
});

d('findByExternalId', () => {
  test('returns entity with matching external ID', async () => {
    const created = await repo.create(syncedEntityFactory({ externalId: 'sf-001' }));
    const found = await repo.findByExternalId('sf-001');

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.externalId).toBe('sf-001');
  });

  test('returns null for non-existent external ID', async () => {
    const found = await repo.findByExternalId('nonexistent');
    expect(found).toBeNull();
  });
});

d('findManyByExternalIds', () => {
  test('returns correct subset', async () => {
    await repo.create(syncedEntityFactory({ externalId: 'sf-a' }));
    await repo.create(syncedEntityFactory({ externalId: 'sf-b' }));
    await repo.create(syncedEntityFactory({ externalId: 'sf-c' }));

    const found = await repo.findManyByExternalIds(['sf-a', 'sf-c']);
    expect(found).toHaveLength(2);
    const ids = found.map((e: CrmEntity) => e.externalId).sort();
    expect(ids).toEqual(['sf-a', 'sf-c']);
  });

  test('returns empty array for empty input', async () => {
    const found = await repo.findManyByExternalIds([]);
    expect(found).toEqual([]);
  });
});

d('findAllByUserId', () => {
  test('returns only entities for the given user', async () => {
    await repo.create(syncedEntityFactory({ userId: 'user-1', name: 'A' }));
    await repo.create(syncedEntityFactory({ userId: 'user-1', name: 'B' }));
    await repo.create(syncedEntityFactory({ userId: 'user-2', name: 'C' }));

    const found = await repo.findAllByUserId('user-1');
    expect(found).toHaveLength(2);
    const names = found.map((e: CrmEntity) => e.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  test('returns empty array when no matches', async () => {
    const found = await repo.findAllByUserId('nonexistent');
    expect(found).toEqual([]);
  });
});

d('abstract stubs', () => {
  test('syncUpsert throws not implemented', async () => {
    await expect(repo.syncUpsert([])).rejects.toThrow('syncUpsert not implemented');
  });

  test('findVisibleByUserId throws not implemented', async () => {
    await expect(repo.findVisibleByUserId('user-1')).rejects.toThrow(
      'findVisibleByUserId not implemented',
    );
  });
});
