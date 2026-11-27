import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { assertResolvable, buildJobs, type JobEntry } from '../define/job-factory.ts';
import { InProcessExecutor, type InProcessOptions } from '../adapters/in-process-executor.ts';
import { localLimiters } from '../adapters/local-limiter.ts';
import type { RunScope } from '../ports/run-scope.ts';
import { BullmqExecutor, type JobEngineQueue } from '../bullmq.ts';
import {
  type AnyJob,
  createRegistry,
  type Registry,
  systemClock,
} from '../index.ts';
import type { EventSink, LimiterConfig, Limiters } from '../ports.ts';
import {
  eventLogSink,
  type JobDatabase,
  type JobTables,
  PostgresJobStore,
} from '../postgres.ts';
import {
  evalScripting,
  type RedisEvalClient,
  redisLimiters,
  redisSweepCursors,
} from '../redis.ts';
import { activeSpanSink, fanOut, nestLogSink } from './event-sinks.ts';
import { JobInputRefRegistry } from './job-input-refs.ts';
import { JobsService } from './jobs.service.ts';
import { JobEngineLifecycle } from './lifecycle.ts';
import { assertLimitersConfigured } from './limiters.ts';
import { publicJobCatalogOf } from './public-job-catalog.ts';
import {
  JOBS_CLOCK,
  JOBS_DEFINITIONS,
  JOBS_DRIZZLE,
  JOBS_ENGINE_LIMITERS,
  JOBS_ENGINE_SINKS,
  JOBS_EVENT_SINKS,
  JOBS_EVENTS,
  JOBS_EXECUTOR,
  JOBS_INPUT_REFS,
  JOBS_LIMITER_CONFIG,
  JOBS_OPERATOR_READS,
  JOBS_PUBLIC_CATALOG,
  JOBS_QUEUE,
  JOBS_REDIS,
  JOBS_REGISTRY,
  JOBS_STORE,
  JOBS_RUN_SCOPE,
  JOBS_TABLES,
  JOBS_WORKER,
} from './tokens.ts';

/**
 * How a host's jobs run: `bullmq` (the store is the truth, BullMQ dispatches each run's
 * advances, limiters on Redis/Valkey; the host binds `JOBS_QUEUE` and `JOBS_REDIS` and runs the BullMQ worker), or
 * `in-process` (no Redis: an `InProcessExecutor` in this process, limiters in memory, the open-run sweep and the advance
 * lease holding one advancer per run across replicas). `worker: false` builds the in-process executor but never starts
 * its loop (an API-only process: its starts are swept up by a worker process).
 */
export type JobsModuleOptions =
  | { executor: 'bullmq' }
  | {
      executor: 'in-process';
      /** Start the executor's loop at bootstrap. Default true. */
      worker?: boolean;
      /** The in-process executor's options (poll, sweep, lease, drain window). */
      inProcess?: Omit<InProcessOptions, 'store' | 'registry' | 'limiters' | 'sinks' | 'around' | 'clock'>;
    };

/** The app's job list built: each `jobFactory` entry with its dependencies resolved from the host's container. */
const JOBS_BUILT = Symbol.for('@pattern-stack/jobs.JOBS_BUILT');

/**
 * At bootstrap, every job factory's dependency resolves, or the boot stops naming the job and the dependency (a
 * missing provider fails here, not at the first run).
 */
@Injectable()
class JobFactoryDependencies implements OnApplicationBootstrap {
  constructor(
    @Inject(JOBS_DEFINITIONS) private readonly entries: readonly JobEntry[],
    @Inject(JOBS_BUILT) private readonly jobs: readonly AnyJob[],
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    assertResolvable(this.entries, this.jobs, (token) => this.moduleRef.get(token as never, { strict: false }));
  }
}

/** The providers both executors share: the registry, the catalog, the store, the sinks, the service. */
const SHARED: Provider[] = [
    // `JOBS_DEFINITIONS` may hold job factories (`jobFactory`): each is built with its dependencies resolved through
    // `ModuleRef` (any of the host's modules), handed as stand-ins resolved on first use (`buildJobs`), so the list is
    // built while Nest is still constructing providers. This is the factory's Nest binding.
    {
      provide: JOBS_BUILT,
      useFactory: (entries: readonly JobEntry[], moduleRef: ModuleRef): AnyJob[] =>
        buildJobs(entries, (token) => moduleRef.get(token as never, { strict: false })),
      inject: [JOBS_DEFINITIONS, ModuleRef],
    },
    JobFactoryDependencies,
    {
      provide: JOBS_REGISTRY,
      useFactory: (definitions: readonly AnyJob[]): Registry =>
        createRegistry([...definitions]),
      inject: [JOBS_BUILT],
    },
    // Every public job, built once: a public job whose shapes cannot be published stops the boot.
    {
      provide: JOBS_PUBLIC_CATALOG,
      useFactory: publicJobCatalogOf,
      inject: [JOBS_REGISTRY],
    },
    { provide: JOBS_CLOCK, useValue: systemClock },
    // No dependencies, so a domain module the host imports may inject it without closing a cycle.
    { provide: JOBS_INPUT_REFS, useClass: JobInputRefRegistry },
    {
      provide: JOBS_STORE,
      useFactory: (db: JobDatabase, tables: JobTables) =>
        new PostgresJobStore(db, tables),
      inject: [JOBS_DRIZZLE, JOBS_TABLES],
    },
    // The operator reads across tenants live on the store, off the port.
    { provide: JOBS_OPERATOR_READS, useExisting: JOBS_STORE },
    // The package's sinks (the active span, the log, the event log), then the host's: an open port, none bound today.
    {
      provide: JOBS_ENGINE_SINKS,
      useFactory: (
        store: PostgresJobStore,
        host: readonly EventSink[] | undefined,
      ): EventSink[] => [
        activeSpanSink(),
        nestLogSink(new Logger('JobEngine')),
        eventLogSink(store),
        ...(host ?? []),
      ],
      inject: [JOBS_STORE, { token: JOBS_EVENT_SINKS, optional: true }],
    },
    // The sinks as one, for JobsService: a sink's throw never stops the others or the caller.
    {
      provide: JOBS_EVENTS,
      useFactory: (sinks: EventSink[]): EventSink => fanOut(sinks),
      inject: [JOBS_ENGINE_SINKS],
    },
    JobsService,
    // Runs the refs boot check at bootstrap; drains the executor before shutdown.
    JobEngineLifecycle,
];

