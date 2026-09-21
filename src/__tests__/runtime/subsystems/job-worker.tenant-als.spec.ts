/**
 * TEN-1 (#585) / ADR-042 §6 — the worker enters the repository scope ALS from
 * the run's own tenant.
 *
 * A job has no request, so nothing else can install the boundary. Without this,
 * every entity-repository read inside a handler runs with NO ambient context:
 * under the strict enforcement a `tenant_scoped` entity is emitted with, that
 * is a throw; under lenient it would be a read across every tenant.
 *
 * Three properties are pinned here, and the second is the one ADR-042's sketch
 * got wrong (TEN-1 §Found #5):
 *
 *   1. `tenantId` comes from the CLAIMED ROW, not from configuration.
 *   2. the USER axis is `'superuser'`. `job_run` has no `user_id` column
 *      (TEN-1 §M4), so the sentinel is an audit-trail value, not an identity to
 *      filter by. Entering under the default `'user'` scope would silently
 *      scope every `userTracking` repository to a user that does not exist.
 *   3. `tenantId: null` is PRESENT, not absent — cross-tenant housekeeping work
 *      selects the null partition instead of throwing for want of a boundary.
 *
 * Unit-level: no Postgres. The semantics against a real database, including a
 * handler that actually reads a tenant-scoped repository, are proven in
 * `test/scaffold/tests/tenant-scoping.test.ts` §"the job path".
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';

import { JobWorker } from '../../../../runtime/subsystems/jobs/job-worker';
import {
  JOB_HANDLER_REGISTRY,
  JobHandlerBase,
  type JobContext,
} from '../../../../runtime/subsystems/jobs/job-handler.base';
import type { JobRunRow } from '../../../../runtime/subsystems/jobs/job-orchestration.schema';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';
import {
  SYSTEM_ACTOR_ID,
  tryGetRequester,
  type RequesterContext,
} from '../../../../runtime/base-classes/tenant-context';

const JOB_TYPE = 'tenant_als_probe';
const POOL = 'batch';

/** Records the ambient context the handler body observes. */
let seen: RequesterContext | undefined;

class ProbeHandler extends JobHandlerBase<unknown, { ok: true }> {
  async run(_ctx: JobContext<unknown>): Promise<{ ok: true }> {
    seen = tryGetRequester();
    return { ok: true };
  }
}

/**
 * A stub client that swallows the claim/complete statements. Only the handler
 * call matters here; `claimNext` is bypassed by driving `processRun` directly.
 */
function stubDb(): DrizzleClient {
  const chain: Record<string, unknown> = {};
  chain['set'] = () => chain;
  chain['where'] = () => Promise.resolve(undefined);
  chain['from'] = () => chain;
  chain['then'] = (resolve: (v: unknown) => unknown) => resolve([]);
  return {
    update: () => chain,
    select: () => chain,
  } as unknown as DrizzleClient;
}

function makeWorker(): JobWorker {
  return new JobWorker(
    stubDb(),
    {} as never,
    {} as never,
    {} as never,
    { pool: POOL, concurrency: 1 },
    { get: () => new ProbeHandler() } as never,
  );
}

function claimedRow(tenantId: string | null): JobRunRow {
  return {
    id: 'run-1',
    jobType: JOB_TYPE,
    pool: POOL,
    status: 'running',
    input: {},
    attempts: 0,
    tenantId,
  } as unknown as JobRunRow;
}

/** Drive the private `processRun` — the method that owns the ALS entry. */
async function runWith(tenantId: string | null): Promise<void> {
  seen = undefined;
  JOB_HANDLER_REGISTRY.set(JOB_TYPE, {
    handlerClass: ProbeHandler as never,
    meta: { jobType: JOB_TYPE, pool: POOL } as never,
  });
  const worker = makeWorker() as unknown as {
    processRun(row: JobRunRow): Promise<void>;
  };
  await worker.processRun(claimedRow(tenantId));
}

afterEach(() => {
  JOB_HANDLER_REGISTRY.delete(JOB_TYPE);
});

describe('JobWorker.processRun — repository scope ALS (ADR-042 §6)', () => {
  it('runs the handler inside a context carrying the run\'s own tenant', async () => {
    await runWith('tenant-a');
    expect(seen).toBeDefined();
    expect(seen?.tenantId).toBe('tenant-a');
  });

  it('uses the SYSTEM_ACTOR_ID sentinel for the audit-trail user', async () => {
    await runWith('tenant-a');
    expect(seen?.userId).toBe(SYSTEM_ACTOR_ID);
    expect(seen?.organizationId).toBeNull();
  });

  it('enters with scope: superuser so the USER axis does not filter', async () => {
    // Found #5: without this a `userTracking` repo inside every job would
    // filter `user_id = '__system__'` and silently return nothing.
    await runWith('tenant-a');
    expect(seen?.scope).toBe('superuser');
  });

  it('a null-tenant run selects the null partition — present, not absent', async () => {
    await runWith(null);
    expect(seen).toBeDefined();
    expect(seen?.tenantId).toBeNull();
    // `null`, not `undefined`: a strict tenant-scoped repo inside this job
    // filters `IS NULL` rather than throwing for want of a boundary.
    expect('tenantId' in (seen as object)).toBe(true);
  });

  it('does not set tenantScope — a job is scoped to its tenant, not across them', async () => {
    await runWith('tenant-a');
    expect(seen?.tenantScope).toBeUndefined();
  });

  it('the context does not leak past the handler call', async () => {
    await runWith('tenant-a');
    expect(tryGetRequester()).toBeUndefined();
  });

  it('a different run enters a different tenant — the value is per-run', async () => {
    await runWith('tenant-a');
    expect(seen?.tenantId).toBe('tenant-a');
    await runWith('tenant-b');
    expect(seen?.tenantId).toBe('tenant-b');
  });
});
