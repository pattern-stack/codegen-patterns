/**
 * SyncedEntityRepository sync-surface unit tests (#374).
 *
 * Exercises the generic inbound-sync write surface — syncUpsertOne (FK
 * resolution: opportunistic-null + no-clobber + provider scoping), toProjection
 * (omit provider), findByExternalIdProjected, softDeleteByExternalId (both
 * softDelete branches), and the batch syncUpsert (per-input provider, skip
 * incomplete) — against an in-memory query mock that sequences results and
 * captures the values/set/where args.
 */
import { describe, it, expect, mock } from 'bun:test';
import { SyncedEntityRepository } from '../../../../runtime/base-classes/synced-entity-repository';
import type { SyncUpsertConfig } from '../../../../runtime/base-classes/sync-upsert-config';
import type { DrizzleClient, DrizzleTx } from '../../../../runtime/types/drizzle';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';

// ============================================================================
// Test entity / table / config
// ============================================================================

interface Account {
  id: string;
  externalId: string | null;
  provider: string | null;
  userId: string;
  name: string;
  domain: string | null;
  parentAccountId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

interface AccountSyncWrite {
  externalId: string;
  userId: string;
  name: string;
  domain: string | null;
  parentAccountExternalId?: string | null;
  fields?: Record<string, unknown>;
}

const accountsTable = {
  id: { name: 'id' },
  externalId: { name: 'external_id' },
  provider: { name: 'provider' },
  userId: { name: 'user_id' },
  name: { name: 'name' },
  domain: { name: 'domain' },
  parentAccountId: { name: 'parent_account_id' },
  createdAt: { name: 'created_at' },
  updatedAt: { name: 'updated_at' },
  deletedAt: { name: 'deleted_at' },
} as unknown as PgTableWithColumns<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const baseConfig: SyncUpsertConfig = {
  conflictTarget: ['provider', 'externalId'],
  writeColumns: ['userId', 'name', 'domain'],
  fkResolvers: [
    { column: 'parentAccountId', writeKey: 'parentAccountExternalId', refTable: 'self' },
  ],
  projectionColumns: [
    'id', 'externalId', 'userId', 'name', 'domain', 'parentAccountId', 'createdAt', 'updatedAt',
  ],
  eav: false,
  softDelete: false,
};

// ============================================================================
// Sequencing query mock — each terminal await yields the next queued result.
// Captures the last values()/set()/where() args for assertions.
// ============================================================================

interface MockHandle {
  db: DrizzleClient & DrizzleTx;
  /** queue a result for the next awaited query */
  enqueue: (rows: unknown[]) => void;
  capture: { values: unknown[]; set: unknown[]; conflict: unknown[] };
}

function makeMock(): MockHandle {
  const queue: unknown[][] = [];
  const capture = { values: [] as unknown[], set: [] as unknown[], conflict: [] as unknown[] };

  const query: Record<string, unknown> & PromiseLike<unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queue.length ? queue.shift() : []).then(resolve),
    catch: () => Promise.resolve([]),
    finally: (cb: () => void) => Promise.resolve([]).finally(cb),
  };

  const passthrough = [
    'select', 'from', '$dynamic', 'where', 'limit', 'offset', 'orderBy',
    'insert', 'returning', 'update', 'delete',
  ];
  for (const m of passthrough) query[m] = mock(() => query);
  query['values'] = mock((v: unknown) => { capture.values.push(v); return query; });
  query['set'] = mock((v: unknown) => { capture.set.push(v); return query; });
  query['onConflictDoUpdate'] = mock((v: unknown) => { capture.conflict.push(v); return query; });
  query['transaction'] = mock((cb: (tx: unknown) => unknown) => cb(query));

  return {
    db: query as unknown as DrizzleClient & DrizzleTx,
    enqueue: (rows) => queue.push(rows),
    capture,
  };
}

class AccountRepository extends SyncedEntityRepository<Account, AccountSyncWrite, Account> {
  readonly table = accountsTable;
  protected readonly syncConfig: SyncUpsertConfig;
  protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };

  constructor(db: DrizzleClient, config: SyncUpsertConfig = baseConfig) {
    super(db);
    this.syncConfig = config;
  }
}

