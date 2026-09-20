/**
 * BaseRepository unit tests
 *
 * Uses in-memory mocks for the Drizzle client since TestContainers is not
 * configured in this repository. Behavioral correctness is verified via mock
 * call inspection and return value assertions.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { BaseRepository, type BehaviorConfig, type ListOptions } from '../../../../runtime/base-classes/base-repository';
import {
  MissingTenantIdError,
  withAllTenants,
  withRequester,
  withOrgScope,
  withSuperuserScope,
  withTenantScope,
} from '../../../../runtime/base-classes/tenant-context';
import { tenantPredicateFor } from '../../../../runtime/base-classes/base-repository';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';
import { pgTable, text, timestamp, QueryBuilder } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';

// ============================================================================
// Test entity and table setup
// ============================================================================

interface TestEntity {
  id: string;
  name: string;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
}

/**
 * A REAL Drizzle table. REL-0 reads columns through `getColumns(table)`, which
 * resolves `table[Table.Symbol.Columns]` — a plain object literal cast to the
 * table type has no such symbol. Casting a fake to the table type is also
 * exactly what let DRZ-2's narrowing look correct (DRZ-2 Found #1), so the
 * fixture is the real thing.
 */
const testTable = pgTable('test_entity', {
  id: text('id').primaryKey(),
  name: text('name'),
  userId: text('user_id'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
  deletedAt: timestamp('deleted_at'),
});

function makeTable() {
  return testTable;
}

// ============================================================================
// Concrete repository for tests
// ============================================================================

class TestRepository extends BaseRepository<TestEntity, typeof testTable> {
  readonly table: typeof testTable;
  readonly behaviors: BehaviorConfig;

  constructor(
    db: DrizzleClient,
    table: typeof testTable,
    behaviors?: Partial<BehaviorConfig>,
  ) {
    super(db);
    this.table = table;
    this.behaviors = {
      timestamps: false,
      softDelete: false,
      userTracking: false,
      ...behaviors,
    };
  }
}

// ============================================================================
// Drizzle mock builder
// ============================================================================

/**
 * Returns a mock DB that tracks method chains and resolves to `returnValue`
 * for any terminal await.
 */
function makeMockDb(returnValue: unknown = []) {
  // Chainable query proxy — each method returns itself or a final thenable
  const query: Record<string, unknown> & PromiseLike<unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(returnValue).then(resolve),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(returnValue).catch(reject),
    finally: (cb: () => void) => Promise.resolve(returnValue).finally(cb),
  };

  const chainMethods = [
    'select', 'from', '$dynamic', 'where', 'limit', 'offset', 'orderBy',
    'insert', 'values', 'returning',
    'update', 'set',
    'delete',
  ];
  for (const m of chainMethods) {
    query[m] = mock(() => query);
  }

  return query as unknown as DrizzleClient & typeof query;
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseRepository', () => {
  describe('constructor', () => {
    it('stores the db instance', () => {
      const db = makeMockDb();
      const table = makeTable();
      const repo = new TestRepository(db, table);
      // @ts-expect-error accessing protected for test
      expect(repo.db).toBe(db);
    });

    it('has default behaviors all false', () => {
      const db = makeMockDb();
      const table = makeTable();
      const repo = new TestRepository(db, table);
      expect(repo.behaviors).toEqual({
        timestamps: false,
        softDelete: false,
        userTracking: false,
      });
    });
  });

  describe('findByIds', () => {
    it('returns [] immediately for empty array without hitting DB', async () => {
      const db = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.findByIds([]);
      expect(result).toEqual([]);
      // select should never have been called
      expect((db as any).select).not.toHaveBeenCalled();
    });

    it('queries the DB when ids are provided', async () => {
      const mockRow: TestEntity = { id: 'abc', name: 'Test' };
      const db = makeMockDb([mockRow]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.findByIds(['abc']);
      expect(result).toEqual([mockRow]);
      expect((db as any).select).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns null when no rows found', async () => {
      const db = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.findById('missing-id');
      expect(result).toBeNull();
    });

    it('returns first row when found', async () => {
      const mockRow: TestEntity = { id: 'abc', name: 'Test' };
      const db = makeMockDb([mockRow]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.findById('abc');
      expect(result).toEqual(mockRow);
    });
  });

  describe('exists', () => {
    it('returns false when entity not found', async () => {
      const db = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      expect(await repo.exists('ghost')).toBe(false);
    });

    it('returns true when entity is found', async () => {
      const mockRow: TestEntity = { id: 'real', name: 'Real' };
      const db = makeMockDb([mockRow]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      expect(await repo.exists('real')).toBe(true);
    });
  });

  describe('withTimestamps (protected helper)', () => {
    it('is a no-op when timestamps=false', () => {
      const db = makeMockDb();
      const table = makeTable();
      const repo = new TestRepository(db, table, { timestamps: false });
      const input = { name: 'Test' };
      // @ts-expect-error accessing protected for test
      expect(repo.withTimestamps(input, 'create')).toEqual(input);
    });

    it('adds createdAt and updatedAt on create when timestamps=true', () => {
      const db = makeMockDb();
      const table = makeTable();
      const repo = new TestRepository(db, table, { timestamps: true });
      const input = { name: 'Test' };
      // @ts-expect-error accessing protected for test
      const result = repo.withTimestamps(input, 'create');
      expect(result.name).toBe('Test');
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('adds only updatedAt on update when timestamps=true', () => {
      const db = makeMockDb();
      const table = makeTable();
      const repo = new TestRepository(db, table, { timestamps: true });
      const input = { name: 'Updated' };
      // @ts-expect-error accessing protected for test
      const result = repo.withTimestamps(input, 'update');
      expect(result.name).toBe('Updated');
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.createdAt).toBeUndefined();
    });
  });

  describe('create', () => {
    it('inserts and returns the created row', async () => {
      const mockRow: TestEntity = { id: 'new-id', name: 'Created' };
      const db = makeMockDb([mockRow]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.create({ name: 'Created' });
      expect(result).toEqual(mockRow);
      expect((db as any).insert).toHaveBeenCalled();
    });

    it('merges timestamps when behavior is enabled', async () => {
      const mockRow: TestEntity = { id: 'ts-id', name: 'TS', createdAt: new Date(), updatedAt: new Date() };
      const db = makeMockDb([mockRow]);
      const table = makeTable();
      const repo = new TestRepository(db, table, { timestamps: true });
      const result = await repo.create({ name: 'TS' });
      expect(result).toEqual(mockRow);
      // values() should have been called with createdAt/updatedAt merged
      const valuesCall = (db as any).values.mock.calls[0][0] as Record<string, unknown>;
      expect(valuesCall.createdAt).toBeInstanceOf(Date);
      expect(valuesCall.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('update', () => {
    it('updates the row and returns it', async () => {
      const mockRow: TestEntity = { id: 'upd-id', name: 'Updated' };
      const db = makeMockDb([mockRow]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.update('upd-id', { name: 'Updated' });
      expect(result).toEqual(mockRow);
      expect((db as any).update).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('hard-deletes when softDelete=false', async () => {
      const db = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table, { softDelete: false });
      await repo.delete('del-id');
      expect((db as any).delete).toHaveBeenCalled();
      expect((db as any).update).not.toHaveBeenCalled();
    });

    it('soft-deletes (sets deletedAt) when softDelete=true', async () => {
      const db = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table, { softDelete: true });
      await repo.delete('soft-del-id');
      // update should be used, not delete
      expect((db as any).update).toHaveBeenCalled();
      expect((db as any).delete).not.toHaveBeenCalled();
      // set() should have been called with an object containing deletedAt
      const setArg = (db as any).set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('upsertMany', () => {
    it('creates all inputs and returns results', async () => {
      const rows: TestEntity[] = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ];
      let callCount = 0;
      const db = makeMockDb();
      // Override returning for sequential calls
      (db as any).returning = mock(() => {
        const row = rows[callCount++];
        return Promise.resolve([row]);
      });

      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.upsertMany([{ name: 'A' }, { name: 'B' }]);
      expect(result).toHaveLength(2);
    });
  });

  describe('list', () => {
    it('returns all rows with no options', async () => {
      const rows: TestEntity[] = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }];
      const db = makeMockDb(rows);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      const result = await repo.list();
      expect(result).toEqual(rows);
    });

    it('applies limit and offset options', async () => {
      const db = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table);
      await repo.list({ limit: 10, offset: 5 });
      expect((db as any).limit).toHaveBeenCalledWith(10);
      expect((db as any).offset).toHaveBeenCalledWith(5);
    });
  });

  // ==========================================================================
  // Tx threading (task #23)
  // ==========================================================================

  describe('runner(tx)', () => {
    it('prefers the caller-supplied tx for writes', async () => {
      const db = makeMockDb([{ id: 'x', name: 'A' }]);
      const tx = makeMockDb([{ id: 'x', name: 'A' }]);
      const table = makeTable();
      const repo = new TestRepository(db, table);

      await repo.create({ name: 'A' }, tx);

      // Write went through the tx, not the repo's own client.
      expect((tx as any).insert).toHaveBeenCalled();
      expect((db as any).insert).not.toHaveBeenCalled();
    });

    it('falls back to the repo client when no tx is passed', async () => {
      const db = makeMockDb([{ id: 'x', name: 'A' }]);
      const table = makeTable();
      const repo = new TestRepository(db, table);

      await repo.create({ name: 'A' });

      expect((db as any).insert).toHaveBeenCalled();
    });

    it('threads tx through update()', async () => {
      const db = makeMockDb([{ id: 'x', name: 'B' }]);
      const tx = makeMockDb([{ id: 'x', name: 'B' }]);
      const table = makeTable();
      const repo = new TestRepository(db, table);

      await repo.update('x', { name: 'B' }, tx);

      expect((tx as any).update).toHaveBeenCalled();
      expect((db as any).update).not.toHaveBeenCalled();
    });

    it('threads tx through delete() under soft-delete', async () => {
      const db = makeMockDb([]);
      const tx = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table, { softDelete: true });

      await repo.delete('x', tx);

      // Soft-delete issues an UPDATE on the tx, not the base db.
      expect((tx as any).update).toHaveBeenCalled();
      expect((db as any).update).not.toHaveBeenCalled();
    });

    it('threads tx through delete() under hard-delete', async () => {
      const db = makeMockDb([]);
      const tx = makeMockDb([]);
      const table = makeTable();
      const repo = new TestRepository(db, table);

      await repo.delete('x', tx);

      expect((tx as any).delete).toHaveBeenCalled();
      expect((db as any).delete).not.toHaveBeenCalled();
    });

    it('threads tx through upsertMany() via create()', async () => {
      const db = makeMockDb([{ id: 'x', name: 'Z' }]);
      const tx = makeMockDb([{ id: 'x', name: 'Z' }]);
      const table = makeTable();
      const repo = new TestRepository(db, table);

      await repo.upsertMany([{ name: 'Z' }], tx);

      expect((tx as any).insert).toHaveBeenCalled();
      expect((db as any).insert).not.toHaveBeenCalled();
    });
  });

});

// ============================================================================
// Ambient tenant scoping (RequesterContext via AsyncLocalStorage)
// ============================================================================

/**
 * These tests render real Drizzle SQL via a QueryBuilder-backed `db` so we can
 * assert the actual WHERE clause `baseQuery` produces — the mock `db` above
 * only records call shapes and cannot show predicate content.
 */
const widgets = pgTable('widget', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  deletedAt: timestamp('deleted_at'),
});

class ScopingTestRepo extends BaseRepository<{ id: string; userId: string }, typeof widgets> {
  readonly table = widgets;
  protected readonly behaviors: BehaviorConfig;
  constructor(behaviors: Partial<BehaviorConfig> = {}) {
    // A QueryBuilder is enough to render .toSQL() for SELECTs (no driver needed).
    super(new QueryBuilder() as unknown as DrizzleClient);
    this.behaviors = { timestamps: false, softDelete: false, userTracking: true, ...behaviors };
  }
  // Expose protected members for assertions.
  pred(): SQL | undefined {
    return this.scopePredicate();
  }
  renderFindById(id: string): string {
    return this.baseQuery(eq(this.table['id'], id)).toSQL().sql;
  }
}

class StrictScopingTestRepo extends ScopingTestRepo {
  protected readonly scopeEnforcement = 'strict' as const;
}

describe('BaseRepository — ambient tenant scoping', () => {
  describe('scopePredicate gating', () => {
    it('returns undefined when userTracking is off (even inside a context)', async () => {
      const repo = new ScopingTestRepo({ userTracking: false });
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        expect(repo.pred()).toBeUndefined();
      });
    });

    it('returns undefined when userTracking is on but no context is active (lenient default)', () => {
      const repo = new ScopingTestRepo();
      expect(repo.pred()).toBeUndefined();
    });

    it('throws when userTracking is on, strict, and no context is active', () => {
      const repo = new StrictScopingTestRepo();
      expect(() => repo.pred()).toThrow(/No requester context active/);
    });

    it('does not scope superuser reads', async () => {
      const repo = new ScopingTestRepo();
      await withSuperuserScope('admin-1', async () => {
        expect(repo.pred()).toBeUndefined();
      });
    });
  });

  describe('rendered WHERE clauses', () => {
    it('user scope filters by user_id', async () => {
      const repo = new ScopingTestRepo();
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        const sql = repo.renderFindById('w1');
        expect(sql).toContain('"user_id"');
        expect(sql).toMatch(/"widget"\."user_id"\s*=/);
        expect(sql).toContain('"id"');
      });
    });

    it('org scope filters by user_id IN (member list)', async () => {
      const repo = new ScopingTestRepo();
      await withOrgScope('u1', 'org-1', ['u1', 'u2', 'u3'], async () => {
        const sql = repo.renderFindById('w1');
        expect(sql).toMatch(/"user_id"\s+in\s*\(/i);
      });
    });

    it('org scope with no members fails closed (matches nothing)', async () => {
      const repo = new ScopingTestRepo();
      await withOrgScope('u1', 'org-1', [], async () => {
        const sql = repo.renderFindById('w1').toLowerCase();
        expect(sql).toContain('false');
        expect(sql).not.toMatch(/"user_id"\s+in/);
      });
    });

    it('superuser scope renders no user_id filter', async () => {
      const repo = new ScopingTestRepo();
      await withSuperuserScope('admin-1', async () => {
        // user_id appears in the SELECT projection; assert it is not a predicate.
        const sql = repo.renderFindById('w1');
        expect(sql).not.toMatch(/"user_id"\s*(=|in)/i);
      });
    });

    it('unscoped repo renders no user_id filter even inside a context', async () => {
      const repo = new ScopingTestRepo({ userTracking: false });
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        const sql = repo.renderFindById('w1');
        expect(sql).not.toMatch(/"user_id"\s*(=|in)/i);
      });
    });

    it('combines soft-delete + scope + leaf predicate in one WHERE', async () => {
      const repo = new ScopingTestRepo({ softDelete: true });
      await withRequester({ userId: 'u1', organizationId: null }, async () => {
        const sql = repo.renderFindById('w1').toLowerCase();
        expect(sql).toContain('deleted_at');
        expect(sql).toContain('user_id');
        // single combined WHERE, AND-joined (not a dropped guard)
        expect(sql).toContain(' and ');
      });
    });
  });
});


// ============================================================================
// TEN-1 (#585) — the tenant axis (ADR-042)
// ============================================================================

/**
 * A second real table, with BOTH scope columns plus the soft-delete guard, so
 * the tests can prove the three predicates land in ONE `WHERE` rather than
 * replacing one another.
 */
const tenantWidgets = pgTable('tenant_widget', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  tenantId: text('tenant_id'),
  name: text('name'),
  deletedAt: timestamp('deleted_at'),
});

/** A table with NO tenant_id — the runtime backstop's subject. */
const untenantedWidgets = pgTable('untenanted_widget', {
  id: text('id').primaryKey(),
  name: text('name'),
});

class TenantTestRepo extends BaseRepository<
  { id: string; tenantId: string | null },
  typeof tenantWidgets
> {
  readonly table = tenantWidgets;
  protected readonly behaviors: BehaviorConfig;
  protected readonly scopeEnforcement: 'lenient' | 'strict';

  constructor(
    behaviors: Partial<BehaviorConfig> = {},
    enforcement: 'lenient' | 'strict' = 'strict',
  ) {
    super(new QueryBuilder() as unknown as DrizzleClient);
    this.behaviors = {
      timestamps: false,
      softDelete: false,
      userTracking: false,
      tenantScoped: true,
      ...behaviors,
    };
    this.scopeEnforcement = enforcement;
  }

  // Expose protected members for assertions.
  pred(): SQL | undefined {
    return this.tenantPredicate();
  }
  stamp(input: Record<string, unknown>): Record<string, unknown> {
    return this.stampTenant(input);
  }
  renderFindById(id: string): string {
    return this.baseQuery(eq(this.table['id'], id)).toSQL().sql;
  }
  renderFindByIdParams(id: string): unknown[] {
    return this.baseQuery(eq(this.table['id'], id)).toSQL().params;
  }
}

/** Declares `tenantScoped: true` over a table that has no such column. */
class MisdeclaredTenantRepo extends BaseRepository<
  { id: string },
  typeof untenantedWidgets
> {
  readonly table = untenantedWidgets;
  protected readonly behaviors: BehaviorConfig = {
    timestamps: false,
    softDelete: false,
    userTracking: false,
    tenantScoped: true,
  };
  protected readonly scopeEnforcement = 'strict' as const;
  constructor() {
    super(new QueryBuilder() as unknown as DrizzleClient);
  }
  renderList(): string {
    return this.baseQuery().toSQL().sql;
  }
}

const asTenant = <T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> =>
  withRequester({ userId: 'u1', organizationId: null, tenantId }, fn);

describe('tenantPredicateFor — the per-hop primitive REL-2 consumes', () => {
  it('undefined → no predicate', () => {
    expect(tenantPredicateFor(tenantWidgets, undefined, 'X')).toBeUndefined();
  });

  it('null → IS NULL (the partition, not a wildcard)', () => {
    const sql = new QueryBuilder()
      .select()
      .from(tenantWidgets)
      .where(tenantPredicateFor(tenantWidgets, null, 'X'))
      .toSQL().sql.toLowerCase();
    expect(sql).toContain('"tenant_id" is null');
  });

  it('a string → equality, with the value bound as a parameter', () => {
    const q = new QueryBuilder()
      .select()
      .from(tenantWidgets)
      .where(tenantPredicateFor(tenantWidgets, 't-a', 'X'))
      .toSQL();
    expect(q.sql.toLowerCase()).toMatch(/"tenant_id"\s*=/);
    expect(q.params).toContain('t-a');
  });

  it('a table with no tenant_id throws, naming the owner', () => {
    expect(() => tenantPredicateFor(untenantedWidgets, 't-a', 'WidgetRepo')).toThrow(
      /WidgetRepo: table has no column 'tenantId'/,
    );
  });

  it('applies to ANY table, not just a repository\'s own — the REL-2 contract', () => {
    // Same call, a different table: this is what a hop does.
    const other = pgTable('other_widget', {
      id: text('id').primaryKey(),
      tenantId: text('tenant_id'),
    });
    const sql = new QueryBuilder()
      .select()
      .from(other)
      .where(tenantPredicateFor(other, 't-a', 'Hop'))
      .toSQL().sql.toLowerCase();
    expect(sql).toContain('"other_widget"."tenant_id"');
  });
});

describe('BaseRepository.tenantPredicate — gating', () => {
  it('returns undefined when tenantScoped is off, even inside a tenant context', async () => {
    const repo = new TenantTestRepo({ tenantScoped: false });
    await asTenant('t-a', async () => {
      expect(repo.pred()).toBeUndefined();
    });
  });

  it('lenient + no context → undefined (unscoped)', () => {
    const repo = new TenantTestRepo({}, 'lenient');
    expect(repo.pred()).toBeUndefined();
  });

  it('lenient + a context with no tenant → undefined', async () => {
    const repo = new TenantTestRepo({}, 'lenient');
    await withRequester({ userId: 'u1', organizationId: null }, async () => {
      expect(repo.pred()).toBeUndefined();
    });
  });

  it('strict + no context → throws', () => {
    const repo = new TenantTestRepo();
    expect(() => repo.pred()).toThrow(/No requester context active/);
  });

  it('strict + a context with no tenant → MissingTenantIdError, never an unscoped read', async () => {
    const repo = new TenantTestRepo();
    await withRequester({ userId: 'u1', organizationId: null }, async () => {
      expect(() => repo.pred()).toThrow(MissingTenantIdError);
    });
  });

  it('withAllTenants drops the predicate — the read-side hatch', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      await withAllTenants(async () => {
        expect(repo.pred()).toBeUndefined();
      });
    });
  });

  it('withTenantScope redirects the predicate to the named tenant', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      await withTenantScope('t-b', async () => {
        expect(repo.renderFindByIdParams('w1')).toContain('t-b');
      });
    });
  });

  it('a tenantScoped repo over a table with no tenant_id throws at the first statement', () => {
    const repo = new MisdeclaredTenantRepo();
    expect(() =>
      withRequester(
        { userId: 'u1', organizationId: null, tenantId: 't-a' },
        async () => repo.renderList(),
      ),
    ).toThrow(/table has no column 'tenantId'/);
  });
});

