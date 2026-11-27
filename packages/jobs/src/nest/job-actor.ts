import type { JobAuthorityLevel } from '../index.ts';

/**
 * Who acts on the jobs, as one union every `JobsService` method takes a part of. The package holds every rule over it
 * (`jobs.policy.ts`); the host only maps its own auth to an actor, per surface. A tenant actor's level comes from its
 * kind, never a stored level, so an actor can't carry a level its kind doesn't hold.
 */

/** A member acting as themselves: a session, or an API key with X-Acting-User whose member holds no admin authority. */
export interface JobMemberActor {
  kind: 'member';
  tenantId: string;
  userId: string;
}

/** A member with tenant-admin authority: their own role, never an impersonator's. */
export interface JobAdminActor {
  kind: 'admin';
  tenantId: string;
  userId: string;
}

/** The tenant itself: a tenant API key with no acting member. Its placeholder member is never the requester. */
export interface JobApiKeyActor {
  kind: 'apiKey';
  tenantId: string;
}

/**
 * A superuser behind the host's superuser gate: every tenant, the internal jobs, and the operator actions. A
 * capability: the host builds one server-side only, behind its superuser gate, never from a request's own claims.
 */
export interface JobOperatorActor {
  kind: 'operator';
  userId: string;
}

/**
 * The app itself, for one tenant: a workflow that applied its own authority (Maintenance behind the superuser
 * gate, a gate's push, calibrate behind its own check). It reaches its tenant's registered jobs, internal ones
 * too, and job authority, audience and limits do not apply to it; the job's `admit` still runs. `userId` is the member
 * it acts for (the requester a start records), or null for the app on its own. Built server-side only, never from a
 * request.
 */
export interface JobSystemActor {
  kind: 'system';
  tenantId: string;
  userId: string | null;
}

export type TenantJobActor = JobMemberActor | JobAdminActor | JobApiKeyActor;
export type JobActor = TenantJobActor | JobOperatorActor | JobSystemActor;

/** A tenant actor's job authority comes from its kind: member < tenant-wide < admin. */
export const TENANT_ACTOR_LEVEL = {
  member: 'member',
  apiKey: 'tenant-wide',
  admin: 'admin',
} as const satisfies Record<TenantJobActor['kind'], JobAuthorityLevel>;

/** Who a start records as `requestedBy`: the member, the superuser or the system's member; null for the tenant itself. */
export const requesterOf = (actor: JobActor): string | null =>
  actor.kind === 'apiKey' ? null : actor.userId;
