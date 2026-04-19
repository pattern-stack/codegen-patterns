/**
 * BaseRepository integration tests against real Postgres.
 *
 * No NestJS, no HTTP — just Drizzle → Postgres.
 * Tests every inherited method from BaseRepository using ContactRepository.
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

  test('returns null for nonexistent ID', async () => {
    const result = await repo.update('00000000-0000-0000-0000-000000000000', {
      title: 'Ghost',
    });
    expect(result).toBeNull();
  });
});

d('delete (soft)', () => {
  test('sets deletedAt timestamp', async () => {
    const created = await repo.create(contactFactory());
    const deleted = await repo.delete(created.id);

    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe(created.id);
    expect(deleted!.deletedAt).toBeInstanceOf(Date);
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

  test('findById still returns soft-deleted entity', async () => {
    const created = await repo.create(contactFactory());
    await repo.delete(created.id);

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.deletedAt).not.toBeNull();
  });

  test('returns null for nonexistent ID', async () => {
    const result = await repo.delete('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
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

  test('updates existing entities when id provided', async () => {
    const created = await repo.create(contactFactory({ firstName: 'Old' }));

    const results = await repo.upsertMany([
      { id: created.id, firstName: 'New' } as Partial<Contact>,
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].firstName).toBe('New');
    expect(results[0].id).toBe(created.id);
  });

  test('handles mix of creates and updates', async () => {
    const existing = await repo.create(contactFactory({ firstName: 'Existing' }));

    const results = await repo.upsertMany([
      { id: existing.id, title: 'Updated' } as Partial<Contact>,
      contactFactory({ firstName: 'Brand New' }) as Partial<Contact>,
    ]);

    expect(results).toHaveLength(2);
  });
});
