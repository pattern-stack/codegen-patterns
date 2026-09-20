/**
 * SCOPE-0 (#616) — the repository scope guards survive a leaf predicate.
 *
 * `baseQuery()` returns a `$dynamic()` SELECT that already carries the
 * soft-delete exclusion and the `userTracking` scope. Drizzle's `.where()`
 * REPLACES that condition rather than AND-ing it, so every finder that chained
 * `.where(<leaf>)` onto it silently read soft-deleted rows and other users'
 * rows. `count()` had the same class of defect by hand-assembling its own
 * conditions instead of calling `scopeAnd()`.
 *
 * These assertions fail on the pre-fix tree. They run against real Postgres
 * because the defect is in the SQL that reaches the database — a mock cannot
 * tell a replaced WHERE from an AND-ed one.
 *
 * ## What this file can and cannot reach
 *
 * Every one of the 17 sites compiles down to the same call — `baseQuery(leaf)`
 * on the real `BaseRepository` — so the behaviour is proven once here, on the
 * family repositories, which DO resolve to `runtime/base-classes/`.
 *
 * The GENERATED clean-lite-ps finders cannot be executed in this harness:
 * generated code imports `@shared/base-classes/base-repository`, which resolves
 * scaffold-first to `test/scaffold/shared/base-classes/base-repository.ts` — a
 * hand-written stub with no `baseQuery`, no `scopeAnd` and no `behaviors` at
 * all (#608). So the generated half of the proof is split:
 *   - the emitted BODY is asserted in `src/__tests__/clean-lite-ps/repository-template.test.ts`
 *     (it must be `baseQuery(<leaf>)`), and globally by
 *     `src/__tests__/templates/no-basequery-where.test.ts`;
 *   - the emitted body's COMPILATION against the real base class is gated by
 *     `just test-smoke` (its fixtures carry `queries:` blocks);
 *   - the SEMANTICS of what that body calls are this file.
 * Collapsing the stub (#608) is what would let one test span all three.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const USER_A = 'user-scope-a';
const USER_B = 'user-scope-b';

let withRequester: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let IntegratedEntityRepository: any;
let ActivityEntityRepository: any;
let MetadataEntityRepository: any;
let crmEntities: any;
let activityEntities: any;
let metadataEntities: any;
let repo: any;
let activityRepo: any;
let metadataRepo: any;
let eq: any;

let counter = 0;
const uniqueExternalId = () => `ext-scope-${++counter}-${Date.now()}`;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;

  // The REAL runtime ALS. `@shared/base-classes/*` resolves scaffold-first, and
  // the scaffold ships its own `base-repository` stub (#608) — but not its own
  // `tenant-context` or family bases, so those come from `runtime/`. The ALS is
  // imported through `@gen/` (→ repo root) to make that explicit rather than
  // incidental: this test is meaningless if it feeds a different module's ALS.
  ({ withRequester } = await import('@gen/runtime/base-classes/tenant-context'));
  ({ IntegratedEntityRepository } = await import(
    '@shared/base-classes/integrated-entity-repository'
  ));
  ({ ActivityEntityRepository } = await import(
    '@shared/base-classes/activity-entity-repository'
  ));
  ({ MetadataEntityRepository } = await import(
    '@shared/base-classes/metadata-entity-repository'
  ));
  ({ crmEntities, activityEntities, metadataEntities } = await import('../schema'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ eq } = await import('drizzle-orm'));

  class ScopedCrmRepository extends IntegratedEntityRepository<any> {
    readonly table = crmEntities;
    // BOTH guards on at once: a leaf predicate must survive both, not one.
    protected readonly behaviors = {
      timestamps: true,
      softDelete: true,
      userTracking: true,
    };
    protected readonly integrationConfig = {
      conflictTarget: ['provider', 'externalId'],
      writeColumns: ['name'],
      fkResolvers: [],
      projectionColumns: ['id', 'externalId', 'name'],
      eav: false,
      softDelete: true,
    };
  }

  repo = new ScopedCrmRepository(getTestDb() as any);

  // BOTH guards on for every family — a finder must survive both, not one.
  const bothGuards = { timestamps: true, softDelete: true, userTracking: true };

  class ScopedActivityRepository extends ActivityEntityRepository<any> {
    readonly table = activityEntities;
    protected readonly behaviors = bothGuards;
    protected readonly patternConfig = { subject: 'opportunity' };
  }
  activityRepo = new ScopedActivityRepository(getTestDb() as any);

  class ScopedMetadataRepository extends MetadataEntityRepository<any> {
    readonly table = metadataEntities;
    protected readonly behaviors = bothGuards;
  }
  metadataRepo = new ScopedMetadataRepository(getTestDb() as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

/** Run `fn` as USER_A — the owner of every "live" row seeded below. */
function asUserA<T>(fn: () => Promise<T>): Promise<T> {
  return withRequester({ userId: USER_A, organizationId: null }, fn);
}