describe('BaseRepository — every guard lands in ONE WHERE', () => {
  it('tenant + leaf predicate', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      const q = repo.renderFindById('w1');
      expect(q.toLowerCase()).toMatch(/"tenant_id"\s*=/);
      expect(q.toLowerCase()).toContain(' and ');
      expect(repo.renderFindByIdParams('w1')).toEqual(['t-a', 'w1']);
    });
  });

  it('soft-delete + user scope + tenant scope + leaf, none dropping another', async () => {
    const repo = new TenantTestRepo({ softDelete: true, userTracking: true });
    await withRequester(
      { userId: 'u1', organizationId: null, tenantId: 't-a' },
      async () => {
        const sql = repo.renderFindById('w1').toLowerCase();
        expect(sql).toContain('"deleted_at" is null');
        expect(sql).toMatch(/"user_id"\s*=/);
        expect(sql).toMatch(/"tenant_id"\s*=/);
        // One WHERE, three ANDs worth of guards plus the leaf.
        expect(sql.match(/ where /g)).toHaveLength(1);
      },
    );
  });

  it('the null partition renders IS NULL, and does not match a tenant', async () => {
    const repo = new TenantTestRepo();
    await asTenant(null, async () => {
      const sql = repo.renderFindById('w1').toLowerCase();
      expect(sql).toContain('"tenant_id" is null');
      expect(repo.renderFindByIdParams('w1')).toEqual(['w1']);
    });
  });

  it('the user axis being superuser leaves the tenant filter standing', async () => {
    const repo = new TenantTestRepo({ userTracking: true });
    await withRequester(
      {
        userId: '__system__',
        organizationId: null,
        scope: 'superuser',
        tenantId: 't-a',
      },
      async () => {
        const sql = repo.renderFindById('w1').toLowerCase();
        expect(sql).not.toMatch(/"user_id"\s*(=|in)/);
        expect(sql).toMatch(/"tenant_id"\s*=/);
      },
    );
  });
});

