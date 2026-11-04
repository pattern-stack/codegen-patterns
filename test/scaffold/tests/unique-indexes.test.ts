/**
 * #784 -- `unique_indexes:` shapes against the DDL `drizzle-kit push` builds
 * from the generated entity files: partial indexes (`revision`) and the
 * tenant NULLS NOT DISTINCT default, explicit form and opt-out (`category`).
 *
 * Rows go in through the Drizzle client, bypassing the repository: the subject
 * is the constraint, not scoping. A rejection is asserted by SQLSTATE AND by
 * constraint name, read from `(err.cause ?? err)`, so it is tied to the emitted
 * constraint and not to some other one.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 -- see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let revisions: any;
let categories: any;
let sql: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ revisions, categories } = await import('../schema'));
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

const rev = (status: string, version: number | null) => ({
  documentId: DOC,
  version,
  status,
});

d('partial unique indexes (revision)', () => {
  test('P1: two published revisions with one (document, version) are rejected', async () => {
    const db = getTestDb();
    await db.insert(revisions).values(rev('published', 1));
    const err = await violation(() => db.insert(revisions).values(rev('published', 1)));
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('revisions_published_version_uniq');
  });

  test('P2: the same (document, version) once published and once archived is allowed', async () => {
    const db = getTestDb();
    await db.insert(revisions).values(rev('published', 1));
    const err = await violation(() => db.insert(revisions).values(rev('archived', 1)));
    expect(err).toBeNull();
  });

  test('P3: two drafts for one document (version NULL) are rejected', async () => {
    const db = getTestDb();
    await db.insert(revisions).values(rev('draft', null));
    const err = await violation(() => db.insert(revisions).values(rev('draft', null)));
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('revisions_one_draft_uniq');
  });

  test('P4: a draft and a published revision for one document are allowed', async () => {
    const db = getTestDb();
    await db.insert(revisions).values(rev('draft', null));
    const err = await violation(() => db.insert(revisions).values(rev('published', 1)));
    expect(err).toBeNull();
  });
});

d('tenant NULLS NOT DISTINCT default and opt-out (category)', () => {
  let n = 0;
  const cat = (tenantId: string | null, over: Record<string, unknown>) => ({
    tenantId,
    code: 'c',
    slug: `slug-${n++}`,
    ...over,
  });

  test('N1: explicit NND -- (tenant A, NULL parent, code) twice is rejected', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(TENANT_A, { parentId: null, code: 'x' }));
    const err = await violation(() =>
      db.insert(categories).values(cat(TENANT_A, { parentId: null, code: 'x' })),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('categories_tenant_id_parent_id_code_uniq');
  });

  test('N2: explicit NND -- the NULL tenant is one partition', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(null, { parentId: null, code: 'x' }));
    const err = await violation(() =>
      db.insert(categories).values(cat(null, { parentId: null, code: 'x' })),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('categories_tenant_id_parent_id_code_uniq');
  });

  test('D1: the default is NND -- slug twice with the NULL tenant is rejected', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(null, { slug: 's', code: 'a' }));
    const err = await violation(() => db.insert(categories).values(cat(null, { slug: 's', code: 'b' })));
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('categories_tenant_id_slug_uniq');
  });

  test('D2: the same slug in two tenants is allowed', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(TENANT_A, { slug: 's', code: 'a' }));
    const err = await violation(() => db.insert(categories).values(cat(TENANT_B, { slug: 's', code: 'b' })));
    expect(err).toBeNull();
  });

  test('O1: opt-out -- external_code twice with the NULL tenant is allowed', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(null, { externalCode: 'e', code: 'a' }));
    const err = await violation(() =>
      db.insert(categories).values(cat(null, { externalCode: 'e', code: 'b' })),
    );
    expect(err).toBeNull();
  });

  test('O2: opt-out -- external_code twice in one tenant is rejected', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(TENANT_A, { externalCode: 'e', code: 'a' }));
    const err = await violation(() =>
      db.insert(categories).values(cat(TENANT_A, { externalCode: 'e', code: 'b' })),
    );
    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('categories_tenant_id_external_code_uniq');
  });

  test('O3: opt-out -- external_code NULL twice in one tenant is allowed', async () => {
    const db = getTestDb();
    await db.insert(categories).values(cat(TENANT_A, { externalCode: null, code: 'a' }));
    const err = await violation(() =>
      db.insert(categories).values(cat(TENANT_A, { externalCode: null, code: 'b' })),
    );
    expect(err).toBeNull();
  });
});

d('unique shapes as created (catalog)', () => {
  test('K1: each builder produced its own DDL shape', async () => {
    const db = getTestDb();
    const rows = (res: any): any[] => res.rows ?? res;

    const con = rows(
      await db.execute(
        sql`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conname IN ('categories_tenant_id_slug_uniq', 'categories_tenant_id_external_code_uniq')`,
      ),
    );
    const defs = new Map(con.map((r: any) => [r.conname, r.def as string]));
    expect(defs.get('categories_tenant_id_slug_uniq')).toContain('NULLS NOT DISTINCT');
    // the opt-out is a plain unique INDEX, not a constraint
    expect(defs.has('categories_tenant_id_external_code_uniq')).toBe(false);

    const idx = rows(
      await db.execute(
        sql`SELECT indexname, indexdef FROM pg_indexes
             WHERE schemaname = 'public'
               AND indexname IN ('categories_tenant_id_external_code_uniq', 'revisions_published_version_uniq')`,
      ),
    );
    const byName = new Map(idx.map((r: any) => [r.indexname, r.indexdef as string]));
    expect(byName.has('categories_tenant_id_external_code_uniq')).toBe(true);
    const partial = byName.get('revisions_published_version_uniq') ?? '';
    expect(partial).toContain('WHERE');
    expect(partial).toContain('published');
  });
});
