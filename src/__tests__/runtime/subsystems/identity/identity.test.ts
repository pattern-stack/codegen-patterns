/**
 * Identity (ID-1), the runtime: the registries and their names, the workspace sources, the `lookup` resolver's four
 * outcomes, both requester caches (the Postgres one over a fake listener), the workspace operations' rules, and the
 * 401 / 403 / 409 bodies. The smoke's Postgres leg runs the real thing across two apps.
 */
import { describe, expect, it } from 'bun:test';

import {
  IDENTITY_REQUESTER_CHANNEL,
  LookupRequesterResolver,
  MemoryRequesterCache,
  PostgresRequesterCache,
  REQUESTER_CACHES,
  REQUESTER_CACHE_NAMES,
  REQUESTER_RESOLVERS,
  REQUESTER_RESOLVER_NAMES,
  ROLES,
  ROLE_RIGHTS,
  WORKSPACE_SOURCES,
  WORKSPACE_SOURCE_NAMES,
  WorkspaceService,
  requestFacts,
  type MembershipRecord,
  type MembershipRows,
} from '../../../../../runtime/subsystems/identity/core';
import { withRequester } from '../../../../../runtime/base-classes/tenant-context';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, errorBody } from '../../../../../runtime/errors';
import { IdentityConfigSchema } from '../../../../schema/codegen-config.schema';

const W = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('the registries', () => {
  it('every name has a row, and no row lacks a name', () => {
    expect(Object.keys(WORKSPACE_SOURCES).sort()).toEqual([...WORKSPACE_SOURCE_NAMES].sort());
    expect(Object.keys(REQUESTER_RESOLVERS).sort()).toEqual([...REQUESTER_RESOLVER_NAMES].sort());
    expect(Object.keys(REQUESTER_CACHES).sort()).toEqual([...REQUESTER_CACHE_NAMES].sort());
    expect(Object.keys(ROLE_RIGHTS).sort()).toEqual([...ROLES].sort());
  });

  it('the config defaults to header + lookup on postgres, and refuses a value with no row, naming the rows', () => {
    expect(IdentityConfigSchema.parse({})).toEqual({ workspace_from: 'header', requester: { resolver: 'lookup', cache: 'postgres' } });
    const bad = IdentityConfigSchema.safeParse({ workspace_from: 'cookie' });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('header');
    expect(JSON.stringify(bad.error?.issues)).toContain('path');
    expect(IdentityConfigSchema.safeParse({ requester: { cache: 'redis' } }).success).toBe(false);
  });
});

describe('workspace sources', () => {
  it('header: X-Workspace, case-insensitively; a malformed id is named; none is null', () => {
    const header = WORKSPACE_SOURCES.header();
    expect(header.routePrefix).toBe('');
    expect(header.workspaceOf(requestFacts('/x', { 'x-workspace': W.toUpperCase() }))).toEqual({ workspaceId: W });
    expect(header.workspaceOf(requestFacts('/x', { 'X-Workspace': 'acme' }))).toEqual({ malformed: 'acme' });
    expect(header.workspaceOf(requestFacts('/x'))).toBeNull();
  });

  it('path: /w/<id>/…, with the route prefix the HTTP layer mounts under', () => {
    const p = WORKSPACE_SOURCES.path();
    expect(p.routePrefix).toBe('/w/:workspaceId');
    expect(p.workspaceOf(requestFacts(`/w/${W}/contacts`))).toEqual({ workspaceId: W });
    expect(p.workspaceOf(requestFacts(`/w/${W}`))).toEqual({ workspaceId: W });
    expect(p.workspaceOf(requestFacts('/w/acme/contacts'))).toEqual({ malformed: 'acme' });
    expect(p.workspaceOf(requestFacts('/contacts'))).toBeNull();
  });
});

