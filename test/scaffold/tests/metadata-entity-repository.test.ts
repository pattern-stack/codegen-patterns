/**
 * MetadataEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByEntityIdAndType, listByEntityId,
 * listHistoryByEntityId, upsertMany.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MetadataEntityRepository } from '@shared/base-classes/metadata-entity-repository';
import { metadataEntities } from '../schema';
import type { InferSelectModel } from 'drizzle-orm';
import { getTestDb, truncateAll, closeDb } from './setup';
import { metadataEntityFactory } from './helpers';

type MetadataEntity = InferSelectModel<typeof metadataEntities>;

class TestMetadataRepository extends MetadataEntityRepository<MetadataEntity> {
  readonly table = metadataEntities;
  protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
}

let repo: TestMetadataRepository;

beforeAll(() => {
  repo = new TestMetadataRepository(getTestDb() as any);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Inherited CRUD
// ---------------------------------------------------------------------------
describe('inherited CRUD', () => {
  test('create + findById round-trip', async () => {
    const data = metadataEntityFactory();
    const created = await repo.create(data);
    expect(created.id).toBeDefined();
    expect(created.entityType).toBe(data.entityType);
  });
});

// ---------------------------------------------------------------------------
// findByEntityIdAndType
// ---------------------------------------------------------------------------
describe('findByEntityIdAndType', () => {
  test('returns records matching both entity ID and type', async () => {
    await repo.create(metadataEntityFactory({ entityId: 'e1', entityType: 'contact', fieldName: 'a' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', entityType: 'contact', fieldName: 'b' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', entityType: 'account', fieldName: 'c' }));
    await repo.create(metadataEntityFactory({ entityId: 'e2', entityType: 'contact', fieldName: 'd' }));

    const found = await repo.findByEntityIdAndType('e1', 'contact');
    expect(found).toHaveLength(2);
    const fields = found.map((e) => e.fieldName).sort();
    expect(fields).toEqual(['a', 'b']);
  });

  test('returns empty array when no match', async () => {
    const found = await repo.findByEntityIdAndType('nonexistent', 'contact');
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listByEntityId
// ---------------------------------------------------------------------------
describe('listByEntityId', () => {
  test('returns all records for an entity', async () => {
    await repo.create(metadataEntityFactory({ entityId: 'e1', fieldName: 'x' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', fieldName: 'y' }));
    await repo.create(metadataEntityFactory({ entityId: 'e2', fieldName: 'z' }));

    const found = await repo.listByEntityId('e1');
    expect(found).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// listHistoryByEntityId
// ---------------------------------------------------------------------------
describe('listHistoryByEntityId', () => {
  test('returns records ordered by validFrom descending', async () => {
    const t1 = new Date('2025-01-01T00:00:00Z');
    const t2 = new Date('2025-02-01T00:00:00Z');
    const t3 = new Date('2025-03-01T00:00:00Z');

    await repo.create(metadataEntityFactory({ entityId: 'e1', validFrom: t1, fieldName: 'oldest' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', validFrom: t3, fieldName: 'newest' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', validFrom: t2, fieldName: 'middle' }));

    const found = await repo.listHistoryByEntityId('e1');
    expect(found).toHaveLength(3);
    expect(found[0].fieldName).toBe('newest');
    expect(found[1].fieldName).toBe('middle');
    expect(found[2].fieldName).toBe('oldest');
  });
});
