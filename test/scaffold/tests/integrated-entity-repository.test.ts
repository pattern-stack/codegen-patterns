/**
 * IntegratedEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByExternalId, findManyByExternalIds,
 * integrationUpsert. The family carries no user-ownership finders (#746) —
 * `pattern: Integrated` declares no user axis.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type CrmEntity = any;
let IntegratedEntityRepository: any;
let crmEntities: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let integratedEntityFactory: any;
let repo: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ IntegratedEntityRepository } = await import(
    '@shared/base-classes/integrated-entity-repository'
  ));
  ({ crmEntities } = await import('../schema'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ integratedEntityFactory } = await import('./helpers'));

  class TestCrmRepository extends IntegratedEntityRepository<CrmEntity> {
    readonly table = crmEntities;
    protected readonly behaviors = { timestamps: true, softDelete: true, userTracking: false, tenantScoped: false };
    // #374: integrationConfig is now abstract on the base. A minimal config keeps this
    // hand-written test repo compiling; the generic integration surface is unit-tested
    // separately in src/__tests__/runtime/base-classes/.
    protected readonly integrationConfig = {
      conflictTarget: ['provider', 'externalId'],
      writeColumns: ['name'],
      fkResolvers: [],
      projectionColumns: ['id', 'externalId', 'name'],
      eav: false,
      softDelete: true,
    };
  }

  repo = new TestCrmRepository(getTestDb() as any);
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
    const data = integratedEntityFactory();
    const created = await repo.create(data);
    expect(created.id).toBeDefined();
    expect(created.name).toBe(data.name);

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });
});

d('findByExternalId', () => {
  test('returns entity with matching external ID', async () => {
    const created = await repo.create(integratedEntityFactory({ externalId: 'sf-001' }));
    const found = await repo.findByExternalId('sf-001');

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.externalId).toBe('sf-001');
  });

  test('returns null for non-existent external ID', async () => {
    const found = await repo.findByExternalId('nonexistent');
    expect(found).toBeNull();
  });
});

d('findManyByExternalIds', () => {
  test('returns correct subset', async () => {
    await repo.create(integratedEntityFactory({ externalId: 'sf-a' }));
    await repo.create(integratedEntityFactory({ externalId: 'sf-b' }));
    await repo.create(integratedEntityFactory({ externalId: 'sf-c' }));

    const found = await repo.findManyByExternalIds(['sf-a', 'sf-c']);
    expect(found).toHaveLength(2);
    const ids = found.map((e: CrmEntity) => e.externalId).sort();
    expect(ids).toEqual(['sf-a', 'sf-c']);
  });

  test('returns empty array for empty input', async () => {
    const found = await repo.findManyByExternalIds([]);
    expect(found).toEqual([]);
  });
});

d('integrationUpsert', () => {
  test('returns [] for empty input', async () => {
    await expect(repo.integrationUpsert([])).resolves.toEqual([]);
  });
});