describe('the lookup resolver', () => {
  const roles = new Map([[`${A}:${W}`, 'owner']]);
  const resolver = new LookupRequesterResolver({
    principals: { principalOf: async (r) => r.header('X-Principal') ?? null },
    workspaces: WORKSPACE_SOURCES.header(),
    cache: new MemoryRequesterCache({ lookup: async (k) => roles.get(`${k.principalId}:${k.workspaceId}`) ?? null }),
  });
  const facts = (who?: string, workspace?: string) => requestFacts('/x', { 'X-Principal': who, 'X-Workspace': workspace });

  it('four outcomes: unauthenticated, bad-workspace, not-a-member, a requester with its role', async () => {
    expect(await resolver.resolve(facts())).toMatchObject({ refusal: { reason: 'unauthenticated' } });
    expect(await resolver.resolve(facts(A, 'acme'))).toMatchObject({ refusal: { reason: 'bad-workspace' } });
    expect(await resolver.resolve(facts(B, W))).toMatchObject({ refusal: { reason: 'not-a-member' } });
    expect(await resolver.resolve(facts(A, W))).toEqual({ requester: { userId: A, tenantId: W, role: 'owner' } });
  });

  it('every refusal says what to do instead', async () => {
    for (const out of [await resolver.resolve(facts()), await resolver.resolve(facts(A, 'acme')), await resolver.resolve(facts(B, W))]) {
      expect('refusal' in out && out.refusal.instead.length > 0).toBe(true);
    }
  });

  it("a principal that isn't a user id is unauthenticated, not an error; ids match whatever their case", async () => {
    expect(await resolver.resolve(facts('auth0|42', W))).toMatchObject({ refusal: { reason: 'unauthenticated' } });
    expect(await resolver.requesterFor({ principalId: A.toUpperCase(), workspaceId: W.toUpperCase() })).toEqual({
      requester: { userId: A, tenantId: W, role: 'owner' },
    });
    expect(await resolver.requesterFor({ principalId: A, workspaceId: 'acme' })).toMatchObject({ refusal: { reason: 'bad-workspace' } });
  });

  it('no workspace named: the principal alone, no tenant; requesterFor is the same check by ids', async () => {
    expect(await resolver.resolve(facts(A))).toEqual({ requester: { userId: A } });
    expect(await resolver.requesterFor({ principalId: A, workspaceId: W })).toEqual({ requester: { userId: A, tenantId: W, role: 'owner' } });
  });
});

/** A listener that only records what the cache asks of it; the test plays the connection. */
function fakeListener() {
  const state: { hooks?: { onNotify: (p: string) => void; onConnect: () => void; onDrop: () => void }; started: boolean } = {
    started: false,
  };
  return {
    state,
    listener: (hooks: NonNullable<typeof state.hooks>) => {
      state.hooks = hooks;
      return { start: async () => void (state.started = true), stop: async () => void (state.started = false) };
    },
  };
}

