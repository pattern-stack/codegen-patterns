/**
 * TEN-1 (#585) / ADR-042 — cross-tenant isolation, against real Postgres.
 *
 * Isolation is a security property (epic #580 exit criteria, charter I3), so
 * the load-bearing proofs are integration tests, not unit tests over fakes. A
 * mock cannot tell a `WHERE tenant_id = $1 AND id = $2` from a `WHERE id = $2`
 * that replaced it — which is precisely the class of defect SCOPE-0 (#616)
 * found shipped seventeen times.
 *
 * Every assertion below is of the same shape: acting as tenant A, tenant B's
 * rows are invisible and untouchable. A read, a write, an upsert and a delete
 * each get their own proof, plus the two failure modes — no context at all, and
 * a context that forgot the tenant.
 *
 * ## What this file reaches
 *
 * The repository under test extends the REAL `BaseRepository`, imported through
 * `@gen/runtime/base-classes/base-repository` and NOT `@shared/base-classes/…`:
 * the latter resolves scaffold-first to a hand-written stub with no
 * `baseQuery`, no `scopeAnd` and no `behaviors` at all (#608). A sibling
 * assertion pins that, because the whole file is meaningless against the stub.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

// Real uuids — the emitted column is `uuid`, and Postgres rejects anything else.
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'user-tenant-a';
const USER_B = 'user-tenant-b';

let withRequester: any;
let withAllTenants: any;
let withTenantScope: any;
let MissingTenantIdError: any;
let CrossTenantWriteError: any;
let SYSTEM_ACTOR_ID: any;
let BaseRepository: any;
let IntegratedEntityRepository: any;
let MetadataEntityRepository: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let tenantEntities: any;
let tenantCrmEntities: any;
let tenantMetadataEntities: any;
let jobRuns: any;
let jobs: any;
let eq: any;
let and: any;
let isNull: any;

let repo: any;
let userRepo: any;
let integratedRepo: any;
let metadataRepo: any;

let counter = 0;
const uniqueExternalId = () => `ext-tenant-${++counter}-${Date.now()}`;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;

  ({
    withRequester,
    withAllTenants,
    withTenantScope,
    MissingTenantIdError,
    CrossTenantWriteError,
    SYSTEM_ACTOR_ID,
  } = await import('@gen/runtime/base-classes/tenant-context'));

  // The REAL base class, deliberately NOT through `@shared/` (#608).
  ({ BaseRepository } = await import('@gen/runtime/base-classes/base-repository'));
  ({ IntegratedEntityRepository } = await import(
    '@gen/runtime/base-classes/integrated-entity-repository'
  ));
  ({ MetadataEntityRepository } = await import(
    '@gen/runtime/base-classes/metadata-entity-repository'
  ));

  ({ tenantEntities, tenantCrmEntities, tenantMetadataEntities } = await import(
    '../schema'
  ));
  ({ jobRuns, jobs } = await import(
    '@shared/subsystems/jobs/job-orchestration.schema'
  ));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ eq, and, isNull } = await import('drizzle-orm'));

  /** Tenant scope only — isolates the tenant axis from the user axis. */
  class TenantScopedRepository extends BaseRepository<any, any> {
    readonly table = tenantEntities;
    protected readonly behaviors = {
      timestamps: true,
      softDelete: true,
      userTracking: false,
      tenantScoped: true,
    };
    // Exactly what the template emits for `tenant_scoped: true`.
    protected readonly scopeEnforcement = 'strict' as const;
  }
  repo = new TenantScopedRepository(getTestDb() as any);

  /** BOTH axes at once — neither predicate may drop the other. */
  class TenantAndUserScopedRepository extends BaseRepository<any, any> {
    readonly table = tenantEntities;
    protected readonly behaviors = {
      timestamps: true,
      softDelete: true,
      userTracking: true,
      tenantScoped: true,
    };
    protected readonly scopeEnforcement = 'strict' as const;
  }
  userRepo = new TenantAndUserScopedRepository(getTestDb() as any);

  /** The conflict-target write path (TEN-1 §5.1). */
  class TenantIntegratedRepository extends IntegratedEntityRepository<any, any> {
    readonly table = tenantCrmEntities;
    protected readonly behaviors = {
      timestamps: true,
      softDelete: true,
      userTracking: false,
      tenantScoped: true,
    };
    protected readonly scopeEnforcement = 'strict' as const;
    protected readonly integrationConfig = {
      // What the generator emits for a tenant-scoped Integrated entity.
      conflictTarget: ['tenantId', 'provider', 'externalId'],
      writeColumns: ['name'],
      fkResolvers: [],
      projectionColumns: ['id', 'externalId', 'name'],
      eav: false,
      softDelete: true,
    };
  }
  integratedRepo = new TenantIntegratedRepository(getTestDb() as any);

  /** The caller-supplied conflict target that must fail closed (§5.2). */
  class TenantMetadataRepository extends MetadataEntityRepository<any, any> {
    readonly table = tenantMetadataEntities;
    protected readonly behaviors = {
      timestamps: true,
      softDelete: false,
      userTracking: false,
      tenantScoped: true,
    };
    protected readonly scopeEnforcement = 'strict' as const;
  }
  metadataRepo = new TenantMetadataRepository(getTestDb() as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

const asTenant = <T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> =>
  withRequester({ userId: USER_A, organizationId: null, tenantId }, fn);

const asTenantUser = <T>(
  tenantId: string | null,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> => withRequester({ userId, organizationId: null, tenantId }, fn);

/** One row per tenant, plus one in the null partition. */
async function seed() {
  const a = await asTenant(TENANT_A, () => repo.create({ name: 'a-row' }));
  const b = await asTenant(TENANT_B, () => repo.create({ name: 'b-row' }));
  const nil = await asTenant(null, () => repo.create({ name: 'null-row' }));
  return { a, b, nil };
}

// ============================================================================
// The harness itself — this file is meaningless if it tests the #608 stub
// ============================================================================

d('the repository under test is the real BaseRepository', () => {
  test('it has the scoped choke points, not the scaffold stub', () => {
    const proto = Object.getPrototypeOf(repo);
    // The stub (#608) has none of these; assert before trusting anything below.
    expect(typeof (proto as any).scopeAnd ?? undefined).toBeDefined();
    expect(Object.getOwnPropertyNames(BaseRepository.prototype)).toContain('scopeAnd');
    expect(Object.getOwnPropertyNames(BaseRepository.prototype)).toContain('tenantPredicate');
    expect(Object.getOwnPropertyNames(BaseRepository.prototype)).toContain('stampTenant');
    expect(Object.getOwnPropertyNames(BaseRepository.prototype)).toContain('baseQuery');
  });
});

// ============================================================================
// Reads — tenant A cannot SEE tenant B
// ============================================================================

d('reads are tenant-scoped', () => {
  test('findById returns null for another tenant\'s row — not a 403, not a row', async () => {
    const { a, b } = await seed();
    // No existence oracle: the answer is identical to "truly does not exist".
    expect(await asTenant(TENANT_A, () => repo.findById(b.id))).toBeNull();
    expect(await asTenant(TENANT_A, () => repo.findById(a.id))).not.toBeNull();
  });

  test('findByIds returns only this tenant\'s rows', async () => {
    const { a, b, nil } = await seed();
    const found = await asTenant(TENANT_A, () =>
      repo.findByIds([a.id, b.id, nil.id]),
    );
    expect(found.map((r: any) => r.id)).toEqual([a.id]);
  });

  test('list returns only this tenant\'s rows', async () => {
    const { a } = await seed();
    const rows = await asTenant(TENANT_A, () => repo.list());
    expect(rows.map((r: any) => r.id)).toEqual([a.id]);
  });

  test('a caller predicate cannot reach across the boundary', async () => {
    await seed();
    // Asking for B's row BY NAME, as A: the leaf predicate matches, the tenant
    // does not. This is the shape that was broken for the user axis (#616).
    const rows = await asTenant(TENANT_A, () =>
      repo.list({ where: eq(tenantEntities.name, 'b-row') }),
    );
    expect(rows).toHaveLength(0);
  });

  test('count counts only this tenant', async () => {
    await seed();
    expect(await asTenant(TENANT_A, () => repo.count())).toBe(1);
    expect(await asTenant(TENANT_B, () => repo.count())).toBe(1);
    expect(
      await asTenant(TENANT_A, () => repo.count(eq(tenantEntities.name, 'b-row'))),
    ).toBe(0);
  });

  test('exists is false for another tenant\'s row', async () => {
    const { a, b } = await seed();
    expect(await asTenant(TENANT_A, () => repo.exists(b.id))).toBe(false);
    expect(await asTenant(TENANT_A, () => repo.exists(a.id))).toBe(true);
  });
});

// ============================================================================
// Writes — tenant A cannot TOUCH tenant B
// ============================================================================

d('writes are tenant-scoped', () => {
  test('create stamps the ambient tenant with no tenantId in the input', async () => {
    const row = await asTenant(TENANT_A, () => repo.create({ name: 'x' }));
    expect(row.tenantId).toBe(TENANT_A);
  });

  test('create REJECTS an explicit tenantId naming another tenant', async () => {
    // Request-scope code must not be able to name a tenant. `scopeAnd()` guards
    // which rows a statement can SEE; nothing guarded what an insert WRITES, so
    // `create({ tenantId: B })` under tenant A silently wrote into B.
    await expect(
      asTenant(TENANT_A, () => repo.create({ name: 'x', tenantId: TENANT_B })),
    ).rejects.toThrow(CrossTenantWriteError);

    // Row-level, not message-level: nothing may have landed in B.
    expect(await asTenant(TENANT_B, () => repo.count())).toBe(0);
    expect(await asTenant(TENANT_A, () => repo.count())).toBe(0);
  });

  test('create ACCEPTS an explicit tenantId that agrees with the ambient one', async () => {
    // Round-tripping a row must keep working; only disagreement is an error.
    const row = await asTenant(TENANT_A, () =>
      repo.create({ name: 'x', tenantId: TENANT_A }),
    );
    expect(row.tenantId).toBe(TENANT_A);
  });

  test('update REJECTS a tenantId in the SET payload', async () => {
    // `scopeAnd()` guards WHICH row is updated, not WHAT is written to it, so
    // a caller could re-parent their own row into another tenant.
    const { a } = await seed();
    await expect(
      asTenant(TENANT_A, () => repo.update(a.id, { name: 'moved', tenantId: TENANT_B })),
    ).rejects.toThrow(CrossTenantWriteError);

    // The row is still A's, and still un-renamed.
    const stillA = await asTenant(TENANT_A, () => repo.findById(a.id));
    expect(stillA?.tenantId).toBe(TENANT_A);
    expect(stillA?.name).toBe('a-row');
    expect(await asTenant(TENANT_B, () => repo.findById(a.id))).toBeNull();
  });

  test('update ACCEPTS a tenantId that agrees with the ambient one', async () => {
    const { a } = await seed();
    const updated = await asTenant(TENANT_A, () =>
      repo.update(a.id, { name: 'renamed', tenantId: TENANT_A }),
    );
    expect(updated.name).toBe('renamed');
    expect(updated.tenantId).toBe(TENANT_A);
  });

  test('update on another tenant\'s row changes nothing', async () => {
    const { b } = await seed();
    const result = await asTenant(TENANT_A, () =>
      repo.update(b.id, { name: 'hijacked' }),
    );
    expect(result).toBeUndefined();

    const stillB = await asTenant(TENANT_B, () => repo.findById(b.id));
    expect(stillB.name).toBe('b-row');
  });

  test('soft delete on another tenant\'s row leaves it alive', async () => {
    const { b } = await seed();
    await asTenant(TENANT_A, () => repo.delete(b.id));
    expect(await asTenant(TENANT_B, () => repo.findById(b.id))).not.toBeNull();
  });

  test('hard delete on another tenant\'s row leaves it alive', async () => {
    class HardDeleteRepo extends BaseRepository<any, any> {
      readonly table = tenantEntities;
      protected readonly behaviors = {
        timestamps: true,
        softDelete: false,
        userTracking: false,
        tenantScoped: true,
      };
      protected readonly scopeEnforcement = 'strict' as const;
    }
    const hard = new HardDeleteRepo(getTestDb() as any);
    const b = await asTenant(TENANT_B, () => hard.create({ name: 'b-hard' }));

    await asTenant(TENANT_A, () => hard.delete(b.id));
    expect(await asTenant(TENANT_B, () => hard.findById(b.id))).not.toBeNull();

    // …and the owner can still delete it, so the guard is not simply broken.
    await asTenant(TENANT_B, () => hard.delete(b.id));
    expect(await asTenant(TENANT_B, () => hard.findById(b.id))).toBeNull();
  });

  test('upsertMany (the create-delegating default) stamps every row', async () => {
    const rows = await asTenant(TENANT_A, () =>
      repo.upsertMany([{ name: 'u1' }, { name: 'u2' }]),
    );
    expect(rows.map((r: any) => r.tenantId)).toEqual([TENANT_A, TENANT_A]);
  });
});

// ============================================================================
// The conflict-target upsert — the write path scopeAnd() cannot reach (§5.1)
// ============================================================================

d('ON CONFLICT upserts are tenant-scoped', () => {
  const write = (externalId: string, name: string) => ({ externalId, name });

  test('two tenants may hold the same external id, as separate rows', async () => {
    const externalId = uniqueExternalId();

    const a = await asTenant(TENANT_A, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'a-name'), 'salesforce'),
    );
    const b = await asTenant(TENANT_B, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'b-name'), 'salesforce'),
    );

    // Pre-fix this was ONE row: tenant B's sync UPDATED tenant A's row.
    expect(a.id).not.toBe(b.id);
    expect(await asTenant(TENANT_A, () => integratedRepo.count())).toBe(1);
    expect(await asTenant(TENANT_B, () => integratedRepo.count())).toBe(1);
  });

  test('a second run in the same tenant updates in place (still idempotent)', async () => {
    const externalId = uniqueExternalId();
    const first = await asTenant(TENANT_A, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'v1'), 'salesforce'),
    );
    const second = await asTenant(TENANT_A, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'v2'), 'salesforce'),
    );
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('v2');
    expect(await asTenant(TENANT_A, () => integratedRepo.count())).toBe(1);
  });

  test('an upsert never rewrites a conflicting row\'s owning tenant', async () => {
    const externalId = uniqueExternalId();
    const a = await asTenant(TENANT_A, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'v1'), 'salesforce'),
    );
    await asTenant(TENANT_A, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'v2'), 'salesforce'),
    );
    const row = await asTenant(TENANT_A, () => integratedRepo.findById(a.id));
    expect(row.tenantId).toBe(TENANT_A);
  });

  test('findByExternalIdProjected does not see another tenant\'s row', async () => {
    const externalId = uniqueExternalId();
    await asTenant(TENANT_B, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'b'), 'salesforce'),
    );
    expect(
      await asTenant(TENANT_A, () =>
        integratedRepo.findByExternalIdProjected(externalId, 'salesforce'),
      ),
    ).toBeNull();
  });

  test('softDeleteByExternalId cannot tombstone another tenant\'s row', async () => {
    const externalId = uniqueExternalId();
    const b = await asTenant(TENANT_B, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'b'), 'salesforce'),
    );
    expect(
      await asTenant(TENANT_A, () =>
        integratedRepo.softDeleteByExternalId(externalId, 'salesforce'),
      ),
    ).toBeNull();
    expect(await asTenant(TENANT_B, () => integratedRepo.findById(b.id))).not.toBeNull();
  });

  test('the null-tenant partition upserts on its own row (NULLS NOT DISTINCT)', async () => {
    // Without `nullsNotDistinct()` on the constraint, Postgres treats every
    // null-tenant row as distinct, the ON CONFLICT never fires, and this
    // inserts a duplicate instead of updating.
    const externalId = uniqueExternalId();
    const first = await asTenant(null, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'v1'), 'salesforce'),
    );
    const second = await asTenant(null, () =>
      integratedRepo.integrationUpsertOne(write(externalId, 'v2'), 'salesforce'),
    );
    expect(second.id).toBe(first.id);
    expect(await asTenant(null, () => integratedRepo.count())).toBe(1);
  });

  test('a caller-supplied conflict target fails CLOSED on a tenant-scoped repo (§5.2)', async () => {
    await expect(
      asTenant(TENANT_A, () =>
        metadataRepo.upsertMany(
          [{ entityType: 'contact', entityId: 'e1', fieldName: 'f', fieldValue: 'v' }],
          undefined,
          { conflictTarget: 'entityId' },
        ),
      ),
    ).rejects.toThrow(/not supported on a tenant-scoped repository/);
  });

  test('…and the conflictTarget-less path still works (it delegates to create)', async () => {
    const rows = await asTenant(TENANT_A, () =>
      metadataRepo.upsertMany([
        { entityType: 'contact', entityId: 'e1', fieldName: 'f', fieldValue: 'v' },
      ]),
    );
    expect(rows[0].tenantId).toBe(TENANT_A);
  });
});

