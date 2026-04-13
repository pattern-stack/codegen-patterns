/**
 * Base read use cases unit tests
 *
 * Verifies that BaseFindByIdUseCase and BaseListUseCase delegate correctly
 * to the injected service. These are pure delegation classes — no additional
 * logic is expected.
 */
import { describe, it, expect, mock } from 'bun:test';
import { BaseFindByIdUseCase, BaseListUseCase } from '../../../../runtime/base-classes/base-read-use-cases';
import type { IFindByIdService, IListService } from '../../../../runtime/base-classes/base-read-use-cases';

// ============================================================================
// Test entity
// ============================================================================

interface TestEntity {
  id: string;
  name: string;
}

// ============================================================================
// Concrete use case implementations for tests
// ============================================================================

class TestFindByIdUseCase extends BaseFindByIdUseCase<IFindByIdService<TestEntity>, TestEntity> {}
class TestListUseCase extends BaseListUseCase<IListService<TestEntity>, TestEntity> {}

// ============================================================================
// Tests
// ============================================================================

describe('BaseFindByIdUseCase', () => {
  it('execute(id) delegates to service.findById(id)', async () => {
    const entity: TestEntity = { id: 'abc', name: 'Test' };
    const service: IFindByIdService<TestEntity> = {
      findById: mock(async () => entity),
    };
    const useCase = new TestFindByIdUseCase(service);

    const result = await useCase.execute('abc');

    expect(result).toBe(entity);
    expect(service.findById).toHaveBeenCalledWith('abc');
  });

  it('returns null when service.findById returns null', async () => {
    const service: IFindByIdService<TestEntity> = {
      findById: mock(async () => null),
    };
    const useCase = new TestFindByIdUseCase(service);

    const result = await useCase.execute('missing');

    expect(result).toBeNull();
    expect(service.findById).toHaveBeenCalledWith('missing');
  });

  it('forwards the id argument exactly as received', async () => {
    const service: IFindByIdService<TestEntity> = {
      findById: mock(async () => null),
    };
    const useCase = new TestFindByIdUseCase(service);
    const id = 'some-uuid-1234';

    await useCase.execute(id);

    expect(service.findById).toHaveBeenCalledWith(id);
  });
});

describe('BaseListUseCase', () => {
  it('execute() delegates to service.list()', async () => {
    const entities: TestEntity[] = [
      { id: '1', name: 'A' },
      { id: '2', name: 'B' },
    ];
    const service: IListService<TestEntity> = {
      list: mock(async () => entities),
    };
    const useCase = new TestListUseCase(service);

    const result = await useCase.execute();

    expect(result).toBe(entities);
    expect(service.list).toHaveBeenCalled();
  });

  it('returns empty array when service.list returns empty array', async () => {
    const service: IListService<TestEntity> = {
      list: mock(async () => []),
    };
    const useCase = new TestListUseCase(service);

    const result = await useCase.execute();

    expect(result).toEqual([]);
  });

  it('service.list is called with no arguments', async () => {
    const service: IListService<TestEntity> = {
      list: mock(async () => []),
    };
    const useCase = new TestListUseCase(service);

    await useCase.execute();

    // execute() calls list() with no arguments — callers needing filters
    // should use a dedicated use case
    expect(service.list).toHaveBeenCalledWith();
  });
});
