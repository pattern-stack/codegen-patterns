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
  requestFacts,
} from '../../../../../runtime/subsystems/identity/core';
import { withRequester } from '../../../../../runtime/base-classes/tenant-context';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, errorBody } from '../../../../../runtime/errors';
import { IdentityConfigSchema } from '../../../../schema/codegen-config.schema';

import { A, B, TX, W, fakeWorkspaces } from './fake-workspaces';

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

  it('a connect clears what was cached before it (the reconnect after a drop that went unnoticed)', async () => {
    const t = setup();
    t.fake.state.hooks!.onConnect();
    await t.cache.role(key);
    expect(t.cache.size).toBe(1);
    t.fake.state.hooks!.onConnect();
    expect(t.cache.size).toBe(0);
  });

  it('an entry is served no longer than its maximum age', async () => {
    let now = 1_000;
    let lookups = 0;
    const cache = new MemoryRequesterCache({ lookup: async () => (lookups++, 'member'), maxAgeMs: 100, now: () => now });
    await cache.role(key);
    await cache.role(key);
    expect(lookups).toBe(1);
    now += 100;
    await cache.role(key);
    expect(lookups).toBe(2);
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
  const setup = fakeWorkspaces;

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
    await expect(t.as(A, 'owner')(() => t.service.addMember({ userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'member' }))).rejects.toBeInstanceOf(NotFoundError);
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

  it('the last owner stays whatever the case of the id sent (ids are normalised where they come in)', async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    await expect(t.as(A, 'owner')(() => t.service.removeMember({ userId: A.toUpperCase() }))).rejects.toMatchObject({ code: 'last_owner' });
    await expect(t.as(A, 'owner')(() => t.service.changeRole({ userId: A.toUpperCase(), role: 'member' }))).rejects.toMatchObject({
      code: 'last_owner',
    });
    await expect(t.as(A, 'owner')(() => t.service.addMember({ userId: 'not-an-id', role: 'member' }))).rejects.toMatchObject({
      code: 'bad_user_id',
    });
  });

  it("the target's membership is read inside the change's transaction, and the rights judged on it", async () => {
    const t = setup();
    await withRequester({ userId: A }, () => t.service.createWorkspace({ name: 'Acme', slug: 'acme' }));
    await t.as(A, 'owner')(() => t.service.addMember({ userId: B, role: 'member' }));
    // B became an owner after an admin's request started: the admin's remove is judged on the locked row, and refused.
    t.memberships.find((m) => m.userId === B)!.role = 'owner';
    t.lockedIn.length = 0;
    await expect(t.as(A, 'admin')(() => t.service.removeMember({ userId: B }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.lockedIn).toEqual([TX]);
  });

  it("a request with no workspace is told what the configured source wants", async () => {
    const t = setup();
    await expect(withRequester({ userId: A, role: 'owner' }, () => t.service.addMember({ userId: B, role: 'member' }))).rejects.toThrow(
      'name the workspace somehow',
    );
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