// ============================================================================
// Failure modes — a missing tenant is loud, never an unscoped read
// ============================================================================

d('a missing tenant fails closed', () => {
  test('no ambient context at all → every read and write throws', async () => {
    const { a } = await seed();
    await expect(repo.findById(a.id)).rejects.toThrow(/No requester context active/);
    await expect(repo.list()).rejects.toThrow(/No requester context active/);
    await expect(repo.count()).rejects.toThrow(/No requester context active/);
    await expect(repo.create({ name: 'x' })).rejects.toThrow(
      /No requester context active/,
    );
    await expect(repo.update(a.id, { name: 'x' })).rejects.toThrow(
      /No requester context active/,
    );
    await expect(repo.delete(a.id)).rejects.toThrow(/No requester context active/);
  });

  test('a context with NO tenantId → MissingTenantIdError on read AND write', async () => {
    const { a } = await seed();
    const noTenant = <T>(fn: () => Promise<T>) =>
      withRequester({ userId: USER_A, organizationId: null }, fn);

    // The single most dangerous case: under ADR-042's original sketch this
    // returned `undefined` and read the union of every tenant.
    await expect(noTenant(() => repo.findById(a.id))).rejects.toThrow(
      MissingTenantIdError,
    );
    await expect(noTenant(() => repo.list())).rejects.toThrow(MissingTenantIdError);
    await expect(noTenant(() => repo.create({ name: 'x' }))).rejects.toThrow(
      MissingTenantIdError,
    );
  });

  test('a failed read returns NO rows — it never degrades to unscoped', async () => {
    await seed();
    const noTenant = <T>(fn: () => Promise<T>) =>
      withRequester({ userId: USER_A, organizationId: null }, fn);
    let rows: unknown = 'not assigned';
    try {
      rows = await noTenant(() => repo.list());
    } catch {
      /* expected */
    }
    expect(rows).toBe('not assigned');
  });
});

