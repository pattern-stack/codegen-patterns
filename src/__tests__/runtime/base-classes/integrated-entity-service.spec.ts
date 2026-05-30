/**
 * IntegratedEntityService unit tests
 *
 * Verifies that family-specific methods delegate to the repository.
 */
import { describe, it, expect, mock } from 'bun:test';
import { IntegratedEntityService, type IIntegratedEntityRepository } from '../../../../runtime/base-classes/integrated-entity-service';

interface TestEntity {
  id: string;
  name: string;
}

class TestCrmService extends IntegratedEntityService<IIntegratedEntityRepository<TestEntity>, TestEntity> {}

function makeMockRepo(
  overrides: Partial<IIntegratedEntityRepository<TestEntity>> = {},
): IIntegratedEntityRepository<TestEntity> {
  return {
    findById: mock(async () => null),
    findByIds: mock(async () => []),
    list: mock(async () => []),
    count: mock(async () => 0),
    exists: mock(async () => false),
    create: mock(async (input) => ({ id: 'new', ...input } as TestEntity)),
    update: mock(async (id, input) => ({ id, ...input } as TestEntity)),
    delete: mock(async () => undefined),
    findByExternalId: mock(async () => null),
    findManyByExternalIds: mock(async () => []),
    findAllByUserId: mock(async () => []),
    findVisibleByUserId: mock(async () => []),
    integrationUpsert: mock(async () => []),
    ...overrides,
  };
}

describe('IntegratedEntityService', () => {
  describe('findByExternalId', () => {
    it('delegates to repository.findByExternalId', async () => {
      const entity: TestEntity = { id: '1', name: 'Contact' };
      const repo = makeMockRepo({ findByExternalId: mock(async () => entity) });
      const service = new TestCrmService(repo);

      const result = await service.findByExternalId('sf-001');
      expect(result).toEqual(entity);
      expect(repo.findByExternalId).toHaveBeenCalledWith('sf-001');
    });
  });

  describe('findAllByUser', () => {
    it('delegates to repository.findAllByUserId', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'A' }];
      const repo = makeMockRepo({ findAllByUserId: mock(async () => entities) });
      const service = new TestCrmService(repo);

      const result = await service.findAllByUser('user-1');
      expect(result).toEqual(entities);
      expect(repo.findAllByUserId).toHaveBeenCalledWith('user-1');
    });
  });

  describe('findManyByExternalIds', () => {
    it('delegates to repository.findManyByExternalIds', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }];
      const repo = makeMockRepo({ findManyByExternalIds: mock(async () => entities) });
      const service = new TestCrmService(repo);

      const result = await service.findManyByExternalIds(['sf-001', 'sf-002']);
      expect(result).toEqual(entities);
      expect(repo.findManyByExternalIds).toHaveBeenCalledWith(['sf-001', 'sf-002']);
    });
  });

  describe('findVisibleByUser', () => {
    it('delegates to repository.findVisibleByUserId', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'Visible' }];
      const repo = makeMockRepo({ findVisibleByUserId: mock(async () => entities) });
      const service = new TestCrmService(repo);

      const result = await service.findVisibleByUser('user-1');
      expect(result).toEqual(entities);
      expect(repo.findVisibleByUserId).toHaveBeenCalledWith('user-1');
    });
  });

  describe('inherited CRUD', () => {
    it('findById delegates to base repository', async () => {
      const entity: TestEntity = { id: '1', name: 'Test' };
      const repo = makeMockRepo({ findById: mock(async () => entity) });
      const service = new TestCrmService(repo);

      const result = await service.findById('1');
      expect(result).toEqual(entity);
    });
  });
});
