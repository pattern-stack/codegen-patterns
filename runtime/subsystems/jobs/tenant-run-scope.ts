/**
 * The run scope codegen's generated apps hand `@pattern-stack/jobs` (JOBS-3, the review's change 4): every call into
 * a job's code runs inside the repositories' requester scope (ADR-042), entered from the run's own tenant. A job has no
 * request, so the engine is the boundary: every entity-repository read and write inside a step is scoped to the tenant
 * that owns the run.
 *
 * `SYSTEM_TENANT` (single-tenant apps and cross-tenant housekeeping) enters the null tenant partition, as a NULL
 * `tenant_id` did under ADR-022. The user axis is `superuser`: a run carries no acting user to scope by, so entering
 * with the system actor under the default `'user'` scope would filter every `user_tracking` repository to a user that
 * does not exist. A step acting for a particular user carries that user in its input and narrows the scope itself.
 */
import { SYSTEM_TENANT } from '@pattern-stack/jobs';
import type { RunScope } from '@pattern-stack/jobs/ports';

import { SYSTEM_ACTOR_ID, withRequester } from '../../base-classes/tenant-context';

export const tenantRunScope: RunScope = (target, fn) =>
  withRequester(
    {
      userId: SYSTEM_ACTOR_ID,
      organizationId: null,
      scope: 'superuser',
      tenantId: target.tenantId === SYSTEM_TENANT ? null : target.tenantId,
    },
    fn,
  );
