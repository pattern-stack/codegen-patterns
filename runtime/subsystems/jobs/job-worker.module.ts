/**
 * JobWorkerModule — `DynamicModule.forRoot({ mode, pools? })` factory that
 * boots one `JobWorker` per active pool and runs the boot-time validator
 * (Drizzle only) (ADR-022, JOB-5).
 *
 * Imports `JobsDomainModule` internally so call sites only need to add
 * `JobWorkerModule.forRoot(...)` to `AppModule.imports` — the protocol
 * tokens become available transitively via `global: true`.
 *
 * Lifecycle (`onModuleInit`, **order-critical** per JOB-5 spec):
 *   1. `loadPoolConfig()`                        → resolved `PoolConfig`
 *   2. `HandlerRegistry.getAll()`                → registered entries
 *   3. Reserved-pool validation                  → throws `ReservedPoolViolationError`
 *   4. `orchestrator.upsertJobRows(entries, …)`  → persist `job` definitions
 *   5. Boot validator (Drizzle only)             → throws `BootValidationError`
 *      (skipped entirely in memory mode — Q4 resolution 2026-04-19)
 *   6. Spawn one `JobWorker` per active pool     → start polling loops
 *
 * `onModuleDestroy` calls `gracefulStop` on each worker (drains in-flight,
 * resets `running` rows, removes SIGTERM handler).
 */
