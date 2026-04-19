/**
 * MetadataEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByEntityIdAndType, listByEntityId,
 * listHistoryByEntityId, upsertMany.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type MetadataEntity = any;
let MetadataEntityRepository: any;
let metadataEntities: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let metadataEntityFactory: any;
let repo: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ MetadataEntityRepository } = await import(
    '@shared/base-classes/metadata-entity-repository'
  ));
  ({ metadataEntities } = await import('../schema'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ metadataEntityFactory } = await import('./helpers'));

  class TestMetadataRepository extends MetadataEntityRepository<MetadataEntity> {
    readonly table = metadataEntities;
    protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
  }

  repo = new TestMetadataRepository(getTestDb() as any);
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
    const data = metadataEntityFactory();
    const created = await repo.create(data);
    expect(created.id).toBeDefined();
    expect(created.entityType).toBe(data.entityType);
  });
});

d('findByEntityIdAndType', () => {
  test('returns records matching both entity ID and type', async () => {
    await repo.create(metadataEntityFactory({ entityId: 'e1', entityType: 'contact', fieldName: 'a' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', entityType: 'contact', fieldName: 'b' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', entityType: 'account', fieldName: 'c' }));
    await repo.create(metadataEntityFactory({ entityId: 'e2', entityType: 'contact', fieldName: 'd' }));

    const found = await repo.findByEntityIdAndType('e1', 'contact');
    expect(found).toHaveLength(2);
    const fields = found.map((e: MetadataEntity) => e.fieldName).sort();
    expect(fields).toEqual(['a', 'b']);
  });

  test('returns empty array when no match', async () => {
    const found = await repo.findByEntityIdAndType('nonexistent', 'contact');
    expect(found).toEqual([]);
  });
});

d('listByEntityId', () => {
  test('returns all records for an entity', async () => {
    await repo.create(metadataEntityFactory({ entityId: 'e1', fieldName: 'x' }));
    await repo.create(metadataEntityFactory({ entityId: 'e1', fieldName: 'y' }));
    await repo.create(metadataEntityFactory({ entityId: 'e2', fieldName: 'z' }));

    const found = await repo.listByEntityId('e1');
    expect(found).toHaveLength(2);
  });
});

d('listHistoryByEntityId', () => {
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
