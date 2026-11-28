/**
 * The workspace operations (ID-1): create a workspace (its creator is the owner), add an existing user, change a role,
 * remove a member, list mine. The only writer of `workspace` and `membership` (both `writes: false`).
 *
 * The requester comes from the request state (`requireRequester`): add, change and remove act in its workspace
 * (`tenantId`), with its role there. Every id is normalised once, where it comes in (`idOf`), so every check, the
 * owner count and the cache key see the same id. Each change runs in one transaction: the target's membership and the
 * workspace's owners are read there and locked (`… FOR UPDATE`), the rights are judged on those locked rows, and the
 * requester cache is invalidated in the same transaction (then evicted here once it committed).
 *
 * Typed over the generated repositories' members it calls, structurally (as the connection store is, S-2).
 */
import { requireRequester } from '../../base-classes/tenant-context';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../errors';
import { constraintViolationOf } from '../../db-constraint-errors';
import type { DrizzleClient, DrizzleTx } from '../../types/drizzle';
import { ROLES, type Role } from './names';
import type { MembershipKey, RequesterCache } from './requester-cache';
import { isGuid, type WorkspaceSource } from './workspace-sources';

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
}

export interface MembershipRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
}

export interface WorkspaceRows {
  create(input: { name: string; slug: string }, tx?: DrizzleTx): Promise<WorkspaceRecord>;
  findByIds(ids: string[]): Promise<WorkspaceRecord[]>;
}

export interface MembershipRows {
  create(input: { workspaceId: string; userId: string; role: Role; invitedBy?: string | null }, tx?: DrizzleTx): Promise<MembershipRecord>;
  update(id: string, input: { role: Role }, tx?: DrizzleTx): Promise<MembershipRecord>;
  delete(id: string, tx?: DrizzleTx): Promise<void>;
  findByWorkspaceIdAndUserId(workspaceId: string, userId: string): Promise<MembershipRecord | null>;
  findByUserId(userId: string): Promise<MembershipRecord[]>;
}

export interface UserRows {
  findById(id: string): Promise<{ id: string } | null>;
}

/** What each role may do in its workspace. Read as data: a role's rights are a row here, never a branch. */
export const ROLE_RIGHTS: Readonly<Record<Role, { readonly manage: boolean; readonly manageOwners: boolean }>> = {
  owner: { manage: true, manageOwners: true },
  admin: { manage: true, manageOwners: false },
  member: { manage: false, manageOwners: false },
};

export interface WorkspaceServiceDeps {
  db: DrizzleClient;
  workspaces: WorkspaceRows;
  memberships: MembershipRows;
  users: UserRows;
  cache: Pick<RequesterCache, 'invalidate' | 'evict'>;
  /** How a request names its workspace: its `instead` is what a request with none is told. */
  workspaceSource: Pick<WorkspaceSource, 'instead'>;
  /** The membership of `userId` in `workspaceId`, read inside `tx` and locked (`SELECT … FOR UPDATE`), or null. */
  membershipForUpdate(workspaceId: string, userId: string, tx: DrizzleTx): Promise<MembershipRecord | null>;
  /**
   * The workspace's owners' user ids, read inside `tx` and locked, so two owners stepping down at once can't both see
   * the other and leave the workspace with none: the second waits, then sees one owner.
   */
  ownersForUpdate(workspaceId: string, tx: DrizzleTx): Promise<string[]>;
}

