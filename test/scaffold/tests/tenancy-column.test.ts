/**
 * #791 — an ADOPTED tenant column, against real Postgres.
 *
 * `org_lead` is `pattern: Integrated` with `tenant_scoped: { column:
 * organization_id }` and a declared `organization_id` field. Its generated
 * entity file declares `unique(organization_id, provider, external_id) NULLS NOT
 * DISTINCT`, and its generated `integrationConfig.conflictTarget` names the same
 * three columns. Both are exercised here: `integrationUpsertOne` runs `ON
 * CONFLICT (organization_id, provider, external_id)` for real, so a conflict
 * target that named `tenant_id`, or a constraint missing the adopted column,
 * fails with 42P10 instead of compiling quietly.
 *
 * The repository under test extends the REAL `IntegratedEntityRepository`
 * (through `@gen/runtime/…`, not the scaffold's `@shared/` stub — #608) and
 * takes `behaviors`, `scopeEnforcement` and `integrationConfig` from the
 * GENERATED `OrgLeadRepository`, so what runs is what codegen emitted.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

let withRequester: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let repo: any;
let emitted: any;

const asOrg = <T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> =>
  withRequester({ userId: 'user-a', organizationId: null, tenantId }, fn);

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ withRequester } = await import('@gen/runtime/base-classes/tenant-context'));
  const { IntegratedEntityRepository } = await import(
    '@gen/runtime/base-classes/integrated-entity-repository'
  );
  const { org_leads } = await import('../schema');
  const { OrgLeadRepository } = await import('@gen/modules/org-leads/org-lead.repository');
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));

  // The generated class's own configuration, read off an instance. (Its base
  // class is the scaffold's `@shared/` stub, so it cannot run the queries.)
  emitted = new (OrgLeadRepository as any)(getTestDb() as any);

  class OrgLeadRealRepository extends (IntegratedEntityRepository as any) {
    readonly table = org_leads;
    protected readonly behaviors = emitted.behaviors;
    protected readonly scopeEnforcement = emitted.scopeEnforcement;
    protected readonly integrationConfig = emitted.integrationConfig;
  }
  repo = new OrgLeadRealRepository(getTestDb() as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

d('an adopted tenant column on an Integrated entity', () => {
  test('the generated config names the adopted column in the conflict target', () => {
    expect(emitted.behaviors.tenantColumn).toBe('organizationId');
    expect(emitted.integrationConfig.conflictTarget).toEqual([
      'organizationId',
      'provider',
      'externalId',
    ]);
  });

  const write = (externalId: string, name: string) => ({ externalId, name });

  test('two organizations may hold one external id, as separate rows', async () => {
    const a = await asOrg(ORG_A, () => repo.integrationUpsertOne(write('ext-1', 'a'), 'hubspot'));
    const b = await asOrg(ORG_B, () => repo.integrationUpsertOne(write('ext-1', 'b'), 'hubspot'));
    expect(a.id).not.toBe(b.id);
    expect(a.organizationId).toBe(ORG_A);
    expect(b.organizationId).toBe(ORG_B);
  });

  test('a second run in one organization updates in place (ON CONFLICT fires)', async () => {
    const first = await asOrg(ORG_A, () => repo.integrationUpsertOne(write('ext-2', 'v1'), 'hubspot'));
    const second = await asOrg(ORG_A, () => repo.integrationUpsertOne(write('ext-2', 'v2'), 'hubspot'));
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('v2');
    expect(second.organizationId).toBe(ORG_A);
    expect(await asOrg(ORG_A, () => repo.count())).toBe(1);
  });

  test('the null partition upserts on its own row (NULLS NOT DISTINCT)', async () => {
    const first = await asOrg(null, () => repo.integrationUpsertOne(write('ext-3', 'v1'), 'hubspot'));
    const second = await asOrg(null, () => repo.integrationUpsertOne(write('ext-3', 'v2'), 'hubspot'));
    expect(second.id).toBe(first.id);
  });
});
