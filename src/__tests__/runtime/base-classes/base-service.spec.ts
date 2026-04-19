/**
 * BaseService unit tests
 *
 * Verifies that every CRUD method delegates to the injected repository
 * and returns its result unchanged. No side effects are expected.
 */
import { describe, it, expect, mock } from 'bun:test';
import { BaseService } from '../../../../runtime/base-classes/base-service';
import type { IBaseRepository } from '../../../../runtime/base-classes/base-service';

// ============================================================================
// Test entity and concrete service
// ============================================================================

interface TestEntity {
  id: string;
  name: string;
}

/** Minimal concrete service for tests — no additional logic */
class TestService extends BaseService<IBaseRepository<TestEntity>, TestEntity> {}

// ============================================================================
// Mock repository builder
// ============================================================================

function makeMockRepo(overrides: Partial<IBaseRepository<TestEntity>> = {}): IBaseRepository<TestEntity> {
  return {
    findById: mock(async (_id: string) => null),
    findByIds: mock(async (_ids: string[]) => []),
    list: mock(async () => []),
    count: mock(async () => 0),
    exists: mock(async (_id: string) => false),
    create: mock(async (input: Partial<TestEntity>) => ({ id: 'new', ...input } as TestEntity)),
    update: mock(async (_id: string, input: Partial<TestEntity>) => ({ id: _id, ...input } as TestEntity)),
    delete: mock(async (_id: string) => undefined),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseService', () => {
  describe('findById', () => {
    it('delegates to repository.findById and returns its result', async () => {
      const entity: TestEntity = { id: 'abc', name: 'Test' };
      const repo = makeMockRepo({ findById: mock(async () => entity) });
      const service = new TestService(repo);

      const result = await service.findById('abc');

      expect(result).toBe(entity);
      expect(repo.findById).toHaveBeenCalledWith('abc');
    });

    it('returns null when repository returns null', async () => {
      const repo = makeMockRepo({ findById: mock(async () => null) });
      const service = new TestService(repo);

      const result = await service.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('findByIds', () => {
    it('delegates to repository.findByIds and returns its result', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }];
      const repo = makeMockRepo({ findByIds: mock(async () => entities) });
      const service = new TestService(repo);

      const result = await service.findByIds(['1', '2']);

      expect(result).toBe(entities);
      expect(repo.findByIds).toHaveBeenCalledWith(['1', '2']);
    });
  });

  describe('list', () => {
    it('delegates to repository.list and returns its result', async () => {
      const entities: TestEntity[] = [{ id: '1', name: 'A' }];
      const repo = makeMockRepo({ list: mock(async () => entities) });
      const service = new TestService(repo);

      const result = await service.list();

      expect(result).toBe(entities);
      expect(repo.list).toHaveBeenCalledWith(undefined);
    });

    it('forwards options to repository.list', async () => {
      const repo = makeMockRepo({ list: mock(async () => []) });
      const service = new TestService(repo);
      const options = { limit: 10, offset: 5 };

      await service.list(options);

      expect(repo.list).toHaveBeenCalledWith(options);
    });
  });

  describe('count', () => {
    it('delegates to repository.count and returns its result', async () => {
      const repo = makeMockRepo({ count: mock(async () => 42) });
      const service = new TestService(repo);

      const result = await service.count();

      expect(result).toBe(42);
      expect(repo.count).toHaveBeenCalledWith(undefined);
    });

    it('forwards where clause to repository.count', async () => {
      const repo = makeMockRepo({ count: mock(async () => 7) });
      const service = new TestService(repo);
      const where = { active: true };

      await service.count(where);

      expect(repo.count).toHaveBeenCalledWith(where);
    });
  });

  describe('exists', () => {
    it('delegates to repository.exists and returns true', async () => {
      const repo = makeMockRepo({ exists: mock(async () => true) });
      const service = new TestService(repo);

      const result = await service.exists('abc');

      expect(result).toBe(true);
      expect(repo.exists).toHaveBeenCalledWith('abc');
    });

    it('returns false when repository.exists returns false', async () => {
      const repo = makeMockRepo({ exists: mock(async () => false) });
      const service = new TestService(repo);

      const result = await service.exists('ghost');

      expect(result).toBe(false);
    });
  });

  describe('create', () => {
    it('delegates to repository.create and returns the created entity', async () => {
      const entity: TestEntity = { id: 'new', name: 'Created' };
      const repo = makeMockRepo({ create: mock(async () => entity) });
      const service = new TestService(repo);

      const result = await service.create({ name: 'Created' });

      expect(result).toBe(entity);
      expect(repo.create).toHaveBeenCalledWith({ name: 'Created' }, undefined);
    });
  });

  describe('update', () => {
    it('delegates to repository.update and returns the updated entity', async () => {
      const entity: TestEntity = { id: 'upd', name: 'Updated' };
      const repo = makeMockRepo({ update: mock(async () => entity) });
      const service = new TestService(repo);

      const result = await service.update('upd', { name: 'Updated' });

      expect(result).toBe(entity);
      expect(repo.update).toHaveBeenCalledWith('upd', { name: 'Updated' }, undefined);
    });
  });

  describe('delete', () => {
    it('delegates to repository.delete', async () => {
      const repo = makeMockRepo({ delete: mock(async () => undefined) });
      const service = new TestService(repo);

      await service.delete('del-id');

      expect(repo.delete).toHaveBeenCalledWith('del-id', undefined);
    });
  });
});