describe('the postgres requester cache', () => {
  const setup = () => {
    let role: string | null = 'member';
    let lookups = 0;
    const fake = fakeListener();
    const sent: string[] = [];
    const cache = new PostgresRequesterCache(
      { db: {} as never, lookup: async () => (lookups++, role) },
      { listener: fake.listener },
    );
    const tx = { execute: async (q: { queryChunks?: unknown[] }) => void sent.push(JSON.stringify(q)) } as never;
    return { cache, fake, tx, sent, setRole: (r: string | null) => (role = r), lookups: () => lookups };
  };
  const key = { principalId: A, workspaceId: W };

  it('stores nothing until the listener connects, then caches', async () => {
    const t = setup();
    await t.cache.start();
    await t.cache.role(key);
    await t.cache.role(key);
    expect(t.lookups()).toBe(2);
    t.fake.state.hooks!.onConnect();
    await t.cache.role(key);
    await t.cache.role(key);
    expect(t.lookups()).toBe(3);
    expect(t.cache.size).toBe(1);
  });

  it('a notification evicts; invalidate notifies on the transaction and evicts here at once', async () => {
    const t = setup();
    t.fake.state.hooks!.onConnect();
    await t.cache.role(key);
    t.setRole('admin');
    t.fake.state.hooks!.onNotify(`${A}:${W}`.toUpperCase());
    expect(await t.cache.role(key)).toBe('admin');
    t.setRole(null);
    await t.cache.invalidate(key, t.tx);
    expect(t.sent.join()).toContain(IDENTITY_REQUESTER_CHANNEL);
    t.cache.evict(key);
    expect(await t.cache.role(key)).toBeNull();
  });

  it("a fill that read before an eviction doesn't store after it", async () => {
    let release!: () => void;
    const fake = fakeListener();
    const cache = new PostgresRequesterCache(
      { db: {} as never, lookup: () => new Promise((r) => (release = () => r('member'))) },
      { listener: fake.listener },
    );
    fake.state.hooks!.onConnect();
    const fill = cache.role(key);
    fake.state.hooks!.onNotify(`${A}:${W}`);
    release();
    expect(await fill).toBe('member');
    expect(cache.size).toBe(0);
  });

  it('a drop stops caching and clears; a reconnect clears again and caches', async () => {
    const t = setup();
    t.fake.state.hooks!.onConnect();
    await t.cache.role(key);
    t.fake.state.hooks!.onDrop();
    expect(t.cache.caching).toBe(false);
    expect(t.cache.size).toBe(0);
    await t.cache.role(key);
    expect(t.cache.size).toBe(0);
    t.fake.state.hooks!.onConnect();
    expect(t.cache.caching).toBe(true);
    await t.cache.role(key);
    expect(t.cache.size).toBe(1);
  });
});

const TX = { tx: true };

describe('the memory requester cache', () => {
  it("a fill racing a change doesn't store the old role after the change's eviction", async () => {
    let release!: () => void;
    const cache = new MemoryRequesterCache({ lookup: () => new Promise((r) => (release = () => r('member'))) });
    const key = { principalId: A, workspaceId: W };
    const fill = cache.role(key);
    cache.evict(key);
    release();
    expect(await fill).toBe('member');
    expect(cache.size).toBe(0);
  });
});