/**
 * One live row owned by USER_A, one soft-deleted row owned by USER_A, one live
 * row owned by USER_B. Every assertion below is "only the first one".
 */
async function seed() {
  const live = await repo.create({
    name: 'live',
    userId: USER_A,
    externalId: uniqueExternalId(),
    provider: 'salesforce',
  });
  const deleted = await repo.create({
    name: 'deleted',
    userId: USER_A,
    externalId: uniqueExternalId(),
    provider: 'salesforce',
  });
  await repo.delete(deleted.id); // softDelete: true → sets deleted_at
  const otherUser = await repo.create({
    name: 'other',
    userId: USER_B,
    externalId: uniqueExternalId(),
    provider: 'salesforce',
  });
  return { live, deleted, otherUser };
}

// ============================================================================
// count() — the site that bypassed scopeAnd() entirely
// ============================================================================

d('count()', () => {
  test('counts neither the soft-deleted row nor another user\'s row', async () => {
    await seed();
    expect(await asUserA(() => repo.count())).toBe(1);
  });

  test('applies both guards alongside a caller predicate', async () => {
    await seed();

    // All three rows are provider=salesforce; only one is live AND owned.
    expect(
      await asUserA(() => repo.count(eq(crmEntities.provider, 'salesforce'))),
    ).toBe(1);
    // The other user's row is reachable by its own predicate — and still not counted.
    expect(await asUserA(() => repo.count(eq(crmEntities.name, 'other')))).toBe(0);
    expect(await asUserA(() => repo.count(eq(crmEntities.name, 'deleted')))).toBe(0);
  });

  test('without an ambient context the user scope is lenient, soft-delete is not', async () => {
    await seed();
    // No requester → userTracking unscoped (lenient default); the soft-delete
    // guard is unconditional. 2 of the 3 rows.
    expect(await repo.count()).toBe(2);
  });
});

// ============================================================================
// Family finders — 10 of the 17 sites live in these base classes, and every
// generated finder compiles to the same `baseQuery(leaf)` call.
// ============================================================================

d('finders built on baseQuery(leaf)', () => {
  test('findByExternalId skips a soft-deleted row', async () => {
    const externalId = uniqueExternalId();
    const row = await repo.create({
      name: 'live', userId: USER_A, externalId, provider: 'salesforce',
    });
    expect(await asUserA(() => repo.findByExternalId(externalId))).not.toBeNull();

    await repo.delete(row.id);
    // Pre-fix this still returned the row: `.where(eq(externalId, …))` REPLACED
    // the `deleted_at IS NULL AND user_id = …` predicate baseQuery() applied.
    expect(await asUserA(() => repo.findByExternalId(externalId))).toBeNull();
  });

  test('findByExternalId skips another user\'s row', async () => {
    const externalId = uniqueExternalId();
    await repo.create({
      name: 'other', userId: USER_B, externalId, provider: 'salesforce',
    });

    expect(await asUserA(() => repo.findByExternalId(externalId))).toBeNull();
  });

  test('findManyByExternalIds returns only the live, owned row', async () => {
    const { live, deleted, otherUser } = await seed();

    const found = await asUserA(() =>
      repo.findManyByExternalIds([live.externalId, deleted.externalId, otherUser.externalId]),
    );
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(live.id);
  });

  test('findAllByUserId still honours the soft-delete guard', async () => {
    const { live, deleted } = await seed();

    const found = await asUserA(() => repo.findAllByUserId(USER_A));
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(live.id);
    expect(found.some((r: any) => r.id === deleted.id)).toBe(false);
  });

  test('a leaf predicate cannot reach across the user scope', async () => {
    const { otherUser } = await seed();

    // Asking for USER_B's rows BY NAME, as USER_A: the leaf predicate matches,
    // the scope does not. Pre-fix the scope was gone and this returned the row.
    const found = await asUserA(() => repo.findAllByUserId(USER_B));
    expect(found).toHaveLength(0);
    expect(otherUser.id).toBeDefined();
  });
});

