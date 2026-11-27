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
 * an explicit `null`, `SYSTEM_TENANT` (single-tenant apps, system work). A process that is no worker
 * (`worker: false`) does not submit: the worker's open-run sweep takes the run, so no job code runs here without a
 * lease heartbeat. A failed submit is logged, not thrown: the run is created, and the sweep resubmits it. The budget is the job's limits unless the caller names one (`budgetFor`); a job without limits needs
 * `budget.maxItems`.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  type Collision,
  type Registry,
  type Run,
  type RunTrigger,
  SYSTEM_TENANT,
  startRun,
} from '@pattern-stack/jobs';
import {
  type AskedBudget,
  budgetFor,
  JOBS_CLOCK,
  JOBS_EVENTS,
  JOBS_EXECUTOR,
  JOBS_REGISTRY,
  JOBS_RUN_SCOPE,
  JOBS_STORE,
  JOBS_TABLES,
  JOBS_WORKER,
} from '@pattern-stack/jobs/nest';
import type { Clock, EventSink, Executor, JobStore, RunScope } from '@pattern-stack/jobs/ports';
import { type JobDatabase, type JobTables, PostgresJobStore } from '@pattern-stack/jobs/postgres';

import { tryGetRequester } from '../../base-classes/tenant-context';

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

@Injectable()
export class JobStarter {
  constructor(
    @Inject(JOBS_REGISTRY) private readonly registry: Registry,
    @Inject(JOBS_STORE) private readonly store: JobStore,
    @Inject(JOBS_EXECUTOR) private readonly executor: Executor,
    @Inject(JOBS_TABLES) private readonly tables: JobTables,
    @Inject(JOBS_CLOCK) private readonly clock: Clock,
    @Inject(JOBS_EVENTS) private readonly events: EventSink,
    @Optional() @Inject(JOBS_RUN_SCOPE) private readonly around?: RunScope,
    @Optional() @Inject(JOBS_WORKER) private readonly worker?: boolean,
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
    const job = this.registry.get(jobKey);
    const store = tx ? new PostgresJobStore(tx as JobDatabase, this.tables) : this.store;
    const started = await startRun(
      { registry: this.registry, store, around: this.around, clock: this.clock, events: this.events },
      {
        jobKey,
        input,
        tenantId: tenantOf(options.tenantId),
        trigger: options.trigger ?? 'agent',
        requestedBy: options.requestedBy ?? null,
        budget: budgetFor(job, options.budget, { now: this.clock.now(), ceiling: false }),
        dedupeKey: options.dedupeKey,
        collision: options.collision,
        dedupeWindowMs: options.dedupeWindowMs,
        dryRun: options.dryRun,
      },
    );
    // A run created in the caller's transaction is found by the sweep once it commits; so is one started where no
    // executor loop runs.
    if (!tx && started.run.status === 'pending' && this.worker !== false) {
      try {
        await this.executor.submit(started.run.id);
      } catch (err) {
        this.logger.warn(
          `job run ${started.run.id} was not submitted (${err instanceof Error ? err.name : typeof err}); the sweep resubmits it`,
        );
      }
    }
    return started;
  }

  private readonly logger = new Logger(JobStarter.name);
}

/** The run's tenant: the caller's; omitted, the ambient requester's; else (or `null`) `SYSTEM_TENANT`. */
function tenantOf(asked: string | null | undefined): string {
  if (asked !== undefined) return asked ?? SYSTEM_TENANT;
  return tryGetRequester()?.tenantId ?? SYSTEM_TENANT;
}
