/**
 * Requester resolvers (ID-1): how the requester is checked. One row per way, in `REQUESTER_RESOLVERS`.
 *
 * `lookup` checks on every request: the principal from the app's `PrincipalSource`, the workspace from the workspace
 * source, and the principal's role there from the requester cache (which a membership change evicts at once).
 */
import type { RequesterContext } from '../../base-classes/tenant-context';
import type { PrincipalSource, RequestFacts, RequesterOutcome, RequesterPort } from '../../requester';
import type { RequesterCache } from './requester-cache';
import { isGuid, type WorkspaceSource } from './workspace-sources';
import type { RequesterResolverName } from './names';

/** The port, plus the way in for work that has no request (a job, an agent): the same check, by ids. */
export interface RequesterResolver extends RequesterPort {
  requesterFor(who: { principalId: string; workspaceId?: string | null }): Promise<RequesterOutcome>;
}

export interface RequesterResolverDeps {
  principals: PrincipalSource;
  workspaces: WorkspaceSource;
  cache: RequesterCache;
}

export class LookupRequesterResolver implements RequesterResolver {
  constructor(private readonly deps: RequesterResolverDeps) {}

  async resolve(request: RequestFacts): Promise<RequesterOutcome> {
    const principalId = await this.deps.principals.principalOf(request);
    if (!principalId) {
      return {
        refusal: { reason: 'unauthenticated', detail: 'nobody is signed in', instead: 'sign in, then send the request again' },
      };
    }
    const named = this.deps.workspaces.workspaceOf(request);
    if (named && 'malformed' in named) {
      return {
        refusal: {
          reason: 'bad-workspace',
          detail: `'${named.malformed}' isn't a workspace id`,
          instead: this.deps.workspaces.instead,
        },
      };
    }
    return this.requesterFor({ principalId, workspaceId: named?.workspaceId ?? null });
  }

  async requesterFor(who: { principalId: string; workspaceId?: string | null }): Promise<RequesterOutcome> {
    // A principal is a user row's id, and the membership lookup reads a uuid column: anything else is no principal.
    if (!isGuid(who.principalId)) {
      return {
        refusal: {
          reason: 'unauthenticated',
          detail: `'${who.principalId}' isn't a user id`,
          instead: "have the principal source return the signed-in user's id (a uuid)",
        },
      };
    }
    const principalId = who.principalId.toLowerCase();
    if (!who.workspaceId) return { requester: { userId: principalId } satisfies RequesterContext };
    if (!isGuid(who.workspaceId)) {
      return {
        refusal: {
          reason: 'bad-workspace',
          detail: `'${who.workspaceId}' isn't a workspace id`,
          instead: this.deps.workspaces.instead,
        },
      };
    }
    const workspaceId = who.workspaceId.toLowerCase();
    const role = await this.deps.cache.role({ principalId, workspaceId });
    if (role === null) {
      return {
        refusal: {
          reason: 'not-a-member',
          detail: `principal ${principalId} isn't a member of workspace ${workspaceId}`,
          instead: 'name a workspace you belong to, or ask its owner to add you',
        },
      };
    }
    return { requester: { userId: principalId, tenantId: workspaceId, role } satisfies RequesterContext };
  }
}

/** The rows. Adding a resolver is adding a name in `names.ts` and its row here. */
export const REQUESTER_RESOLVERS: Readonly<Record<RequesterResolverName, (deps: RequesterResolverDeps) => RequesterResolver>> = {
  lookup: (deps) => new LookupRequesterResolver(deps),
};
