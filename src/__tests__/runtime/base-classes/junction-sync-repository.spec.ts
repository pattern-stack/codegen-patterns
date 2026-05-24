/**
 * JunctionSyncRepository sync-surface unit tests (#374).
 *
 * Exercises strict dual-FK resolution (throw on unresolved), onConflictDoUpdate
 * on the (left,right,role) / (left,right) target, the composite build/parse
 * helpers (role + role-less variants), and the non-throwing lookups
 * (findByExternalIdProjected / softDeleteByExternalId).
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  JunctionSyncRepository,
  buildCompositeExternalId,
  parseCompositeExternalId,
  type JunctionSyncConfig,
} from '../../../../runtime/base-classes/junction-sync-repository';
import type { DrizzleClient, DrizzleTx } from '../../../../runtime/types/drizzle';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';

// ============================================================================
// Tables / config
// ============================================================================

const makeTbl = (cols: string[]) =>
  Object.fromEntries(cols.map((c) => [c, { name: c }])) as unknown as PgTableWithColumns<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const opportunities = makeTbl(['id', 'provider', 'externalId']);
const contacts = makeTbl(['id', 'provider', 'externalId']);
const junctionTable = makeTbl(['opportunityId', 'contactId', 'role', 'createdAt', 'updatedAt']);

interface OppContact {
  opportunityId: string;
  contactId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}
interface OppContactWrite {
  opportunityExternalId: string;
  contactExternalId: string;
  role: string;
  userId: string;
}
interface OppContactProjection {
  id: string;
  opportunityId: string;
  contactId: string;
  role?: string;
  createdAt: Date;
  updatedAt: Date;
}

const roleConfig: JunctionSyncConfig = {
  left: { column: 'opportunityId', refTable: opportunities },
  right: { column: 'contactId', refTable: contacts },
  roleColumn: 'role',
};

// ============================================================================
// Sequencing mock (mirrors the synced-entity spec)
// ============================================================================

function makeMock() {
  const queue: unknown[][] = [];
  const capture = { values: [] as unknown[], conflict: [] as unknown[] };
  const query: Record<string, unknown> & PromiseLike<unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queue.length ? queue.shift() : []).then(resolve),
    catch: () => Promise.resolve([]),
    finally: (cb: () => void) => Promise.resolve([]).finally(cb),
  };
  for (const m of ['select', 'from', 'where', 'limit', 'insert', 'returning', 'delete', 'update', 'set']) {
    query[m] = mock(() => query);
  }
  query['values'] = mock((v: unknown) => { capture.values.push(v); return query; });
  query['onConflictDoUpdate'] = mock((v: unknown) => { capture.conflict.push(v); return query; });
  query['transaction'] = mock((cb: (tx: unknown) => unknown) => cb(query));
  return {
    db: query as unknown as DrizzleClient & DrizzleTx,
    enqueue: (rows: unknown[]) => queue.push(rows),
    capture,
  };
}

class OppContactRepository extends JunctionSyncRepository<OppContact, OppContactWrite, OppContactProjection> {
  readonly table = junctionTable;
  protected readonly syncConfig: JunctionSyncConfig;
  protected readonly behaviors = { timestamps: true, softDelete: false, userTracking: false };
  constructor(db: DrizzleClient, config: JunctionSyncConfig = roleConfig) {
    super(db);
    this.syncConfig = config;
  }
}

const jrow = (): OppContact => ({
  opportunityId: 'opp-1', contactId: 'con-1', role: 'champion',
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
});

// ============================================================================
// Composite helpers
// ============================================================================

describe('composite externalId helpers', () => {
  it('builds and parses a 3-part role-bearing composite', () => {
    const id = buildCompositeExternalId('hubspot:42', 'hubspot:99', 'champion');
    expect(id).toBe('hubspot:42::hubspot:99::champion');
    expect(parseCompositeExternalId(id, true)).toEqual({
      left: 'hubspot:42', right: 'hubspot:99', role: 'champion',
    });
  });

  it('builds and parses a 2-part role-less composite', () => {
    const id = buildCompositeExternalId('a', 'b');
    expect(id).toBe('a::b');
    expect(parseCompositeExternalId(id, false)).toEqual({ left: 'a', right: 'b', role: undefined });
  });

  it('returns null on wrong part count', () => {
    expect(parseCompositeExternalId('a::b', true)).toBeNull();   // role expected
    expect(parseCompositeExternalId('a::b::c', false)).toBeNull(); // role not expected
  });

  it('returns null on empty part', () => {
    expect(parseCompositeExternalId('a::::c', true)).toBeNull();
  });
});

// ============================================================================
// syncUpsertOne — strict dual-FK resolution
// ============================================================================

describe('JunctionSyncRepository.syncUpsertOne', () => {
  it('resolves both parents and upserts on (left,right,role)', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'opp-1' }]); // left resolution
    m.enqueue([{ id: 'con-1' }]); // right resolution
    m.enqueue([jrow()]);          // upsert RETURNING
    const repo = new OppContactRepository(m.db);

    const proj = await repo.syncUpsertOne(
      { opportunityExternalId: 'o-ext', contactExternalId: 'c-ext', role: 'champion', userId: 'u' },
      'hubspot',
    );

    const values = m.capture.values[0] as Record<string, unknown>;
    expect(values.opportunityId).toBe('opp-1');
    expect(values.contactId).toBe('con-1');
    expect(values.role).toBe('champion');
    const conflict = m.capture.conflict[0] as { target: unknown[] };
    expect(conflict.target).toHaveLength(3); // role-inclusive
    expect(proj.id).toBe('o-ext::c-ext::champion');
  });

  it('throws when the left parent is unresolved (strict)', async () => {
    const m = makeMock();
    m.enqueue([]); // left resolution finds nothing
    const repo = new OppContactRepository(m.db);

    await expect(
      repo.syncUpsertOne(
        { opportunityExternalId: 'missing', contactExternalId: 'c-ext', role: 'champion', userId: 'u' },
        'hubspot',
      ),
    ).rejects.toThrow(/unresolved parent 'missing'/);
  });

  it('throws when the right parent is unresolved (strict)', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'opp-1' }]); // left resolves
    m.enqueue([]);                 // right unresolved
    const repo = new OppContactRepository(m.db);

    await expect(
      repo.syncUpsertOne(
        { opportunityExternalId: 'o-ext', contactExternalId: 'missing', role: 'champion', userId: 'u' },
        'hubspot',
      ),
    ).rejects.toThrow(/unresolved parent 'missing'/);
  });

  it('role-less junction conflicts on (left,right) and omits role from values', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'opp-1' }]);
    m.enqueue([{ id: 'con-1' }]);
    m.enqueue([jrow()]);
    const repo = new OppContactRepository(m.db, { ...roleConfig, roleColumn: null });

    const proj = await repo.syncUpsertOne(
      { opportunityExternalId: 'o-ext', contactExternalId: 'c-ext', role: 'ignored', userId: 'u' },
      'hubspot',
    );

    const values = m.capture.values[0] as Record<string, unknown>;
    expect('role' in values).toBe(false);
    const conflict = m.capture.conflict[0] as { target: unknown[] };
    expect(conflict.target).toHaveLength(2);
    expect(proj.id).toBe('o-ext::c-ext'); // 2-part composite
  });
});

// ============================================================================
// findByExternalIdProjected / softDeleteByExternalId — non-throwing resolve
// ============================================================================

describe('JunctionSyncRepository.findByExternalIdProjected', () => {
  it('returns null on malformed composite', async () => {
    const m = makeMock();
    const repo = new OppContactRepository(m.db);
    expect(await repo.findByExternalIdProjected('only-two::parts', 'hubspot')).toBeNull();
  });

  it('returns null when a parent is unresolved (non-throwing)', async () => {
    const m = makeMock();
    m.enqueue([]); // left unresolved
    const repo = new OppContactRepository(m.db);
    expect(await repo.findByExternalIdProjected('o::c::champion', 'hubspot')).toBeNull();
  });

  it('returns the projection when row found', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'opp-1' }]); // left
    m.enqueue([{ id: 'con-1' }]); // right
    m.enqueue([jrow()]);          // row
    const repo = new OppContactRepository(m.db);
    const proj = await repo.findByExternalIdProjected('o::c::champion', 'hubspot');
    expect(proj?.id).toBe('o::c::champion');
  });
});

describe('JunctionSyncRepository.softDeleteByExternalId', () => {
  it('deletes by tuple and returns the composite id', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'opp-1' }]); // left
    m.enqueue([{ id: 'con-1' }]); // right
    m.enqueue([{ id: 'opp-1' }]); // delete RETURNING
    const repo = new OppContactRepository(m.db);
    const res = await repo.softDeleteByExternalId('o::c::champion', 'hubspot');
    expect(res).toEqual({ id: 'o::c::champion' });
  });

  it('returns null when nothing deleted', async () => {
    const m = makeMock();
    m.enqueue([{ id: 'opp-1' }]);
    m.enqueue([{ id: 'con-1' }]);
    m.enqueue([]); // delete RETURNING empty
    const repo = new OppContactRepository(m.db);
    expect(await repo.softDeleteByExternalId('o::c::champion', 'hubspot')).toBeNull();
  });
});
