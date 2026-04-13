/**
 * CrmEntityService unit tests
 *
 * Verifies that family-specific methods delegate to the repository.
 */
import { describe, it, expect, mock } from 'bun:test';
import { CrmEntityService, type ICrmEntityRepository } from './crm-entity-service';

interface TestEntity {
  id: string;
  name: string;
}

class TestCrmService extends CrmEntityService<ICrmEntityRepository<TestEntity>, TestEntity> {}

function makeMockRepo(
  overrides: Partial<ICrmEntityRepository<TestEntity>> = {},
): ICrmEntityRepository<TestEntity> {
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
    ...overrides,
  };
}

describe('CrmEntityService', () => {
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