describe('BaseRepository.stampTenant', () => {
  it('is a no-op when tenantScoped is off', () => {
    const repo = new TenantTestRepo({ tenantScoped: false });
    expect(repo.stamp({ name: 'w' })).toEqual({ name: 'w' });
  });

  it('stamps the ambient tenant', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      expect(repo.stamp({ name: 'w' })).toEqual({ name: 'w', tenantId: 't-a' });
    });
  });

  it('an explicit tenantId wins over the ambient one', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      expect(repo.stamp({ name: 'w', tenantId: 't-b' })).toEqual({
        name: 'w',
        tenantId: 't-b',
      });
    });
  });

  it('an explicit null is preserved (writing the null partition deliberately)', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      expect(repo.stamp({ name: 'w', tenantId: null })).toEqual({
        name: 'w',
        tenantId: null,
      });
    });
  });

  it('the ambient null partition stamps null', async () => {
    const repo = new TenantTestRepo();
    await asTenant(null, async () => {
      expect(repo.stamp({ name: 'w' })).toEqual({ name: 'w', tenantId: null });
    });
  });

  it('strict + a context with no tenant throws rather than writing an orphan row', async () => {
    const repo = new TenantTestRepo();
    await withRequester({ userId: 'u1', organizationId: null }, async () => {
      expect(() => repo.stamp({ name: 'w' })).toThrow(MissingTenantIdError);
    });
  });

  it('withAllTenants THROWS on a write without an explicit tenant — reads may roam, writes may not', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      await withAllTenants(async () => {
        expect(() => repo.stamp({ name: 'w' })).toThrow(MissingTenantIdError);
      });
    });
  });

  it('withAllTenants permits a write that names its owner', async () => {
    const repo = new TenantTestRepo();
    await asTenant('t-a', async () => {
      await withAllTenants(async () => {
        expect(repo.stamp({ name: 'w', tenantId: 't-b' })).toEqual({
          name: 'w',
          tenantId: 't-b',
        });
      });
    });
  });
});
