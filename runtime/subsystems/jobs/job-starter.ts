/**
 * How a generated app starts a job run (JOBS-3): the one entry point app code, the event bridge and
 * `IEventFlow.publishAndStart` call, over `@pattern-stack/jobs`. It replaces ADR-022's `IJobOrchestrator.start`.
 *
 * - Outside a transaction, the run is created through the jobs store and submitted to this process's executor.
 * - Inside the caller's transaction (`tx`), the run is created over a store built on that transaction, so it commits
 *   or rolls back with the caller's own writes (the bridge marks its delivery in the same transaction: exactly once
 *   comes from the transaction, never from the dedupe window). It is not submitted: before the commit no other
 *   connection can see it, and the executor's open-run sweep finds it after (JOBS-3, change 1).
 *
 * The tenant is the run's: the caller's `tenantId`; when it names none (`undefined`), the ambient requester's tenant
 * (a request handler's, ADR-042), so a start inside a tenant's request never lands in another partition; else, or for
 * an explicit `null`, `SYSTEM_TENANT` (single-tenant apps, system work).
 *
 * The Nest host's starter (J-1's `JobRunStarter` is the framework-free one). It is a thin adapter over the package's
 * system start (`JobsService.startSystemRun`, itself `@pattern-stack/jobs/host` `startSystemRun`), which owns the rest: the
 * budget (the job's limits unless the caller names one; a job without limits needs `budget.maxItems`), a process that
 * is no worker never submitting (`JOBS_WORKER`, so no job code runs here without a lease heartbeat), and a failed
 * submit logged, not thrown (the sweep resubmits it).
 */
import { Inject, Injectable } from '@nestjs/common';
import { type Registry, type Run, SYSTEM_TENANT } from '@pattern-stack/jobs';
import { JOBS_REGISTRY, JOBS_TABLES, JobsService } from '@pattern-stack/jobs/nest';
import { type JobDatabase, type JobTables, PostgresJobStore } from '@pattern-stack/jobs/postgres';

import { tryGetRequester } from '../../base-classes/tenant-context';
import type { JobStartOptions } from './job-run-starter';

export type { JobStartOptions };

@Injectable()
export class JobStarter {
  constructor(
    @Inject(JOBS_REGISTRY) private readonly registry: Registry,
    @Inject(JOBS_TABLES) private readonly tables: JobTables,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  /** Whether this process registers the job: the bridge skips a trigger whose job it doesn't have. */
  has(jobKey: string): boolean {
    return this.registry.has(jobKey);
  }

  async start(
    jobKey: string,
    input: unknown,
    options: JobStartOptions = {},
    tx?: unknown,
  ): Promise<{ run: Run; created: boolean }> {
    return this.jobs.startSystemRun(
      { kind: 'system', tenantId: tenantOf(options.tenantId), userId: options.requestedBy ?? null },
      {
        jobKey,
        input,
        trigger: options.trigger ?? 'agent',
        budget: options.budget,
        dedupeKey: options.dedupeKey,
        collision: options.collision,
        dedupeWindowMs: options.dedupeWindowMs,
        dryRun: options.dryRun,
      },
      // In the caller's transaction: it commits with the caller's writes, and the sweep finds it after.
      tx ? { inStore: new PostgresJobStore(tx as JobDatabase, this.tables) } : {},
    );
  }
}

/** The run's tenant: the caller's; omitted, the ambient requester's; else (or `null`) `SYSTEM_TENANT`. */
function tenantOf(asked: string | null | undefined): string {
  if (asked !== undefined) return asked ?? SYSTEM_TENANT;
  return tryGetRequester()?.tenantId ?? SYSTEM_TENANT;
}