/** BullMQ: limiters on the host's Redis/Valkey, and the BullMQ executor over the host's queue. */
const BULLMQ: Provider[] = [
    // A registered job naming a limiter with no config stops the boot: its quota would be a guess.
    {
      provide: JOBS_ENGINE_LIMITERS,
      useFactory: (
        redis: RedisEvalClient,
        config: Readonly<Record<string, LimiterConfig>>,
        registry: Registry,
      ): Limiters => {
        assertLimitersConfigured(registry, config);
        return redisLimiters(evalScripting(redis), config);
      },
      inject: [JOBS_REDIS, JOBS_LIMITER_CONFIG, JOBS_REGISTRY],
    },
    {
      provide: JOBS_EXECUTOR,
      useFactory: (
        queue: JobEngineQueue,
        store: PostgresJobStore,
        registry: Registry,
        sinks: EventSink[],
        limiters: Limiters,
        redis: RedisEvalClient,
        around: RunScope | undefined,
      ) => {
        const logger = new Logger('JobEngine');
        // No carry: the worker handler passes the run's root to handle(job, { trace }).
        return new BullmqExecutor(queue, store, registry, {
          sinks,
          limiters,
          around,
          // The sweep is one scheduled job on any worker: its cursors are shared, on the host's Valkey.
          sweepCursors: redisSweepCursors(evalScripting(redis)),
          warn: (message) => logger.warn(message),
        });
      },
      inject: [
        JOBS_QUEUE,
        JOBS_STORE,
        JOBS_REGISTRY,
        JOBS_ENGINE_SINKS,
        JOBS_ENGINE_LIMITERS,
        JOBS_REDIS,
        { token: JOBS_RUN_SCOPE, optional: true },
      ],
    },
];

/** In process: limiters in memory, and an `InProcessExecutor` started at bootstrap when this process is a worker. */
const inProcessProviders = (
  options: Extract<JobsModuleOptions, { executor: 'in-process' }>,
): Provider[] => [
  {
    provide: JOBS_ENGINE_LIMITERS,
    useFactory: (
      config: Readonly<Record<string, LimiterConfig>>,
      registry: Registry,
    ): Limiters => {
      assertLimitersConfigured(registry, config);
      return localLimiters(config);
    },
    inject: [JOBS_LIMITER_CONFIG, JOBS_REGISTRY],
  },
  {
    provide: JOBS_EXECUTOR,
    useFactory: (
      store: PostgresJobStore,
      registry: Registry,
      sinks: EventSink[],
      limiters: Limiters,
      around: RunScope | undefined,
    ) =>
      new InProcessExecutor({
        ...options.inProcess,
        store,
        registry,
        sinks,
        limiters,
        ...(around ? { around } : {}),
      }),
    inject: [
      JOBS_STORE,
      JOBS_REGISTRY,
      JOBS_ENGINE_SINKS,
      JOBS_ENGINE_LIMITERS,
      { token: JOBS_RUN_SCOPE, optional: true },
    ],
  },
  { provide: JOBS_WORKER, useValue: options.worker ?? true },
];

/**
 * The jobs capability in a Nest host, the way `@pattern-stack/query-surface/nest`'s module is: it provides one
 * `JobsService` and builds the Postgres store, the executor and the limiters from the host's handles. The host binds
 * the tokens it reads (`tokens.ts`) in a `@Global()` host module, or the package module's injector cannot see them.
 * It ships no controller: each surface is the host's.
 */
@Module({})
export class JobsModule {
  static forRoot(options: JobsModuleOptions): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        ...SHARED,
        ...(options.executor === 'bullmq' ? BULLMQ : inProcessProviders(options)),
      ],
      exports: [
        JOBS_REGISTRY,
    JobsService,
    JOBS_INPUT_REFS,
    JOBS_STORE,
    JOBS_EXECUTOR,
    JOBS_PUBLIC_CATALOG,
    JOBS_EVENTS,
    JOBS_CLOCK,
],
    };
  }
}