function row(over: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    externalId: 'ext-1',
    provider: 'hubspot',
    userId: 'user-1',
    name: 'Acme',
    domain: 'acme.com',
    parentAccountId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...over,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SyncedEntityRepository.syncUpsertOne — FK resolution', () => {
  it('resolves a self-FK opportunistically and writes it into values + set', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'parent-1' }]); // FK resolution SELECT
    m.enqueue([row({ parentAccountId: 'parent-1' })]); // upsert RETURNING
    const repo = new AccountRepository(m.db);

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: 'acme.com', parentAccountExternalId: 'parent-ext' },
      'hubspot',
    );

    const values = m.capture.values[0] as Record<string, unknown>;
    expect(values.externalId).toBe('ext-1');
    expect(values.provider).toBe('hubspot');
    expect(values.parentAccountId).toBe('parent-1');
    const conflict = m.capture.conflict[0] as { set: Record<string, unknown> };
    // No-clobber: resolved FK IS in set (non-null this run).
    expect(conflict.set.parentAccountId).toBe('parent-1');
    // Identity columns never in set.
    expect(conflict.set.externalId).toBeUndefined();
    expect(conflict.set.provider).toBeUndefined();
  });

  it('leaves FK null and OMITS it from set when parent is unresolved (no-clobber)', async () => {
    const m = makeMock();
    m.enqueue([]); // FK resolution finds nothing
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db);

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: null, parentAccountExternalId: 'missing' },
      'hubspot',
    );

    const values = m.capture.values[0] as Record<string, unknown>;
    expect(values.parentAccountId).toBeNull();
    const conflict = m.capture.conflict[0] as { set: Record<string, unknown> };
    // Never clobber a previously-resolved parent with null.
    expect('parentAccountId' in conflict.set).toBe(false);
  });

  it('leaves FK null when no parentExternalId is supplied (does not query)', async () => {
    const m = makeMock();
    m.enqueue([row()]); // only the upsert RETURNING — no FK SELECT
    const repo = new AccountRepository(m.db);

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: null },
      'hubspot',
    );

    const values = m.capture.values[0] as Record<string, unknown>;
    expect(values.parentAccountId).toBeNull();
  });

  it('scopes the FK lookup by provider', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'parent-1' }]);
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db);

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: null, parentAccountExternalId: 'p-ext' },
      'salesforce',
    );

    // where() was called for the FK SELECT (provider-scoped and().eq()).
    expect((m.db as any).where).toHaveBeenCalled();
    const values = m.capture.values[0] as Record<string, unknown>;
    expect(values.provider).toBe('salesforce');
  });
});

describe('SyncedEntityRepository.syncUpsertOne — projection', () => {
  it('projects only projectionColumns (omits provider/providerMetadata)', async () => {
    const m = makeMock();
    m.enqueue([row({ parentAccountId: null })]); // no FK ext id → no SELECT
    const repo = new AccountRepository(m.db);

    const proj = await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: 'acme.com' },
      'hubspot',
    ) as unknown as Record<string, unknown>;

    expect(proj.id).toBe('acc-1');
    expect(proj.externalId).toBe('ext-1');
    expect(proj.name).toBe('Acme');
    expect('provider' in proj).toBe(false);
    expect('providerMetadata' in proj).toBe(false);
    expect('deletedAt' in proj).toBe(false);
  });
});

