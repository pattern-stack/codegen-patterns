import {
  authorityAtLeast,
  type JobAuthorityLevel,
  type Run,
} from '../index.ts';
import {
  type JobActor,
  type JobOperatorActor,
  type JobSystemActor,
  TENANT_ACTOR_LEVEL,
  type TenantJobActor,
} from './job-actor.ts';
import { JobAuthorityError, JobRunNotFoundError } from './jobs.errors.ts';
import type { PublicJob, PublicJobCatalog } from './public-job-catalog.ts';

/**
 * Every access rule over `JobActor`, one place (d87). The view a method belongs to decides its wire shape; the actor
 * decides its reach:
 *
 * - **Tenant actors** (member, apiKey, admin) reach public jobs only, in their own tenant, at the level their kind
 *   holds (`TENANT_ACTOR_LEVEL`): below a visible job's level is 403; an internal or unknown job, and a run that is
 *   another tenant's, an internal job's or below the read level, is the same 404.
 * - **The operator** reaches every registered job in every tenant and holds every level: its only 404s are an
 *   unknown job, run or tenant.
 * - **The system** reaches its own tenant's registered jobs, internal ones too, with no job authority, audience
 *   or limit ceiling; a run of another tenant is a 404.
 *
 * A method's actor type refuses a wrong kind at compile time; the runtime guards below catch a cast, as a plain
 * `Error` (a 500 no client can reach), never a client answer.
 */

/** The level a tenant actor holds. */
export const levelOf = (actor: TenantJobActor): JobAuthorityLevel =>
  TENANT_ACTOR_LEVEL[actor.kind];

/** 403 below `needed`, for a tenant actor on a job it can see. */
export function assertLevel(
  actor: TenantJobActor,
  needed: JobAuthorityLevel,
): void {
  if (!authorityAtLeast(levelOf(actor), needed))
    throw new JobAuthorityError(needed);
}

/** Whether a tenant actor may read this public job's runs. */
export const mayRead = (actor: TenantJobActor, job: PublicJob): boolean =>
  authorityAtLeast(levelOf(actor), job.job.authority.read);

/**
 * A tenant actor's view of a run: its tenant's, of a public job, at the job's read level. Every miss is the same
 * 404, with no id echoed.
 */
export function visibleRun(
  actor: TenantJobActor,
  run: Run,
  catalog: PublicJobCatalog,
): PublicJob {
  const publicJob = catalog.get(run.jobKey);
  if (
    run.tenantId !== actor.tenantId ||
    !publicJob ||
    !mayRead(actor, publicJob)
  )
    throw new JobRunNotFoundError();
  return publicJob;
}

/** The system's view of a run: its own tenant's, any registered job. Another tenant's is a 404. */
export function systemRun(actor: JobSystemActor, run: Run): Run {
  if (run.tenantId !== actor.tenantId)
    throw new JobRunNotFoundError();
  return run;
}

function requireKind<K extends JobActor['kind']>(
  actor: JobActor,
  kinds: readonly K[],
): asserts actor is Extract<JobActor, { kind: K }> {
  if (!(kinds as readonly string[]).includes(actor.kind))
    throw new Error(
      `a ${actor.kind} actor reached a jobs method for ${kinds.join(' or ')}: a surface built the wrong actor`,
    );
}

export function requireTenantActor(actor: JobActor): asserts actor is TenantJobActor {
  requireKind(actor, ['member', 'apiKey', 'admin']);
}

export function requireOperator(
  actor: JobActor,
): asserts actor is JobOperatorActor {
  requireKind(actor, ['operator']);
}

export function requireSystem(
  actor: JobActor,
): asserts actor is JobSystemActor {
  requireKind(actor, ['system']);
}