describe('the workspace operations', () => {
  const setup = () => {
    const users = new Set([A, B]);
    const workspaces: Array<{ id: string; name: string; slug: string }> = [];
    const memberships: MembershipRecord[] = [];
    let n = 0;
    const invalidated: string[] = [];
    const evicted: string[] = [];
    const lockedIn: unknown[] = [];
    let failCreate: unknown = null;
    const rows: MembershipRows = {
      create: async (input) => {
        if (failCreate) throw failCreate;
        const m = { id: `m${++n}`, ...input } as MembershipRecord;
        memberships.push(m);
        return m;
      },
      update: async (id, input) => Object.assign(memberships.find((m) => m.id === id)!, input),
      delete: async (id) => void memberships.splice(memberships.findIndex((m) => m.id === id), 1),
      findByWorkspaceIdAndUserId: async (w, u) => memberships.find((m) => m.workspaceId === w && m.userId === u) ?? null,
      findByUserId: async (u) => memberships.filter((m) => m.userId === u),
      findByWorkspaceId: async (w) => memberships.filter((m) => m.workspaceId === w),
    };
    const service = new WorkspaceService({
      db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(TX) } as never,
      workspaces: {
        create: async (input) => {
          const w = { id: W, ...input };
          workspaces.push(w);
          return w;
        },
        findByIds: async (ids) => workspaces.filter((w) => ids.includes(w.id)),
      },
      memberships: rows,
      users: { findById: async (id) => (users.has(id) ? { id } : null) },
      cache: {
        invalidate: async (k) => void invalidated.push(`${k.principalId}:${k.workspaceId}`),
        evict: (k) => void evicted.push(`${k.principalId}:${k.workspaceId}`),
      },
      ownersForUpdate: async (w, tx) => {
        lockedIn.push(tx);
        return memberships.filter((m) => m.workspaceId === w && m.role === 'owner').map((m) => m.userId);
      },
    });
    const as = (userId: string, role?: string) => <T>(fn: () => Promise<T>) => withRequester({ userId, tenantId: W, role }, fn);
    return { service, memberships, invalidated, evicted, lockedIn, as, failWith: (err: unknown) => (failCreate = err) };
  };

  it('the creator owns the new workspace, in one transaction with the invalidation; listMine shows it', async () => {
    const t = setup();
    const created = await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    expect(created.role).toBe('owner');
    expect(t.memberships).toEqual([{ id: 'm1', workspaceId: W, userId: A, role: 'owner' }]);
    expect(t.invalidated).toEqual([`${A}:${W}`]);
    expect(t.evicted).toEqual([`${A}:${W}`]);
    expect(await withRequester({ userId: A }, () => t.service.listMine())).toEqual([
      { workspace: { id: W, name: 'Acme', slug: 'acme' }, role: 'owner' },
    ]);
  });

  it('the rights table: a member adds nobody, an admin makes no owner, an unknown user is not found, twice is a conflict', async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    await expect(t.as(B, 'member')(() => t.service.addMember({ userId: B, role: 'member' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.as(B, 'admin')(() => t.service.addMember({ userId: B, role: 'owner' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.as(A, 'owner')(() => t.service.addMember({ userId: 'nobody', role: 'member' }))).rejects.toBeInstanceOf(NotFoundError);
    await t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'member' }));
    await expect(t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'member' }))).rejects.toBeInstanceOf(ConflictError);
    expect(t.invalidated).toContain(`${B}:${W}`);
  });

  it('the last owner stays: not demoted, not removed; another owner first, then either', async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    await t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'member' }));
    await expect(t.as(A, 'owner')(() => t.service.changeRole({ userId: A, role: 'admin' }))).rejects.toBeInstanceOf(ConflictError);
    await expect(t.as(A, 'owner')(() => t.service.removeMember({ userId: A }))).rejects.toBeInstanceOf(ConflictError);
    await t.as(A, 'owner')(() => t.service.changeRole({ userId: B, role: 'owner' }));
    await t.as(A, 'owner')(() => t.service.removeMember({ userId: A }));
    expect(t.memberships.map((m) => [m.userId, m.role])).toEqual([[B, 'owner']]);
    // The owners were read inside the write's own transaction (locked there by the generated module).
    expect(t.lockedIn.length).toBeGreaterThan(0);
    expect(t.lockedIn.every((tx) => tx === TX)).toBe(true);
  });

  it('two adds of one user at once: the unique index refuses the second, as already_a_member', async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    t.failWith(Object.assign(new Error('duplicate key'), { code: '23505', detail: 'Key (workspace_id, user_id)=(x, y) already exists.' }));
    await expect(t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'member' }))).rejects.toMatchObject({
      status: 409,
      code: 'already_a_member',
    });
  });

  it('a request state with a workspace and no resolved role has no rights', async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    await expect(t.as(B)(() => t.service.removeMember({ userId: B }))).rejects.toMatchObject({ code: 'role_unresolved' });
  });

  it('anyone may leave; nobody signed in is unauthorized; an unknown role is refused', async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    await t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'member' }));
    await t.as(B, 'member')(() => t.service.removeMember({ userId: B }));
    await expect(withRequester({}, () => t.service.listMine())).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'boss' }))).rejects.toThrow(/isn't a role/);
  });
});

describe('the new errors carry Nest bodies', () => {
  it('401, 403, 409', () => {
    expect(errorBody(new UnauthorizedError('nobody is signed in'))).toEqual({ message: 'nobody is signed in', error: 'Unauthorized', statusCode: 401 });
    expect(errorBody(new ForbiddenError('no'))).toEqual({ message: 'no', error: 'Forbidden', statusCode: 403 });
    expect(errorBody(new ConflictError('last', { code: 'last_owner' }))).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'last_owner',
      message: 'last',
    });
  });
});
