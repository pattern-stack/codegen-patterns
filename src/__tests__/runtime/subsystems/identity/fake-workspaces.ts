/**
 * A `WorkspaceService` over in-memory rows (ID-1), for the runtime's unit tests: what each write invalidated and
 * evicted, and which transaction each lock was read in. The smoke's Postgres leg runs the real thing.
 */
import { WorkspaceService, type MembershipRecord, type MembershipRows } from '../../../../../runtime/subsystems/identity/core';
import { withRequester } from '../../../../../runtime/base-classes/tenant-context';

export const W = '11111111-1111-4111-8111-111111111111';
export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** The transaction every change runs in. */
export const TX = { tx: true };

export function fakeWorkspaces() {
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
    workspaceSource: { instead: 'name the workspace somehow' },
    membershipForUpdate: async (w, u, tx) => {
      lockedIn.push(tx);
      return memberships.find((m) => m.workspaceId === w && m.userId === u) ?? null;
    },
    ownersForUpdate: async (w, tx) => {
      lockedIn.push(tx);
      return memberships.filter((m) => m.workspaceId === w && m.role === 'owner').map((m) => m.userId);
    },
  });
  const as = (userId: string, role?: string) => <T>(fn: () => Promise<T>) => withRequester({ userId, tenantId: W, role }, fn);
  return { service, memberships, invalidated, evicted, lockedIn, as, failWith: (err: unknown) => (failCreate = err) };
}
