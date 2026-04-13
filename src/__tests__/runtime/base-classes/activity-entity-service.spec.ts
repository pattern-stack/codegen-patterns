/**
 * ActivityEntityService unit tests
 *
 * Verifies that family-specific methods delegate to the repository.
 */
import { describe, it, expect, mock } from 'bun:test';
import { ActivityEntityService, type IActivityEntityRepository } from '../../../../runtime/base-classes/activity-entity-service';

interface TestEntity {
  id: string;
  name: string;
}

class TestActivityService extends ActivityEntityService<
  IActivityEntityRepository<TestEntity>,
  TestEntity
> {}

function makeMockRepo(
  overrides: Partial<IActivityEntityRepository<TestEntity>> = {},
): IActivityEntityRepository<TestEntity> {
  return {
    findById: mock(async () => null),
    findByIds: mock(async () => []),
    list: mock(async () => []),
    count: mock(async () => 0),
    exists: mock(async () => false),
    create: mock(async (input) => ({ id: 'new', ...input } as TestEntity)),
    update: mock(async (id, input) => ({ id, ...input } as TestEntity)),
    delete: mock(async () => undefined),
    findByDateRange: mock(async () => []),
    findByUserId: mock(async () => []),
    findByOpportunityId: mock(async () => []),
    findRecentByOpportunityId: mock(async () => []),
    ...overrides,
  };
}

describe('ActivityEntityService', () => {
  describe('findByDateRange', () => {
    it('delegates to repository.findByDateRange', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'Call' }];
      const start = new Date('2025-01-01');
      const end = new Date('2025-02-01');
      const repo = makeMockRepo({ findByDateRange: mock(async () => entities) });
      const service = new TestActivityService(repo);

      const result = await service.findByDateRange(start, end);
      expect(result).toEqual(entities);
      expect(repo.findByDateRange).toHaveBeenCalledWith(start, end);
    });
  });

  describe('findByUser', () => {
    it('delegates to repository.findByUserId', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'Meeting' }];
      const repo = makeMockRepo({ findByUserId: mock(async () => entities) });
      const service = new TestActivityService(repo);

      const result = await service.findByUser('user-1');
      expect(result).toEqual(entities);
      expect(repo.findByUserId).toHaveBeenCalledWith('user-1');
    });
  });

  describe('findByOpportunity', () => {
    it('delegates to repository.findByOpportunityId', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'Note' }];
      const repo = makeMockRepo({ findByOpportunityId: mock(async () => entities) });
      const service = new TestActivityService(repo);

      const result = await service.findByOpportunity('opp-1');
      expect(result).toEqual(entities);
      expect(repo.findByOpportunityId).toHaveBeenCalledWith('opp-1');
    });
  });

  describe('findRecent', () => {
    it('delegates to repository.findRecentByOpportunityId with limit', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'Email' }];
      const repo = makeMockRepo({ findRecentByOpportunityId: mock(async () => entities) });
      const service = new TestActivityService(repo);

      const result = await service.findRecent('opp-1', 5);
      expect(result).toEqual(entities);
      expect(repo.findRecentByOpportunityId).toHaveBeenCalledWith('opp-1', 5);
    });
  });
});