// ============================================================================
// The null partition and the escape hatches
// ============================================================================

d('the null-tenant partition', () => {
  test('sees only tenant_id IS NULL rows — it is a partition, not a wildcard', async () => {
    const { nil } = await seed();
    const rows = await asTenant(null, () => repo.list());
    expect(rows.map((r: any) => r.id)).toEqual([nil.id]);
  });

  test('a tenant does not see the null partition either', async () => {
    const { a } = await seed();
    const rows = await asTenant(TENANT_A, () => repo.list());
    expect(rows.map((r: any) => r.id)).toEqual([a.id]);
  });
});

d('escape hatches', () => {
  test('withAllTenants reads across every tenant', async () => {
    const { a, b, nil } = await seed();
    const rows = await asTenant(TENANT_A, () =>
      withAllTenants(() => repo.list()),
    );
    expect(rows.map((r: any) => r.id).sort()).toEqual([a.id, b.id, nil.id].sort());
  });

  test('withAllTenants REFUSES a write that does not name its owner', async () => {
    await expect(
      asTenant(TENANT_A, () => withAllTenants(() => repo.create({ name: 'x' }))),
    ).rejects.toThrow(MissingTenantIdError);
  });

  test('withAllTenants permits an insert that names its owner', async () => {
    const row = await asTenant(TENANT_A, () =>
      withAllTenants(() => repo.create({ name: 'x', tenantId: TENANT_B })),
    );
    expect(row.tenantId).toBe(TENANT_B);
  });

  test('withAllTenants REFUSES a by-id update — there is no tenant to write within', async () => {
    // The tenant predicate is dropped inside this block, so `scopeAnd()` would
    // have matched ANY tenant's row by id. An admin that means to write must
    // narrow to one tenant first, with withTenantScope.
    const { b } = await seed();
    await expect(
      asTenant(TENANT_A, () => withAllTenants(() => repo.update(b.id, { name: 'hijacked' }))),
    ).rejects.toThrow(CrossTenantWriteError);

    const stillB = await asTenant(TENANT_B, () => repo.findById(b.id));
    expect(stillB?.name).toBe('b-row');
  });

  test('withAllTenants REFUSES a by-id delete', async () => {
    const { b } = await seed();
    await expect(
      asTenant(TENANT_A, () => withAllTenants(() => repo.delete(b.id))),
    ).rejects.toThrow(CrossTenantWriteError);

    expect(await asTenant(TENANT_B, () => repo.findById(b.id))).not.toBeNull();
  });

  test('withTenantScope is the way to write across the boundary deliberately', async () => {
    // The hatch that NAMES its tenant works, so the refusal above is a
    // redirection rather than a dead end.
    const { b } = await seed();
    const updated = await asTenant(TENANT_A, () =>
      withTenantScope(TENANT_B, () => repo.update(b.id, { name: 'by-admin' })),
    );
    expect(updated.name).toBe('by-admin');
    expect(updated.tenantId).toBe(TENANT_B);
  });

  test('withTenantScope acts within another tenant', async () => {
    const { b } = await seed();
    const found = await asTenant(TENANT_A, () =>
      withTenantScope(TENANT_B, () => repo.findById(b.id)),
    );
    expect(found?.id).toBe(b.id);
  });
});