export class WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /** A membership change: in one transaction with the cache's invalidation, then evicted here once it committed. */
  private async change<T>(key: MembershipKey, write: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    const result = await this.deps.db.transaction(async (tx) => {
      const out = await write(tx);
      await this.deps.cache.invalidate(key, tx);
      return out;
    });
    this.deps.cache.evict(key);
    return result;
  }

  /** Create a workspace; the requester becomes its owner. Needs a principal, not a workspace. */
  async createWorkspace(input: { name: string; slug: string }): Promise<{ workspace: WorkspaceRecord; role: Role }> {
    const principalId = principal();
    // The workspace's id is the database's, so the key is known only inside: invalidate and evict around it by hand.
    let key: MembershipKey | null = null;
    const workspace = await this.deps.db.transaction(async (tx) => {
      const created = await this.deps.workspaces.create(input, tx);
      await this.deps.memberships.create({ workspaceId: created.id, userId: principalId, role: 'owner' }, tx);
      key = { principalId, workspaceId: created.id };
      await this.deps.cache.invalidate(key, tx);
      return created;
    });
    if (key) this.deps.cache.evict(key);
    return { workspace, role: 'owner' as const };
  }

  /** Every workspace the requester belongs to, with its role there. */
  async listMine(): Promise<Array<{ workspace: WorkspaceRecord; role: string }>> {
    const memberships = await this.deps.memberships.findByUserId(principal());
    const workspaces = new Map(
      (await this.deps.workspaces.findByIds(memberships.map((m) => m.workspaceId))).map((w) => [w.id, w]),
    );
    return memberships.flatMap((m) => {
      const workspace = workspaces.get(m.workspaceId);
      return workspace ? [{ workspace, role: m.role }] : [];
    });
  }

  /** Add an existing user to the requester's workspace. */
  async addMember(input: { userId: string; role: string }): Promise<MembershipRecord> {
    const { principalId, workspaceId, rights } = this.actor();
    const userId = idOf(input.userId, 'user');
    const role = roleOf(input.role);
    allow(rights.manage, 'add members');
    allow(role !== 'owner' || rights.manageOwners, 'make someone an owner');
    if (!(await this.deps.users.findById(userId))) throw new NotFoundError(`no user ${userId}`);
    const already = () => new ConflictError(`user ${userId} is already a member of workspace ${workspaceId}`, { code: 'already_a_member' });
    try {
      return await this.change({ principalId: userId, workspaceId }, async (tx) => {
        if (await this.deps.membershipForUpdate(workspaceId, userId, tx)) throw already();
        return this.deps.memberships.create({ workspaceId, userId, role, invitedBy: principalId }, tx);
      });
    } catch (err) {
      // Two adds of one user at once: the (workspace, user) unique index refuses the second.
      if (constraintViolationOf(err)?.code === 'unique_violation') throw already();
      throw err;
    }
  }

  /** Change a member's role in the requester's workspace. */
  async changeRole(input: { userId: string; role: string }): Promise<MembershipRecord> {
    const { workspaceId, rights } = this.actor();
    const userId = idOf(input.userId, 'user');
    const role = roleOf(input.role);
    allow(rights.manage, 'change roles');
    return this.change({ principalId: userId, workspaceId }, async (tx) => {
      const membership = await this.lockedMembership(workspaceId, userId, tx);
      allow((role !== 'owner' && membership.role !== 'owner') || rights.manageOwners, "grant or take away 'owner'");
      if (membership.role === 'owner' && role !== 'owner') await this.keepAnOwner(workspaceId, userId, 'demoted', tx);
      return this.deps.memberships.update(membership.id, { role }, tx);
    });
  }

  /** Remove a member from the requester's workspace. Anyone may remove themselves (leave). */
  async removeMember(input: { userId: string }): Promise<void> {
    const { principalId, workspaceId, rights } = this.actor();
    const userId = idOf(input.userId, 'user');
    const leaving = userId === principalId;
    allow(leaving || rights.manage, 'remove members');
    await this.change({ principalId: userId, workspaceId }, async (tx) => {
      const membership = await this.lockedMembership(workspaceId, userId, tx);
      allow(leaving || membership.role !== 'owner' || rights.manageOwners, 'remove an owner');
      if (membership.role === 'owner') await this.keepAnOwner(workspaceId, userId, 'removed', tx);
      await this.deps.memberships.delete(membership.id, tx);
    });
  }

  private actor(): { principalId: string; workspaceId: string; rights: (typeof ROLE_RIGHTS)[Role] } {
    const requester = requireRequester();
    const principalId = principal();
    if (!requester.tenantId) {
      throw new BadRequestError(`this needs a workspace: ${this.deps.workspaceSource.instead}`, { code: 'workspace_required' });
    }
    // Rights are judged on a role the requester resolver checked; a request state without one was never checked.
    if (requester.role === undefined) {
      throw new ForbiddenError(`no role in workspace ${requester.tenantId} was resolved for this request`, { code: 'role_unresolved' });
    }
    return { principalId, workspaceId: idOf(requester.tenantId, 'workspace'), rights: ROLE_RIGHTS[roleOf(requester.role)] };
  }

  /** The target's membership, read inside the change's transaction and locked, so every check sees its current role. */
  private async lockedMembership(workspaceId: string, userId: string, tx: DrizzleTx): Promise<MembershipRecord> {
    const membership = await this.deps.membershipForUpdate(workspaceId, userId, tx);
    if (!membership) throw new NotFoundError(`user ${userId} isn't a member of workspace ${workspaceId}`);
    return membership;
  }

  /** The last owner can't be demoted or removed: read inside the write's transaction, the owners locked. */
  private async keepAnOwner(workspaceId: string, userId: string, what: 'demoted' | 'removed', tx: DrizzleTx): Promise<void> {
    const owners = await this.deps.ownersForUpdate(workspaceId, tx);
    if (owners.map((id) => id.toLowerCase()).filter((id) => id !== userId).length === 0) {
      throw new ConflictError(`the last owner of workspace ${workspaceId} can't be ${what}: make another member an owner first`, {
        code: 'last_owner',
      });
    }
  }
}

/** An id as every check compares it: a uuid, lowercased (as Postgres compares uuids); anything else is refused. */
function idOf(id: string, what: 'user' | 'workspace'): string {
  if (!isGuid(id)) throw new BadRequestError(`'${id}' isn't a ${what} id`, { code: `bad_${what}_id` });
  return id.toLowerCase();
}

function principal(): string {
  const userId = requireRequester().userId;
  if (!userId) throw new UnauthorizedError('nobody is signed in');
  return idOf(userId, 'user');
}

function roleOf(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new BadRequestError(`'${role}' isn't a role: the roles are ${ROLES.join(', ')}`, { code: 'unknown_role' });
  }
  return role as Role;
}

function allow(ok: boolean, what: string): void {
  if (!ok) throw new ForbiddenError(`your role in this workspace can't ${what}`);
}
