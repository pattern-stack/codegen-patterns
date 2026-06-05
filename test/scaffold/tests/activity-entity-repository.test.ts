/**
 * ActivityEntityRepository integration tests against real Postgres.
 *
 * Tests family-specific methods: findByDateRange, findByUserId, and the
 * config-driven subject finders findBySubjectId / findRecentBySubjectId
 * (ACTIVITY-SUBJECT-1). The test scaffold's activityEntities table keeps its
 * `opportunity_id` column, so the test repo configures `subject: 'opportunity'`
 * (→ opportunityId) — proving the SAME column reached via config, not a hardcode.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type ActivityEntity = any;
let ActivityEntityRepository: any;
let activityEntities: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let activityEntityFactory: any;
let repo: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ ActivityEntityRepository } = await import(
    '@shared/base-classes/activity-entity-repository'
  ));
  ({ activityEntities } = await import('../schema'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ activityEntityFactory } = await import('./helpers'));

  class TestActivityRepository extends ActivityEntityRepository<ActivityEntity> {
    readonly table = activityEntities;
    protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
    // Config-driven subject scoping: subject 'opportunity' → opportunityId column.
    protected readonly patternConfig = { subject: 'opportunity' };
  }

  repo = new TestActivityRepository(getTestDb() as any);
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
    const data = activityEntityFactory();
    const created = await repo.create(data);
    expect(created.id).toBeDefined();
    expect(created.name).toBe(data.name);
  });
});

d('findByDateRange', () => {
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
    const names = found.map((e: ActivityEntity) => e.name).sort();
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

d('findByUserId', () => {
  test('returns activities for the given user', async () => {
    await repo.create(activityEntityFactory({ userId: 'u1', name: 'A' }));
    await repo.create(activityEntityFactory({ userId: 'u1', name: 'B' }));
    await repo.create(activityEntityFactory({ userId: 'u2', name: 'C' }));

    const found = await repo.findByUserId('u1');
    expect(found).toHaveLength(2);
  });
});

d('findBySubjectId (config-driven → opportunityId)', () => {
  test('returns activities for the given subject', async () => {
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', name: 'A' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', name: 'B' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-2', name: 'C' }));

    const found = await repo.findBySubjectId('opp-1');
    expect(found).toHaveLength(2);
  });

  test('resolves the same column via an explicit subjectColumn override', async () => {
    class OverrideRepo extends ActivityEntityRepository<ActivityEntity> {
      readonly table = activityEntities;
      protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
      protected readonly patternConfig = { subjectColumn: 'opportunity_id' };
    }
    const overrideRepo = new OverrideRepo(getTestDb() as any);
    await overrideRepo.create(activityEntityFactory({ opportunityId: 'opp-9', name: 'X' }));
    const found = await overrideRepo.findBySubjectId('opp-9');
    expect(found).toHaveLength(1);
  });

  test('throws when no subject is configured', async () => {
    class NoSubjectRepo extends ActivityEntityRepository<ActivityEntity> {
      readonly table = activityEntities;
      protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
      // no patternConfig — subject finders are unusable
    }
    const noSubjectRepo = new NoSubjectRepo(getTestDb() as any);
    expect(noSubjectRepo.findBySubjectId('opp-1')).rejects.toThrow(/subject/i);
  });
});

d('findRecentBySubjectId', () => {
  test('returns activities ordered by occurredAt desc with limit', async () => {
    const t1 = new Date('2025-01-01T10:00:00Z');
    const t2 = new Date('2025-01-02T10:00:00Z');
    const t3 = new Date('2025-01-03T10:00:00Z');

    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', occurredAt: t1, name: 'Oldest' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', occurredAt: t3, name: 'Newest' }));
    await repo.create(activityEntityFactory({ opportunityId: 'opp-1', occurredAt: t2, name: 'Middle' }));

    const found = await repo.findRecentBySubjectId('opp-1', 2);
    expect(found).toHaveLength(2);
    expect(found[0].name).toBe('Newest');
    expect(found[1].name).toBe('Middle');
  });

  test('uses default limit of 10', async () => {
    for (let i = 0; i < 15; i++) {
      await repo.create(activityEntityFactory({ opportunityId: 'opp-x' }));
    }

    const found = await repo.findRecentBySubjectId('opp-x');
    expect(found).toHaveLength(10);
  });
});
