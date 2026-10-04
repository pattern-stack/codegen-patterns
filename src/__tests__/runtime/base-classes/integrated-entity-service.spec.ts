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

  // #746: the Integrated pattern declares no user axis, so the family service
  // carries no user-ownership finders (and its repository contract none either).
  describe('no user-ownership finders (#746)', () => {
    it.each(['findAllByUser', 'findVisibleByUser'])('does not expose %s', (method) => {
      expect(method in IntegratedEntityService.prototype).toBe(false);
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
