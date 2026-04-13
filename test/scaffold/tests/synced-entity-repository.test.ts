/**
 * SyncedEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByExternalId, findManyByExternalIds,
 * findAllByUserId, syncUpsert (stub), findVisibleByUserId (stub).
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SyncedEntityRepository } from '@shared/base-classes/synced-entity-repository';
import { crmEntities, type CrmEntity } from '../schema';
import { getTestDb, truncateAll, closeDb } from './setup';
import { syncedEntityFactory } from './helpers';

class TestCrmRepository extends SyncedEntityRepository<CrmEntity> {
  readonly table = crmEntities;
  protected readonly behaviors = { timestamps: true, softDelete: true, userTracking: false };
}

let repo: TestCrmRepository;

beforeAll(() => {
  repo = new TestCrmRepository(getTestDb() as any);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Inherited BaseRepository methods still work
// ---------------------------------------------------------------------------
describe('inherited CRUD', () => {
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

// ---------------------------------------------------------------------------
// findByExternalId
// ---------------------------------------------------------------------------
describe('findByExternalId', () => {
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

// ---------------------------------------------------------------------------
// findManyByExternalIds
// ---------------------------------------------------------------------------
describe('findManyByExternalIds', () => {
  test('returns correct subset', async () => {
    await repo.create(syncedEntityFactory({ externalId: 'sf-a' }));
    await repo.create(syncedEntityFactory({ externalId: 'sf-b' }));
    await repo.create(syncedEntityFactory({ externalId: 'sf-c' }));

    const found = await repo.findManyByExternalIds(['sf-a', 'sf-c']);
    expect(found).toHaveLength(2);
    const ids = found.map((e) => e.externalId).sort();
    expect(ids).toEqual(['sf-a', 'sf-c']);
  });

  test('returns empty array for empty input', async () => {
    const found = await repo.findManyByExternalIds([]);
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findAllByUserId
// ---------------------------------------------------------------------------
describe('findAllByUserId', () => {
  test('returns only entities for the given user', async () => {
    await repo.create(syncedEntityFactory({ userId: 'user-1', name: 'A' }));
    await repo.create(syncedEntityFactory({ userId: 'user-1', name: 'B' }));
    await repo.create(syncedEntityFactory({ userId: 'user-2', name: 'C' }));

    const found = await repo.findAllByUserId('user-1');
    expect(found).toHaveLength(2);
    const names = found.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  test('returns empty array when no matches', async () => {
    const found = await repo.findAllByUserId('nonexistent');
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Abstract stubs throw
// ---------------------------------------------------------------------------
describe('abstract stubs', () => {
  test('syncUpsert throws not implemented', async () => {
    await expect(repo.syncUpsert([])).rejects.toThrow('syncUpsert not implemented');
  });

  test('findVisibleByUserId throws not implemented', async () => {
    await expect(repo.findVisibleByUserId('user-1')).rejects.toThrow(
      'findVisibleByUserId not implemented',
    );
  });
});
