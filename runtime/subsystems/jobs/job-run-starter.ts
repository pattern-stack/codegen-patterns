/**
 * How a generated app starts a job run (JOBS-3), framework-free (J-1): the one entry point app code, the event bridge
 * and `IEventFlow.publishAndStart` call, over `@pattern-stack/jobs`. A pattern-stack app gets it from the `jobs`
 * system (`app.system('jobs').starter`); the Nest host's `JobStarter` is the same start over `JobsService`.
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
 * The rest is the package's system start (`@pattern-stack/jobs/host` `startSystemRun`), the one the Nest
 * `JobsService.startSystemRun` runs too: the budget (the job's limits unless the caller names one; a job without
 * limits needs `budget.maxItems`), a process that is no worker never submitting (`worker: false`, so no job code runs
 * here without a lease heartbeat), and a failed submit logged, not thrown (the sweep resubmits it).
 */
import { type Collision, type Registry, type Run, type RunTrigger, SYSTEM_TENANT } from '@pattern-stack/jobs';
import { type AskedBudget, startSystemRun } from '@pattern-stack/jobs/host';
import type { Clock, EventSink, Executor, JobStore, RunScope } from '@pattern-stack/jobs/ports';
import { type JobDatabase, type JobTables, PostgresJobStore } from '@pattern-stack/jobs/postgres';

import { tryGetRequester } from '../../base-classes/tenant-context';
import { createLogger } from '../../logger';

export interface JobStartOptions {
  /** The run's tenant. Omitted: the ambient requester's; `null` (or no requester): `SYSTEM_TENANT`. */
  tenantId?: string | null;
  /** At most one open run per tenant, job and key; what a start finding one does is `collision`. */
  dedupeKey?: string;
  collision?: Collision;
  dedupeWindowMs?: number;
  /** Default `'agent'` (app code); the bridge passes `'event'`, a scheduler `'schedule'`. */
  trigger?: RunTrigger;
  /** The acting user, when there is one. */
  requestedBy?: string | null;
  budget?: AskedBudget;
  dryRun?: boolean;
}

/** What a starter is built from: the engine's parts. */
export interface JobRunStarterParts {
  registry: Registry;
  store: JobStore;
  executor: Executor;
  tables: JobTables;
  clock: Clock;
  events: EventSink;
  around?: RunScope;
  /** Whether this process runs the executor's loop. Omitted: it does. */
  worker?: boolean;
}

export class JobRunStarter {
  private readonly logger = createLogger('JobStarter');

  constructor(private readonly parts: JobRunStarterParts) {}

  /** Whether this process registers the job: the bridge skips a trigger whose job it doesn't have. */
  has(jobKey: string): boolean {
    return this.parts.registry.has(jobKey);
  }

  async start(
    jobKey: string,
    input: unknown,
    options: JobStartOptions = {},
    tx?: unknown,
  ): Promise<{ run: Run; created: boolean }> {
    const { worker } = this.parts;
    return startSystemRun(
      { ...this.parts, worker, warn: (m) => this.logger.warn(m) },
      {
        jobKey,
        input,
        tenantId: tenantOf(options.tenantId),
        trigger: options.trigger ?? 'agent',
        requestedBy: options.requestedBy ?? null,
        budget: options.budget,
        dedupeKey: options.dedupeKey,
        collision: options.collision,
        dedupeWindowMs: options.dedupeWindowMs,
        dryRun: options.dryRun,
      },
      // In the caller's transaction: it commits with the caller's writes, and the sweep finds it after.
      tx ? { inStore: new PostgresJobStore(tx as JobDatabase, this.parts.tables) } : {},
    );
  }
}

/** The run's tenant: the caller's; omitted, the ambient requester's; else (or `null`) `SYSTEM_TENANT`. */
function tenantOf(asked: string | null | undefined): string {
  if (asked !== undefined) return asked ?? SYSTEM_TENANT;
  return tryGetRequester()?.tenantId ?? SYSTEM_TENANT;
}