// ============================================================================
// Both axes plus soft-delete — no predicate drops another
// ============================================================================

d('tenant + user + soft-delete in one statement', () => {
  test('only the live row owned by this user in this tenant comes back', async () => {
    // Four rows that each match some of the three guards; exactly one matches all.
    const live = await asTenantUser(TENANT_A, USER_A, () =>
      userRepo.create({ name: 'live', userId: USER_A }),
    );
    const otherUser = await asTenantUser(TENANT_A, USER_B, () =>
      userRepo.create({ name: 'other-user', userId: USER_B }),
    );
    const otherTenant = await asTenantUser(TENANT_B, USER_A, () =>
      userRepo.create({ name: 'other-tenant', userId: USER_A }),
    );
    const deleted = await asTenantUser(TENANT_A, USER_A, () =>
      userRepo.create({ name: 'deleted', userId: USER_A }),
    );
    await asTenantUser(TENANT_A, USER_A, () => userRepo.delete(deleted.id));

    const rows = await asTenantUser(TENANT_A, USER_A, () => userRepo.list());
    expect(rows.map((r: any) => r.id)).toEqual([live.id]);

    // Each excluded row is reachable by SOMEONE, so none of them is simply missing.
    expect(await asTenantUser(TENANT_A, USER_B, () => userRepo.findById(otherUser.id))).not.toBeNull();
    expect(await asTenantUser(TENANT_B, USER_A, () => userRepo.findById(otherTenant.id))).not.toBeNull();
  });

  test('the user axis alone cannot substitute for the tenant axis', async () => {
    // Same user, two tenants: only the current tenant's row is visible.
    const inA = await asTenantUser(TENANT_A, USER_A, () =>
      userRepo.create({ name: 'a', userId: USER_A }),
    );
    await asTenantUser(TENANT_B, USER_A, () =>
      userRepo.create({ name: 'b', userId: USER_A }),
    );
    const rows = await asTenantUser(TENANT_A, USER_A, () => userRepo.list());
    expect(rows.map((r: any) => r.id)).toEqual([inA.id]);
  });
});

