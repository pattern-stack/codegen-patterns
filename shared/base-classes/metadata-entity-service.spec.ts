/**
 * MetadataEntityService unit tests
 *
 * Verifies that family-specific methods delegate to the repository.
 */
import { describe, it, expect, mock } from 'bun:test';
import { MetadataEntityService, type IMetadataEntityRepository } from './metadata-entity-service';

interface TestEntity {
  id: string;
  fieldName: string;
}

class TestMetadataService extends MetadataEntityService<
  IMetadataEntityRepository<TestEntity>,
  TestEntity
> {}

function makeMockRepo(
  overrides: Partial<IMetadataEntityRepository<TestEntity>> = {},
): IMetadataEntityRepository<TestEntity> {
  return {
    findById: mock(async () => null),
    findByIds: mock(async () => []),
    list: mock(async () => []),
    count: mock(async () => 0),
    exists: mock(async () => false),
    create: mock(async (input) => ({ id: 'new', ...input } as TestEntity)),
    update: mock(async (id, input) => ({ id, ...input } as TestEntity)),
    delete: mock(async () => undefined),
    findByEntityIdAndType: mock(async () => []),
    listByEntityId: mock(async () => []),
    listHistoryByEntityId: mock(async () => []),
    upsertMany: mock(async () => []),
    ...overrides,
  };
}

describe('MetadataEntityService', () => {
  describe('findByEntityIdAndType', () => {
    it('delegates to repository.findByEntityIdAndType', async () => {
      const entities: TestEntity[] = [{ id: '1', fieldName: 'status' }];
      const repo = makeMockRepo({ findByEntityIdAndType: mock(async () => entities) });
      const service = new TestMetadataService(repo);

      const result = await service.findByEntityIdAndType('opp-1', 'opportunity');
      expect(result).toEqual(entities);
      expect(repo.findByEntityIdAndType).toHaveBeenCalledWith('opp-1', 'opportunity');
    });
  });

  describe('listByEntity', () => {
    it('delegates to repository.listByEntityId', async () => {
      const entities: TestEntity[] = [{ id: '1', fieldName: 'status' }];
      const repo = makeMockRepo({ listByEntityId: mock(async () => entities) });
      const service = new TestMetadataService(repo);

      const result = await service.listByEntity('e1');
      expect(result).toEqual(entities);
      expect(repo.listByEntityId).toHaveBeenCalledWith('e1');
    });
  });

  describe('listHistory', () => {
    it('delegates to repository.listHistoryByEntityId', async () => {
      const entities: TestEntity[] = [{ id: '1', fieldName: 'status' }];
      const repo = makeMockRepo({ listHistoryByEntityId: mock(async () => entities) });
      const service = new TestMetadataService(repo);

      const result = await service.listHistory('e1');
      expect(result).toEqual(entities);
      expect(repo.listHistoryByEntityId).toHaveBeenCalledWith('e1');
    });
  });

  describe('upsertValues', () => {
    it('delegates to repository.upsertMany with conflict target', async () => {
      const inputs = [{ fieldName: 'status' }] as Array<Partial<TestEntity>>;
      const entities: TestEntity[] = [{ id: '1', fieldName: 'status' }];
      const repo = makeMockRepo({ upsertMany: mock(async () => entities) });
      const service = new TestMetadataService(repo);

      const result = await service.upsertValues(inputs, 'id');
      expect(result).toEqual(entities);
      expect(repo.upsertMany).toHaveBeenCalledWith(inputs, 'id');
    });
  });
});
