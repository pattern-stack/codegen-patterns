/**
 * BaseRepository integration tests against real Postgres.
 *
 * No NestJS, no HTTP — just Drizzle → Postgres.
 * Tests every inherited method from BaseRepository using ContactRepository.
 *
 * REL-2 (#587) deleted `test/scaffold/shared/base-classes/base-repository.ts`,
 * the stub that used to SHADOW the runtime base for this suite (REL-0 flagged it;
 * a generated repository now calls `baseQuery` / `rootScopeRaw`, which the stub
 * never had). So these tests now exercise the REAL contract, and four assertions
 * below changed because they were pinning the stub's drift, not a contract:
 *
 *   - `update()` returns the row, never null (a miss matches zero rows and the
 *     row-0 read is `undefined`, which is why the old assertion read `toBeNull`);
 *   - `delete()` returns `void`;
 *   - `findById()` DOES exclude a soft-deleted row — the whole point of the
 *     `softDelete` behavior, and the opposite of what the stub did;
 *   - `upsertMany()` inserts rather than merging partials, so a partial update
 *     through it hits the NOT NULL columns.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type Contact = any;
let ContactRepository: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let contactFactory: any;
let repo: any;

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ ContactRepository } = await import('@gen/modules/contacts/contact.repository'));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ contactFactory } = await import('./helpers'));
  repo = new ContactRepository(getTestDb() as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

d('create', () => {
  test('returns entity with generated UUID and timestamps', async () => {
    const data = contactFactory();
    const result = await repo.create(data);

    expect(result.id).toBeDefined();
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.firstName).toBe(data.firstName);
    expect(result.lastName).toBe(data.lastName);
    expect(result.email).toBe(data.email);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.deletedAt).toBeNull();
  });

  test('creates multiple distinct entities', async () => {
    const a = await repo.create(contactFactory({ firstName: 'Alice' }));
    const b = await repo.create(contactFactory({ firstName: 'Bob' }));

    expect(a.id).not.toBe(b.id);
    expect(a.firstName).toBe('Alice');
    expect(b.firstName).toBe('Bob');
  });
});

d('findById', () => {
  test('returns the correct entity', async () => {
    const created = await repo.create(contactFactory());
    const found = await repo.findById(created.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.email).toBe(created.email);
  });

  test('returns null for nonexistent ID', async () => {
    const found = await repo.findById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });
});

d('findByIds', () => {
  test('returns correct subset', async () => {
    const a = await repo.create(contactFactory({ firstName: 'Alice' }));
    const b = await repo.create(contactFactory({ firstName: 'Bob' }));
    await repo.create(contactFactory({ firstName: 'Charlie' }));

    const found = await repo.findByIds([a.id, b.id]);

    expect(found).toHaveLength(2);
    const names = found.map((c: Contact) => c.firstName).sort();
    expect(names).toEqual(['Alice', 'Bob']);
  });

  test('returns empty array for empty input', async () => {
    const found = await repo.findByIds([]);
    expect(found).toEqual([]);
  });

  test('skips nonexistent IDs', async () => {
    const a = await repo.create(contactFactory());
    const found = await repo.findByIds([a.id, '00000000-0000-0000-0000-000000000000']);
    expect(found).toHaveLength(1);
  });
});

d('list', () => {
  test('returns all non-deleted entities', async () => {
    await repo.create(contactFactory({ firstName: 'Alice' }));
    await repo.create(contactFactory({ firstName: 'Bob' }));

    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  test('returns empty array when no entities exist', async () => {
    const all = await repo.list();
    expect(all).toEqual([]);
  });
});

d('count', () => {
  test('returns correct count', async () => {
    expect(await repo.count()).toBe(0);

    await repo.create(contactFactory());
    expect(await repo.count()).toBe(1);

    await repo.create(contactFactory());
    expect(await repo.count()).toBe(2);
  });
});

d('exists', () => {
  test('returns true for existing entity', async () => {
    const created = await repo.create(contactFactory());
    expect(await repo.exists(created.id)).toBe(true);
  });

  test('returns false for nonexistent ID', async () => {
    expect(await repo.exists('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

d('update', () => {
  test('changes fields and bumps updatedAt', async () => {
    const created = await repo.create(contactFactory());

    await new Promise((r) => setTimeout(r, 10));

    const updated = await repo.update(created.id, { title: 'Mathematician' });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Mathematician');
    expect(updated!.firstName).toBe(created.firstName);
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  test('a nonexistent ID matches zero rows, so there is no row to return', async () => {
    // `update()` routes through `scopeAnd(eq(id))` and returns `rows[0]`. A miss
    // is `undefined`, not `null` — and it is a MISS rather than an error, which is
    // the "returns nothing — identical to truly doesn't exist" semantics a scoped
    // repository needs (no existence oracle).
    const result = await repo.update('00000000-0000-0000-0000-000000000000', {
      title: 'Ghost',
    });
    expect(result).toBeUndefined();
  });
});

d('delete (soft)', () => {
  test('sets deletedAt timestamp', async () => {
    const created = await repo.create(contactFactory());
    // The real contract is `Promise<void>`; the row is read back to assert on it.
    await repo.delete(created.id);

    const rows = await repo.findByIds([created.id]);
    expect(rows).toHaveLength(0); // soft-deleted rows are filtered by findByIds
    const raw = await getTestDb()
      .select()
      .from((await import('../schema')).contacts);
    const row = raw.find((r: { id: string }) => r.id === created.id);
    expect(row).toBeDefined();
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  test('soft-deleted entities excluded from list()', async () => {
    const a = await repo.create(contactFactory({ firstName: 'Alice' }));
    await repo.create(contactFactory({ firstName: 'Bob' }));

    await repo.delete(a.id);

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].firstName).toBe('Bob');
  });

  test('soft-deleted entities excluded from count()', async () => {
    const a = await repo.create(contactFactory());
    await repo.create(contactFactory());

    await repo.delete(a.id);
    expect(await repo.count()).toBe(1);
  });

  test('findById EXCLUDES a soft-deleted entity', async () => {
    const created = await repo.create(contactFactory());
    await repo.delete(created.id);

    // `baseQuery()` folds the soft-delete guard into its single WHERE, so a
    // soft-deleted row is indistinguishable from one that never existed. The
    // deleted stub did not do this, which is why the old assertion said the
    // opposite.
    expect(await repo.findById(created.id)).toBeNull();
  });

  test('deleting a nonexistent ID is a no-op, not an error', async () => {
    await expect(
      repo.delete('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});

d('upsertMany', () => {
  test('creates new entities when no id provided', async () => {
    const results = await repo.upsertMany([
      contactFactory({ firstName: 'Alice' }) as Partial<Contact>,
      contactFactory({ firstName: 'Bob' }) as Partial<Contact>,
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBeDefined();
    expect(results[1].id).toBeDefined();
  });

  test('upsertMany INSERTS every input — the base default does not merge', async () => {
    // `BaseRepository.upsertMany` is `Promise.all(inputs.map(create))`; the
    // conflict-target merge lives on the family bases (MetadataEntityRepository,
    // IntegratedEntityRepository). A full row therefore inserts; a partial one
    // hits the table's NOT NULL columns, which is the honest behaviour of this
    // default rather than a silent update.
    const created = await repo.create(contactFactory({ firstName: 'Old' }));

    const results = await repo.upsertMany([
      contactFactory({ firstName: 'New' }) as Partial<Contact>,
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].firstName).toBe('New');
    expect(results[0].id).not.toBe(created.id);
  });

  test('inserts every input in one pass', async () => {
    await repo.create(contactFactory({ firstName: 'Existing' }));

    const results = await repo.upsertMany([
      contactFactory({ firstName: 'Second' }) as Partial<Contact>,
      contactFactory({ firstName: 'Brand New' }) as Partial<Contact>,
    ]);

    expect(results).toHaveLength(2);
    expect(await repo.count()).toBe(3);
  });
});