// ============================================================================
// The job path — the worker enters the ALS from the run's own tenant (§6)
// ============================================================================

/**
 * The real `JobWorker`, the real claim query, a real `job_run` row, and a
 * handler that reads the tenant-scoped repository. This is the only place the
 * whole chain — persisted `tenant_id` → `withRequester` → `scopeAnd` → SQL —
 * runs end to end.
 */
d('a job handler reads within the run\'s tenant', () => {
  async function runJobFor(
    tenantId: string | null,
  ): Promise<{ names: string[]; userScopedNames: string[]; ctx: any }> {
    const { JobWorker } = await import('@shared/subsystems/jobs/job-worker');
    const { JOB_HANDLER_REGISTRY, JobHandlerBase } = await import(
      '@shared/subsystems/jobs/job-handler.base'
    );
    const { tryGetRequester } = await import(
      '@gen/runtime/base-classes/tenant-context'
    );

    const observed: { names: string[]; userScopedNames: string[]; ctx: any } = {
      names: [],
      userScopedNames: [],
      ctx: undefined,
    };

    const JOB_TYPE = `tenant_probe_${++counter}`;
    class ProbeHandler extends JobHandlerBase<unknown, { ok: true }> {
      async run(): Promise<{ ok: true }> {
        observed.ctx = tryGetRequester();
        // The point of the whole feature: a repository read inside a handler
        // is scoped to the run's tenant, with no plumbing in the handler.
        observed.names = (await repo.list()).map((r: any) => r.name);
        // Found #5 guard: the USER axis must NOT filter to the sentinel.
        observed.userScopedNames = (await userRepo.list()).map((r: any) => r.name);
        return { ok: true };
      }
    }
    JOB_HANDLER_REGISTRY.set(JOB_TYPE, {
      handlerClass: ProbeHandler as never,
      meta: { jobType: JOB_TYPE, pool: 'batch' } as never,
    });

    const db = getTestDb();
    // `job_run.job_type` is a real FK to `job.type`, and `root_run_id` /
    // `job_version` / `trigger_source` are NOT NULL with no default — the row
    // is seeded exactly as the orchestrator would write it, so the claim query
    // under test is the real one.
    await db.insert(jobs).values({
      type: JOB_TYPE,
      version: 1,
      pool: 'batch',
      retryPolicy: { maxAttempts: 1, backoff: 'fixed', delayMs: 0 },
    });
    const runId = crypto.randomUUID();
    await db.insert(jobRuns).values({
      id: runId,
      rootRunId: runId,
      jobType: JOB_TYPE,
      jobVersion: 1,
      triggerSource: 'manual',
      pool: 'batch',
      status: 'pending',
      input: {},
      tenantId,
      runAt: new Date(),
    });

    const worker = new JobWorker(
      db as any,
      {} as never,
      {} as never,
      {} as never,
      { pool: 'batch', concurrency: 1 },
      { get: () => new ProbeHandler() } as never,
    );
    await worker.pollAndProcess();
    await (worker as any).drainInFlight?.();
    // `pollAndProcess` fires the run without awaiting it; settle the microtask
    // queue plus the handler's awaits before reading what it observed.
    for (let i = 0; i < 50 && observed.ctx === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    JOB_HANDLER_REGISTRY.delete(JOB_TYPE);
    return observed;
  }

  test('a tenant A run sees only tenant A\'s rows', async () => {
    await seed();
    const observed = await runJobFor(TENANT_A);
    expect(observed.ctx?.tenantId).toBe(TENANT_A);
    expect(observed.names).toEqual(['a-row']);
  });

  test('a tenant B run sees only tenant B\'s rows', async () => {
    await seed();
    const observed = await runJobFor(TENANT_B);
    expect(observed.names).toEqual(['b-row']);
  });

  test('a null-tenant run sees only the null partition', async () => {
    await seed();
    const observed = await runJobFor(null);
    expect(observed.ctx?.tenantId).toBeNull();
    expect(observed.names).toEqual(['null-row']);
  });

  test('a userTracking repo inside a job still returns rows (Found #5)', async () => {
    // The worker enters with `scope: 'superuser'`. Without it, every
    // userTracking read inside every job would filter `user_id = '__system__'`
    // and silently return nothing.
    await asTenantUser(TENANT_A, USER_A, () =>
      userRepo.create({ name: 'owned-by-a-user', userId: USER_A }),
    );
    const observed = await runJobFor(TENANT_A);
    expect(observed.ctx?.userId).toBe(SYSTEM_ACTOR_ID);
    expect(observed.ctx?.scope).toBe('superuser');
    expect(observed.userScopedNames).toEqual(['owned-by-a-user']);
  });

  test('the run row itself is untouched by the scope (it is not an entity)', async () => {
    await seed();
    await runJobFor(TENANT_A);
    const db = getTestDb();
    const runs = await db.select().from(jobRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(and && isNull).toBeDefined();
  });
});
