/**
 * #511 — a field's `unique: true` emits a unique index, per tenant under
 * `tenant_scoped` (a NULLS NOT DISTINCT constraint there, #784). Proven against the DDL `drizzle-kit push` creates from the
 * generated entity files (`account_profile` non-tenant, `asset_tag` tenant).
 *
 * SQLSTATE and the violated index name are read from the driver error
 * (`(err.cause ?? err)`, since Drizzle 1.0 wraps query errors), so each
 * rejection is tied to the emitted index and not to the PK or another
 * constraint.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let accounts: any;
let accountProfiles: any;
let assetTags: any;
let sql: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  // Generated table exports keep the table's snake_case name (NAME-2): `account_profiles`, `asset_tags`.
  ({ accounts, account_profiles: accountProfiles, asset_tags: assetTags } = await import('../schema'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ sql } = await import('drizzle-orm'));
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

/** Run `fn`, return the (unwrapped) driver error it throws, or null. */
async function violation(fn: () => Promise<unknown>): Promise<any | null> {
  try {
    await fn();
    return null;
  } catch (err: any) {
    return err?.cause ?? err;
  }
}

async function twoAccounts() {
  const db = getTestDb();
  const [a1] = await db.insert(accounts).values({ name: 'one' }).returning();
  const [a2] = await db.insert(accounts).values({ name: 'two' }).returning();
  return [a1.id as string, a2.id as string] as const;
}

d('field unique: true, non-tenant (account_profile)', () => {
  test('U1: a duplicate handle is rejected by account_profiles_handle_uniq', async () => {
    const db = getTestDb();
    const [a1, a2] = await twoAccounts();
    await db.insert(accountProfiles).values({ accountId: a1, handle: 'dup' });
    const err = await violation(() =>
      db.insert(accountProfiles).values({ accountId: a2, handle: 'dup' }),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('account_profiles_handle_uniq');
  });

  test('U2: a second profile for one account is rejected (one-to-one)', async () => {
    const db = getTestDb();
    const [a1] = await twoAccounts();
    await db.insert(accountProfiles).values({ accountId: a1, handle: 'first' });
    const err = await violation(() =>
      db.insert(accountProfiles).values({ accountId: a1, handle: 'second' }),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('account_profiles_account_id_uniq');
  });

  test('U3: ON CONFLICT (handle) has an arbiter', async () => {
    const db = getTestDb();
    const [a1, a2] = await twoAccounts();
    await db.insert(accountProfiles).values({ accountId: a1, handle: 'same' });
    await db
      .insert(accountProfiles)
      .values({ accountId: a2, handle: 'same' })
      .onConflictDoNothing({ target: accountProfiles.handle });
    const rows = await db.select().from(accountProfiles);
    expect(rows.length).toBe(1);
  });
});

d('field unique: true, indexes as created (pg_indexes)', () => {
  test('U4: the unique indexes exist, the redundant plain index does not', async () => {
    const db = getTestDb();
    const res = await db.execute(
      sql`SELECT tablename, indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND tablename IN ('account_profiles', 'asset_tags')`,
    );
    const rows: Array<{ tablename: string; indexname: string; indexdef: string }> =
      (res as any).rows ?? (res as any);
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    for (const name of ['account_profiles_handle_uniq', 'account_profiles_account_id_uniq']) {
      expect(byName.get(name)).toContain('CREATE UNIQUE INDEX');
    }
    // unique + index on a non-tenant field -> only the unique index
    expect(byName.has('account_profiles_account_id_idx')).toBe(false);

    const tenantUnique = byName.get('asset_tags_tenant_id_code_uniq');
    expect(tenantUnique).toContain('CREATE UNIQUE INDEX');
    expect(tenantUnique).toContain('(tenant_id, code)');
    // tenant_scoped keeps the author's plain index; no bare global unique
    expect(byName.has('asset_tags_code_idx')).toBe(true);
    expect(byName.has('asset_tags_code_uniq')).toBe(false);
  });
});

d('field unique: true, tenant_scoped (asset_tag)', () => {
  test('T1: the same code in two tenants is allowed', async () => {
    const db = getTestDb();
    await db.insert(assetTags).values({ tenantId: TENANT_A, code: 'shared' });
    const err = await violation(() =>
      db.insert(assetTags).values({ tenantId: TENANT_B, code: 'shared' }),
    );
    expect(err).toBeNull();
  });

  test('T2: the same code twice in one tenant is rejected', async () => {
    const db = getTestDb();
    await db.insert(assetTags).values({ tenantId: TENANT_A, code: 'dup' });
    const err = await violation(() =>
      db.insert(assetTags).values({ tenantId: TENANT_A, code: 'dup' }),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('asset_tags_tenant_id_code_uniq');
  });

  test('T3: the same code twice in the NULL tenant is rejected (NULLS NOT DISTINCT, #784)', async () => {
    const db = getTestDb();
    await db.insert(assetTags).values({ tenantId: null, code: 'dup' });
    const err = await violation(() =>
      db.insert(assetTags).values({ tenantId: null, code: 'dup' }),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('asset_tags_tenant_id_code_uniq');
  });
});