import {
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';
import { HandlerRegistry, type HandlerRegistryEntry } from './job-handler.base';
import {
  JobsDomainModule,
  type JobsDomainModuleOptions,
} from './jobs-domain.module';
import {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
} from './jobs-domain.tokens';
import type { IJobOrchestrator } from './job-orchestrator.protocol';
import type { IJobRunService } from './job-run-service.protocol';
import type { IJobStepService } from './job-step-service.protocol';
import {
  allNonReservedPoolNames,
  loadPoolConfig,
  type PoolConfig,
} from './pool-config.loader';
import { JobWorker, type JobWorkerOptions } from './job-worker';
import {
  BootValidationError,
  ReservedPoolViolationError,
} from './jobs-errors';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface JobWorkerModuleOptions {
  mode: 'embedded' | 'standalone';
  /**
   * Threads into the internal `JobsDomainModule.forRoot({ backend })`
   * import. Default `'drizzle'`. The boot-time validator runs only when
   * this is `'drizzle'`.
   */
  backend?: 'drizzle' | 'memory';
  /**
   * Active pool names. Defaults to every non-reserved pool in the resolved
   * config (i.e. `interactive`, `batch`, plus any user-defined pools).
   * Operators reduce this to one or two pools per worker process to scale
   * horizontally.
   */
  pools?: string[];
  /** SIGTERM drain budget. Default 30_000 ms. */
  shutdownTimeoutMs?: number;
  /**
   * Test-only — point the pool config loader at a specific YAML file.
   * Production code reads `${process.cwd()}/codegen.config.yaml`.
   */
  configPath?: string;
  /**
   * Forwarded into the inner `JobsDomainModule.forRoot()` call so the
   * worker module's caller can configure backend extensions in one place.
   */
  domainModuleExtensions?: JobsDomainModuleOptions['extensions'];
  /** Forwarded into `JobsDomainModule.forRoot()`. JOB-8 wires this. */
  multiTenant?: boolean;
  /**
   * Test-only escape hatch — when set, the module uses this factory
   * instead of `new JobWorker(...)` so unit tests can stub the worker
   * without spinning up the polling loop.
   */
  workerFactory?: (options: JobWorkerOptions) => Pick<JobWorker, 'onModuleInit' | 'onModuleDestroy'>;
}

/**
 * DI token for the resolved `JobWorkerModuleOptions`. Exported so other
 * subsystems can inject it `@Optional()` and inspect the active
 * configuration — e.g. `BridgeModule.onModuleInit` checks
 * `options.pools` against `BRIDGE_RESERVED_POOLS` to fail fast when a
 * reserved pool isn't being polled (BRIDGE-8).
 */
export const JOB_WORKER_MODULE_OPTIONS = Symbol('JOB_WORKER_MODULE_OPTIONS');

/**
 * The lifecycle holder. Named `JobWorkerOrchestrator` in the spec to avoid
 * collision with `JobWorker` and `IJobOrchestrator`. Registered as a
 * provider on `JobWorkerModule`; Nest invokes `onModuleInit` /
 * `onModuleDestroy` automatically.
 */
@Injectable()
export class JobWorkerOrchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobWorkerOrchestrator.name);
  private readonly workers: Array<Pick<JobWorker, 'onModuleInit' | 'onModuleDestroy'>> = [];

  constructor(
    @Inject(JOB_ORCHESTRATOR) private readonly orchestrator: IJobOrchestrator,
    @Inject(JOB_RUN_SERVICE) private readonly runService: IJobRunService,
    @Inject(JOB_STEP_SERVICE) private readonly stepService: IJobStepService,
    @Inject(JOB_WORKER_MODULE_OPTIONS)
    private readonly options: JobWorkerModuleOptions,
    /**
     * Drizzle client is only required when `backend === 'drizzle'`. Made
     * `@Optional()` so memory-mode boots in `Test.createTestingModule`
     * without supplying a `DRIZZLE` provider.
     */
    @Optional() @Inject(DRIZZLE) private readonly db: DrizzleClient | null = null,
  ) {}

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async onModuleInit(): Promise<void> {
    const backend = this.options.backend ?? 'drizzle';

    // (1) Pool config first — every later step needs the resolved map.
    const poolConfig = loadPoolConfig(this.options.configPath);

    // (2) Snapshot the registry. Decorators run at class-load time so the
    //     map is fully populated before any module init fires.
    const entries = HandlerRegistry.getAll();

    // (3) Reserved-pool validation BEFORE the upsert. Persisting a
    //     reserved-pool handler row would leave the DB in a bad state for
    //     the next boot to clean up.
    this.assertNoReservedPoolHandlers(entries, poolConfig);

    // (4) Upsert `job` definitions. Drizzle: hash-gated `ON CONFLICT DO
    //     UPDATE`. Memory: populates `MemoryJobStore.jobs` + handler-class
    //     registry.
    const { orphaned } = await this.orchestrator.upsertJobRows(
      entries,
      poolConfig,
    );

    // (5) Boot validator — Drizzle only. Memory mode never has DB rows
    //     to validate (Q4 resolution 2026-04-19); the equivalent
    //     protection is `MemoryJobOrchestrator.start()` throwing
    //     `JobTypeNotFoundError` synchronously for unknown types.
    if (backend !== 'memory' && orphaned.length > 0) {
      throw new BootValidationError(orphaned);
    }

    // (6) Resolve active pool list and spawn one worker per pool.
    const activePools =
      this.options.pools ?? allNonReservedPoolNames(poolConfig);

    for (const poolName of activePools) {
      const def = poolConfig.get(poolName);
      if (!def) {
        throw new Error(
          `JobWorkerModule: active pool '${poolName}' is not defined in ` +
            `the resolved pool config. Configured pools: [${[...poolConfig.keys()].join(', ')}].`,
        );
      }
      const workerOptions: JobWorkerOptions = {
        pool: def.queue,
        concurrency: def.concurrency,
        shutdownTimeoutMs:
          this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      };
      const worker = this.options.workerFactory
        ? this.options.workerFactory(workerOptions)
        : this.spawnWorker(workerOptions);
      // `JobWorker` extends Nest's lifecycle hooks but the worker isn't
      // a Nest provider here (we manage the array ourselves). Call
      // `onModuleInit` synchronously to start the polling loop.
      worker.onModuleInit();
      this.workers.push(worker);
      this.logger.log(
        `JobWorker started: pool='${def.queue}' concurrency=${def.concurrency}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Tear down in reverse order so the most recently started worker
    // drains first — keeps the SIGTERM handler graph predictable.
    for (let i = this.workers.length - 1; i >= 0; i--) {
      const worker = this.workers[i];
      if (!worker) continue;
      try {
        await worker.onModuleDestroy();
      } catch (err) {
        this.logger.error(
          `JobWorker shutdown failed: ${(err as Error).message}`,
        );
      }
    }
    this.workers.length = 0;
  }

  // ============================================================================
  // Internals
  // ============================================================================

  /**
   * Walk every registered handler; collect any whose declared `pool`
   * targets a reserved pool from the resolved config. If non-empty,
   * throw `ReservedPoolViolationError` with the offender list so the
   * operator sees every violating class on a single boot.
   */
  private assertNoReservedPoolHandlers(
    entries: HandlerRegistryEntry[],
    poolConfig: PoolConfig,
  ): void {
    const offenders: Array<{ handlerClass: string; pool: string }> = [];
    for (const entry of entries) {
      // Framework-owned handlers (`@framework/*` job types) are allowed in
      // reserved pools — that is in fact the entire point of the reserved
      // `events_*` pools (ADR-022 + ADR-023). The reserved-pool guard
      // exists to keep USER handlers out, not the framework's own
      // bridge-delivery handler. BRIDGE-5 introduced this exemption.
      if (entry.type.startsWith('@framework/')) continue;
      const declaredPool = entry.meta.pool ?? 'batch';
      const def = poolConfig.get(declaredPool);
      if (def?.reserved) {
        offenders.push({
          handlerClass: entry.handlerClass.name,
          pool: declaredPool,
        });
      }
    }
    if (offenders.length > 0) {
      throw new ReservedPoolViolationError(offenders);
    }
  }

  /**
   * Production worker spawn. `JobWorker` requires `DRIZZLE` so this only
   * succeeds when the module was booted with `backend: 'drizzle'`. Memory
   * mode tests must supply `workerFactory` — the memory backend has no
   * polling loop equivalent (`MemoryJobOrchestrator` is direct-invocation
   * only).
   *
   * We instantiate outside the Nest container because the module spawns
   * N workers from a single options shape, which doesn't fit Nest's
   * "one provider per token" model. The dependencies are passed
   * positionally; the constructor's `@Inject` decorators are unused on
   * this path (Nest still uses them when `JobWorker` is a provider — e.g.
   * in JOB-6's standalone `worker.ts` entrypoint).
   */
  private spawnWorker(workerOptions: JobWorkerOptions): JobWorker {
    if (!this.db) {
      throw new Error(
        `JobWorkerModule: in-process worker spawning requires the Drizzle ` +
          `backend (no DRIZZLE provider available). Memory-mode tests must ` +
          `pass 'workerFactory' to inject a stub.`,
      );
    }
    return new JobWorker(
      this.db,
      this.orchestrator,
      this.runService,
      this.stepService,
      workerOptions,
    );
  }
}

@Module({})
export class JobWorkerModule {
  static forRoot(opts: JobWorkerModuleOptions): DynamicModule {
    return {
      module: JobWorkerModule,
      imports: [
        JobsDomainModule.forRoot({
          backend: opts.backend ?? 'drizzle',
          extensions: opts.domainModuleExtensions,
          multiTenant: opts.multiTenant,
        }),
      ],
      providers: [
        { provide: JOB_WORKER_MODULE_OPTIONS, useValue: opts },
        JobWorkerOrchestrator,
      ],
      exports: [],
    };
  }
}