// ============================================================================
// Per-family finders — every finder on every family base, each proven against
// BOTH guards: a soft-deleted row and another user's row must be excluded.
// ============================================================================

const SUBJECT = 'opp-scope-1';
const OCCURRED_AT = new Date('2025-01-15T12:00:00Z');

/**
 * Three activities that ALL match every finder's leaf predicate (same subject,
 * same date, userId filter aside): live + owned, soft-deleted + owned, live +
 * another user's. Only the first may come back.
 */
async function seedActivities() {
  const base = { opportunityId: SUBJECT, occurredAt: OCCURRED_AT };
  const live = await activityRepo.create({ ...base, name: 'live', userId: USER_A });
  const deleted = await activityRepo.create({ ...base, name: 'deleted', userId: USER_A });
  await activityRepo.delete(deleted.id);
  const otherUser = await activityRepo.create({ ...base, name: 'other', userId: USER_B });
  return { live, deleted, otherUser };
}

d('ActivityEntityRepository finders keep both guards', () => {
  test('findByDateRange', async () => {
    const { live } = await seedActivities();
    const found = await asUserA(() =>
      activityRepo.findByDateRange(
        new Date('2025-01-01T00:00:00Z'),
        new Date('2025-01-31T00:00:00Z'),
      ),
    );
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });

  test('findByUserId — soft-deleted row excluded', async () => {
    const { live } = await seedActivities();
    const found = await asUserA(() => activityRepo.findByUserId(USER_A));
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });

  test('findByUserId — another user\'s rows unreachable by predicate', async () => {
    await seedActivities();
    expect(await asUserA(() => activityRepo.findByUserId(USER_B))).toHaveLength(0);
  });

  test('findBySubjectId', async () => {
    const { live } = await seedActivities();
    const found = await asUserA(() => activityRepo.findBySubjectId(SUBJECT));
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });

  test('findRecentBySubjectId', async () => {
    const { live } = await seedActivities();
    const found = await asUserA(() => activityRepo.findRecentBySubjectId(SUBJECT, 10));
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });
});

const ENTITY_ID = 'entity-scope-1';
const ENTITY_TYPE = 'contact';

/** Same shape as `seedActivities`, for the metadata family. */
async function seedMetadata() {
  const base = { entityId: ENTITY_ID, entityType: ENTITY_TYPE, fieldValue: 'v' };
  const live = await metadataRepo.create({ ...base, fieldName: 'live', userId: USER_A });
  const deleted = await metadataRepo.create({ ...base, fieldName: 'deleted', userId: USER_A });
  await metadataRepo.delete(deleted.id);
  const otherUser = await metadataRepo.create({ ...base, fieldName: 'other', userId: USER_B });
  return { live, deleted, otherUser };
}

d('MetadataEntityRepository finders keep both guards', () => {
  test('findByEntityIdAndType', async () => {
    const { live } = await seedMetadata();
    const found = await asUserA(() =>
      metadataRepo.findByEntityIdAndType(ENTITY_ID, ENTITY_TYPE),
    );
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });

  test('listByEntityId', async () => {
    const { live } = await seedMetadata();
    const found = await asUserA(() => metadataRepo.listByEntityId(ENTITY_ID));
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });

  test('listHistoryByEntityId', async () => {
    const { live } = await seedMetadata();
    const found = await asUserA(() => metadataRepo.listHistoryByEntityId(ENTITY_ID));
    expect(found.map((r: any) => r.id)).toEqual([live.id]);
  });
});