describe('SyncedEntityRepository.syncUpsertOne — EAV seam', () => {
  it('calls writeCustomFields when eav and fields non-empty', async () => {
    const m = makeMock();
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db, { ...baseConfig, eav: true });
    const spy = mock(async () => {});
    // @ts-expect-error override protected for test
    repo.writeCustomFields = spy;

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: null, fields: { tier: 'gold' } },
      'hubspot',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBe('user-1'); // userId
    expect(spy.mock.calls[0][3]).toEqual({ tier: 'gold' });
  });

  it('does NOT call writeCustomFields when eav is false', async () => {
    const m = makeMock();
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db, { ...baseConfig, eav: false });
    const spy = mock(async () => {});
    // @ts-expect-error override protected for test
    repo.writeCustomFields = spy;

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: null, fields: { tier: 'gold' } },
      'hubspot',
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT call writeCustomFields when fields bag is empty', async () => {
    const m = makeMock();
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db, { ...baseConfig, eav: true });
    const spy = mock(async () => {});
    // @ts-expect-error override protected for test
    repo.writeCustomFields = spy;

    await repo.syncUpsertOne(
      { externalId: 'ext-1', userId: 'user-1', name: 'Acme', domain: null, fields: {} },
      'hubspot',
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('SyncedEntityRepository.findByExternalIdProjected', () => {
  it('returns the projection when a row matches (provider-scoped)', async () => {
    const m = makeMock();
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db);

    const proj = await repo.findByExternalIdProjected('ext-1', 'hubspot') as unknown as Record<string, unknown>;
    expect(proj.id).toBe('acc-1');
    expect('provider' in proj).toBe(false);
  });

  it('returns null when no row matches', async () => {
    const m = makeMock();
    m.enqueue([]);
    const repo = new AccountRepository(m.db);

    const proj = await repo.findByExternalIdProjected('missing', 'hubspot');
    expect(proj).toBeNull();
  });
});

describe('SyncedEntityRepository.softDeleteByExternalId', () => {
  it('tombstone-by-clearing when softDelete: false', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'acc-1' }]);
    const repo = new AccountRepository(m.db, { ...baseConfig, softDelete: false });

    const res = await repo.softDeleteByExternalId('ext-1', 'hubspot');
    expect(res).toEqual({ id: 'acc-1' });
    const set = m.capture.set[0] as Record<string, unknown>;
    expect(set.externalId).toBeNull();
    expect(set.provider).toBeNull();
    expect('deletedAt' in set).toBe(false);
  });

  it('sets deletedAt when softDelete: true', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'acc-1' }]);
    const repo = new AccountRepository(m.db, { ...baseConfig, softDelete: true });

    await repo.softDeleteByExternalId('ext-1', 'hubspot');
    const set = m.capture.set[0] as Record<string, unknown>;
    expect(set.deletedAt).toBeInstanceOf(Date);
    expect('externalId' in set).toBe(false);
  });

  it('returns null when no row matched', async () => {
    const m = makeMock();
    m.enqueue([]);
    const repo = new AccountRepository(m.db);

    expect(await repo.softDeleteByExternalId('ghost', 'hubspot')).toBeNull();
  });
});

describe('SyncedEntityRepository.syncUpsert (batch)', () => {
  it('returns [] for empty input without touching the db', async () => {
    const m = makeMock();
    const repo = new AccountRepository(m.db);
    expect(await repo.syncUpsert([])).toEqual([]);
    expect((m.db as any).transaction).not.toHaveBeenCalled();
  });

  it('skips rows missing externalId or provider', async () => {
    const m = makeMock();
    // one valid input: FK skip (no parent ext) → upsert RETURNING → re-select row
    m.enqueue([row()]);   // upsert RETURNING
    m.enqueue([row()]);   // re-select by id
    const repo = new AccountRepository(m.db);

    const out = await repo.syncUpsert([
      { name: 'no-ext' } as Partial<Account>,                         // skipped (no externalId)
      { externalId: 'ext-2' } as Partial<Account>,                    // skipped (no provider)
      { externalId: 'ext-1', provider: 'hubspot', userId: 'u', name: 'Acme' } as Partial<Account>,
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('acc-1');
  });

  it('reads provider per-input', async () => {
    const m = makeMock();
    m.enqueue([row()]);
    m.enqueue([row()]);
    const repo = new AccountRepository(m.db);

    await repo.syncUpsert([
      { externalId: 'ext-1', provider: 'salesforce', userId: 'u', name: 'A' } as Partial<Account>,
    ]);
    const values = m.capture.values[0] as Record<string, unknown>;
    expect(values.provider).toBe('salesforce');
  });
});
