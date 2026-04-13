/**
 * ActivityEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByDateRange, findByUserId,
 * findByOpportunityId, findRecentByOpportunityId.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { ActivityEntityRepository } from '@shared/base-classes/activity-entity-repository';
import { activityEntities, type ActivityEntity } from '../schema';
import { getTestDb, truncateAll, closeDb } from './setup';
import { activityEntityFactory } from './helpers';

class TestActivityRepository extends ActivityEntityRepository<ActivityEntity> {
  readonly table = activityEntities;
  protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
}

let repo: TestActivityRepository;

beforeAll(() => {
  repo = new TestActivityRepository(getTestDb() as any);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Inherited CRUD
// ---------------------------------------------------------------------------
describe('inherited CRUD', () => {
  test('create + findById round-trip', async () => {
    const data = activityEntityFactory();
    const created = await repo.create(data);
    expect(created.id).toBeDefined();
    expect(created.name).toBe(data.name);
  });
});

// ---------------------------------------------------------------------------
// findByDateRange
// ---------------------------------------------------------------------------
describe('findByDateRange', () => {
  test('returns activities within the range', async () => {
    const jan = new Date('2025-01-15T12:00:00Z');
    const feb = new Date('2025-02-15T12:00:00Z');
    const mar = new Date('2025-03-15T12:00:00Z');

    await repo.create(activityEntityFactory({ occurredAt: jan, name: 'Jan' }));
    await repo.create(activityEntityFactory({ occurredAt: feb, name: 'Feb' }));
    await repo.create(activityEntityFactory({ occurredAt: mar, name: 'Mar' }));

    const found = await repo.findByDateRange(
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-02-28T23:59:59Z'),
    );

    expect(found).toHaveLength(2);
    const names = found.map((e) => e.name).sort();
    expect(names).toEqual(['Feb', 'Jan']);
  });

  test('returns empty array when no activities in range', async () => {
    await repo.create(activityEntityFactory({ occurredAt: new Date('2025-06-01') }));
    const found = await repo.findByDateRange(
      new Date('2025-01-01'),
      new Date('2025-02-01'),
    );
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findByUserId
// ---------------------------------------------------------------------------
describe('findByUserId', () => {
  test('returns activities for the given user', async () => {
    await repo.create(activityEntityFactory({ userId: 'u1', name: 'A' }));
    await repo.create(activityEntityFactory({ userId: 'u1', name: 'B' }));
    await repo.create(activityEntityFactory({ userId: 'u2', name: 'C' }));

    const found = await repo.findByUserId('u1');
    expect(found).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// findByOpportunityId
// ---------------------------------------------------------------------------
describe('findByOpportunityId', () => {
  test('returns activities for the given opportunity', async () => {
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', name: 'A' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', name: 'B' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-2', name: 'C' }));

    const found = await repo.findByOpportunityId('opp-1');
    expect(found).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// findRecentByOpportunityId
// ---------------------------------------------------------------------------
describe('findRecentByOpportunityId', () => {
  test('returns activities ordered by occurredAt desc with limit', async () => {
    const t1 = new Date('2025-01-01T10:00:00Z');
    const t2 = new Date('2025-01-02T10:00:00Z');
    const t3 = new Date('2025-01-03T10:00:00Z');

    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', occurredAt: t1, name: 'Oldest' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', occurredAt: t3, name: 'Newest' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', occurredAt: t2, name: 'Middle' }));

    const found = await repo.findRecentByOpportunityId('opp-1', 2);
    expect(found).toHaveLength(2);
    expect(found[0].name).toBe('Newest');
    expect(found[1].name).toBe('Middle');
  });

  test('uses default limit of 10', async () => {
    for (let i = 0; i < 15; i++) {
      await repo.create(activityEntityFactory({ opportunityId: 'opp-x' }));
    }

    const found = await repo.findRecentByOpportunityId('opp-x');
    expect(found).toHaveLength(10);
  });
});
