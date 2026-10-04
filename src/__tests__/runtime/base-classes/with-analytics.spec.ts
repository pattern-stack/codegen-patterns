/**
 * WithAnalytics mixin unit tests
 *
 * Verifies that the mixin is transparent — methods still delegate correctly.
 */
import { describe, it, expect, mock } from 'bun:test';
import { WithAnalytics } from '../../../../runtime/base-classes/with-analytics';
import { IntegratedEntityService, type IIntegratedEntityRepository } from '../../../../runtime/base-classes/integrated-entity-service';

interface TestEntity {
  id: string;
  name: string;
}

function makeMockRepo(): IIntegratedEntityRepository<TestEntity> {
  return {
    findById: mock(async () => ({ id: '1', name: 'Test' })),
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
  };
}

// This is the key test: WithAnalytics(IntegratedEntityService) must compile
// and preserve all inherited methods.
class AnalyticsCrmService extends WithAnalytics(
  IntegratedEntityService<IIntegratedEntityRepository<TestEntity>, TestEntity>,
) {
  constructor(repo: IIntegratedEntityRepository<TestEntity>) {
    super(repo);
  }
}

describe('WithAnalytics', () => {
  it('creates a class that compiles with IntegratedEntityService', () => {
    const repo = makeMockRepo();
    const service = new AnalyticsCrmService(repo);
    expect(service).toBeDefined();
  });

  it('preserves inherited findById', async () => {
    const repo = makeMockRepo();
    const service = new AnalyticsCrmService(repo);

    const result = await service.findById('1');
    expect(result).toEqual({ id: '1', name: 'Test' });
    expect(repo.findById).toHaveBeenCalledWith('1');
  });

  it('preserves family-specific findByExternalId', async () => {
    const entity: TestEntity = { id: '1', name: 'Test' };
    const repo = makeMockRepo();
    repo.findByExternalId = mock(async () => entity);
    const service = new AnalyticsCrmService(repo);

    const result = await service.findByExternalId('sf-001');
    expect(result).toEqual(entity);
    expect(repo.findByExternalId).toHaveBeenCalledWith('sf-001');
  });

  it('preserves family-specific findManyByExternalIds', async () => {
    const entities: TestEntity[] = [{ id: '1', name: 'A' }];
    const repo = makeMockRepo();
    repo.findManyByExternalIds = mock(async () => entities);
    const service = new AnalyticsCrmService(repo);

    const result = await service.findManyByExternalIds(['sf-001']);
    expect(result).toEqual(entities);
    expect(repo.findManyByExternalIds).toHaveBeenCalledWith(['sf-001']);
  });
});
