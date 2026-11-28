/**
 * The jobs subsystem in a generated Nest app (JOBS-3): `@pattern-stack/jobs` on the app's Postgres, run in process.
 * It replaces ADR-022's `JobsDomainModule` + `JobWorkerModule`.
 *
 * A `@Global()` host module: it binds the tokens `@pattern-stack/jobs/nest`'s `JobsModule` reads (the app's Drizzle
 * client, the package's job tables, the app's job definitions, the limiter config, the tenants and the tenant run
 * scope), imports `JobsModule.forRoot({ executor: 'in-process' })`, and provides `JobStarter`. The executor's loop
 * starts after every module's init when this process is a worker (`worker: true`, the embedded mode; a standalone
 * `worker.ts` passes true and the HTTP process false). The app's entry owns SIGTERM: `app.close()` drains it.
 *
 * Pools are limiters: `jobs.pools.<name>.concurrency` in `codegen.config.yaml` is the limiter `<name>`'s `inFlight`,
 * and a job's step names its pool as `step({ limiter: '<name>' })`. Priority is a pool of its own (codegen-targets
 * d36): work that must not wait names a limiter nothing else fills.
 */
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { InProcessOptions, JobEntry } from '@pattern-stack/jobs';
import {
  JOBS_DEFINITIONS,
  JOBS_DRIZZLE,
  JOBS_LIMITER_CONFIG,
  JOBS_RUN_SCOPE,
  JOBS_TABLES,
  JOBS_TENANTS,
  JobsModule,
  JobsService,
  type JobsTenants,
} from '@pattern-stack/jobs/nest';
import type { LimiterConfig } from '@pattern-stack/jobs/ports';
import { jobTables } from '@pattern-stack/jobs/postgres';

import { DRIZZLE } from '../../constants/tokens';
import { JobStarter } from './job-starter';
import { tenantRunScope } from './tenant-run-scope';

export interface JobsEngineOptions {
  /**
   * Every job this app runs: the generated `jobDefinitions`. `@pattern-stack/jobs/nest` builds each `jobFactory`
   * entry with its dependencies resolved from the app's container (any module's providers, through `ModuleRef`).
   */
  definitions: readonly JobEntry[];
  /** Start the executor's loop in this process. */
  worker: boolean;
  /** The pools: each limiter a step names, by name. */
  limiters?: Readonly<Record<string, LimiterConfig>>;
  /** The in-process executor's knobs (poll, open-run sweep, lease, drain window). */
  inProcess?: Omit<InProcessOptions, 'store' | 'registry' | 'limiters' | 'sinks' | 'around' | 'clock'>;
}

/** Every tenant id is a tenant: the app's own auth decides who may start what before a start reaches the engine. */
const anyTenant: JobsTenants = { findById: async (id) => ({ id }) };

@Global()
@Module({})
export class JobsEngineModule {
  static forRoot(options: JobsEngineOptions): DynamicModule {
    return {
      module: JobsEngineModule,
      imports: [
        JobsModule.forRoot({
          executor: 'in-process',
          worker: options.worker,
          // A run created in a caller's transaction (the bridge's) is found by the sweep: every second by default.
          inProcess: { openSweepEvery: 4, ...options.inProcess },
        }),
      ],
      providers: [
        { provide: JOBS_DRIZZLE, useExisting: DRIZZLE },
        { provide: JOBS_TABLES, useValue: jobTables },
        { provide: JOBS_DEFINITIONS, useValue: options.definitions },
        { provide: JOBS_LIMITER_CONFIG, useValue: options.limiters ?? {} },
        { provide: JOBS_TENANTS, useValue: anyTenant },
        { provide: JOBS_RUN_SCOPE, useValue: tenantRunScope },
        JobStarter,
      ],
      exports: [
        JOBS_DRIZZLE,
        JOBS_TABLES,
        JOBS_DEFINITIONS,
        JOBS_LIMITER_CONFIG,
        JOBS_TENANTS,
        JOBS_RUN_SCOPE,
        JobStarter,
        JobsModule,
      ],
    };
  }
}

export { JobsService };
