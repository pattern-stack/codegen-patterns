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
import { ModuleRef } from '@nestjs/core';
import { tokenKey } from '../token-key';
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
  allPoolNames,
  loadPoolConfig,
  type PoolConfig,
} from './pool-config.loader';
import { JobWorker, type JobWorkerOptions } from './job-worker';
// #6 — `BullMQJobWorker` is lazy-loaded only when `backend: 'bullmq'` is
// selected (`spawnBullMQWorker` below). The file is filtered out of drizzle/
// memory installs (see `backendFileFilter`). The `ConnectionOptions` type
// previously imported from `'bullmq'` is replaced by `BullMqConnectionOptions`
// from `./bullmq.config` (a self-contained structural mirror that does NOT
// require the `bullmq` peer dep to type-check).
import {
  BULLMQ_CONNECTION,
  BULLMQ_RESOLVED_CONFIG,
  resolvePoolQueueName,
  type BullMqConnectionOptions,
  type BullMqResolvedConfig,
} from './bullmq.config';
import {
  BootValidationError,
  ReservedPoolViolationError,
} from './jobs-errors';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface JobWorkerModuleOptions {
  mode: 'embedded' | 'standalone';
  /**
   * Threads into the internal `JobsDomainModule.forRoot({ backend })`
   * import. Default `'drizzle'`. The boot-time validator runs for both
   * `'drizzle'` and `'bullmq'` (both persist `job` rows to Postgres);
   * `'memory'` skips it.
   */
  backend?: 'drizzle' | 'memory' | 'bullmq';
  /**
   * Active pool names. Defaults to every non-reserved pool in the resolved
   * config (i.e. `interactive`, `batch`, plus any user-defined pools).
   * Operators reduce this to one or two pools per worker process to scale
   * horizontally.
   */
  pools?: string[];
  /**
   * BULLMQ-1 Phase 1 — when `true`, `onModuleInit` activates **every** pool
   * in the resolved config, including the reserved `events_*` lanes. This is
   * how the standalone worker (`worker.ts`) drains bridge wrappers without
   * the consumer hand-listing `...BRIDGE_RESERVED_POOLS`. Mutually exclusive
   * with an explicit `pools` list — when both are set, `pools` wins (explicit
   * beats blanket) and `allPools` is ignored.
   *
   * `BridgeModule`'s reserved-pool guard short-circuits to "pass" when this
   * is `true`, since every reserved pool is provably being polled.
   */
  allPools?: boolean;
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
 *
 * ADR-037: namespaced `Symbol.for(...)` (via `tokenKey()`) — matches by value
 * across runtime copies.
 */
export const JOB_WORKER_MODULE_OPTIONS = Symbol.for(tokenKey('jobs', 'worker-module-options'));

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
    /**
     * ADR-037 (package-mode DI): inject `ModuleRef` EXPLICITLY via `@Inject`
     * rather than relying on `design:paramtypes` reflection. The published
     * package bundle is built without `emitDecoratorMetadata` (tsup/esbuild
     * default), so a by-type injection here would resolve to `undefined` at
     * boot in package mode — breaking the worker entirely (the
     * `ModuleRef not available` throw). Vendored mode happened to work only
     * because the consumer's own `tsc` (emitDecoratorMetadata: true)
     * recompiled the source and emitted the metadata. The explicit token is
     * mode-agnostic. `ModuleRef` is always provided by `@nestjs/core`, so no
     * `@Optional()` is needed (it's a hard dependency of the worker path).
     */
    @Inject(ModuleRef) private readonly moduleRef?: ModuleRef,
    /**
     * BULLMQ-1 — resolved BullMQ connection + config, only bound when the
     * inner `JobsDomainModule` was booted with `backend: 'bullmq'`. `@Optional()`
     * so drizzle/memory boots see `null`.
     */
    @Optional()
    @Inject(BULLMQ_CONNECTION)
    private readonly bullConnection: BullMqConnectionOptions | null = null,
    @Optional()
    @Inject(BULLMQ_RESOLVED_CONFIG)
    private readonly bullConfig: BullMqResolvedConfig | null = null,
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
    //     Precedence: explicit `pools` > `allPools` (incl. reserved) >
    //     non-reserved default. BULLMQ-1 Phase 1 adds the `allPools` rung so
    //     the standalone worker drains the reserved `events_*` bridge lanes.
    const activePools = this.options.pools
      ? this.options.pools
      : this.options.allPools
        ? allPoolNames(poolConfig)
        : allNonReservedPoolNames(poolConfig);

    for (const poolName of activePools) {
      const def = poolConfig.get(poolName);
      if (!def) {
        throw new Error(
          `JobWorkerModule: active pool '${poolName}' is not defined in ` +
            `the resolved pool config. Configured pools: [${[...poolConfig.keys()].join(', ')}].`,
        );
      }
      // `pool` here is the logical pool name (e.g. 'crm_sync') — the same
      // value the orchestrator persists into `job_run.pool` from
      // `@JobHandler.meta.pool`, and therefore the value the worker's
      // claim query filters on. `def.queue` is a display/routing alias
      // (e.g. 'jobs-crm-sync') used by BullMQ-style backends for queue
      // naming; it MUST NOT be passed as the claim-filter pool, or the
      // worker will never match any row and the pool silently never
      // drains. See v0.4.4 fix notes.
      // LISTEN-NOTIFY-1 — thread the drizzle extension knobs into each spawned
      // worker. `pollIntervalMs` was always honored by JobWorker but never
      // received a config value; `listenNotify` is the new wake opt-in. Only
      // the drizzle backend reads these (bullmq has native wakeups + its own
      // queue topology), so we ignore them under `backend: 'bullmq'`.
      const drizzleExt =
        backend === 'drizzle'
          ? this.options.domainModuleExtensions?.drizzle
          : undefined;
      const workerOptions: JobWorkerOptions = {
        pool: poolName,
        concurrency: def.concurrency,
        shutdownTimeoutMs:
          this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        pollIntervalMs: drizzleExt?.pollIntervalMs,
        listenNotify: drizzleExt?.listenNotify,
        // CLAIM-HB-1 — lease tuning knobs. All optional; the worker defaults
        // claimHeartbeatIntervalMs to staleThresholdMs/3 when omitted.
        staleSweeperIntervalMs: drizzleExt?.staleSweeperIntervalMs,
        staleThresholdMs: drizzleExt?.staleThresholdMs,
        claimHeartbeatIntervalMs: drizzleExt?.claimHeartbeatIntervalMs,
      };
      const worker = this.options.workerFactory
        ? this.options.workerFactory(workerOptions)
        : backend === 'bullmq'
          ? await this.spawnBullMQWorker(poolName, def.queue, def.concurrency, poolConfig)
          : this.spawnWorker(workerOptions);
      // `JobWorker` extends Nest's lifecycle hooks but the worker isn't
      // a Nest provider here (we manage the array ourselves). Call
      // `onModuleInit` to start the loop. The Drizzle/stub workers return
      // void; `BullMQJobWorker.onModuleInit` is async (it lazily loads the
      // optional `bullmq` package), so we `await` — awaiting a `void` is a
      // harmless no-op for the synchronous workers.
      await worker.onModuleInit();
      this.workers.push(worker);
      this.logger.log(
        `JobWorker started: pool='${poolName}' (queue='${def.queue}') ` +
          `concurrency=${def.concurrency} backend='${backend}'`,
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

    // BULLMQ-1 — close the orchestrator's producer-side Queue/FlowProducer
    // connections so the process can exit cleanly. The orchestrator is the
    // BullMQ producer; workers are the consumers (closed above).
    const orch = this.orchestrator as { closeConnections?: () => Promise<void> };
    if (typeof orch.closeConnections === 'function') {
      try {
        await orch.closeConnections();
      } catch (err) {
        this.logger.error(
          `BullMQ orchestrator connection close failed: ${(err as Error).message}`,
        );
      }
    }
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
    if (!this.moduleRef) {
      throw new Error(
        `JobWorkerModule: ModuleRef not available — cannot construct JobWorker ` +
          `with handler DI support. Ensure the orchestrator is resolved through ` +
          `the Nest container (not instantiated manually in tests).`,
      );
    }
    return new JobWorker(
      this.db,
      this.orchestrator,
      this.runService,
      this.stepService,
      workerOptions,
      this.moduleRef,
    );
  }

  /**
   * BULLMQ-1 — spawn a per-pool `BullMQJobWorker`. Requires the Drizzle
   * client (the worker drives `job_run` as the source of truth) AND the
   * resolved BullMQ connection (bound by `JobsDomainModule` when
   * `backend: 'bullmq'`). The queue name is derived identically to the
   * orchestrator's `dispatch` via `resolvePoolQueueName(pool, …)` so producer
   * and consumer agree.
   */
  /**
   * #6 — async + dynamic-import. The `job-worker.bullmq-backend.ts` file is
   * filtered out of the vendor set for drizzle/memory installs (no `bullmq`
   * peer dep needed). The non-literal import specifier makes TS treat the
   * module as `any` so the consumer's tsc never tries to resolve an absent
   * file. This method is only entered when `backend === 'bullmq'` — at which
   * point the file IS vendored.
   */
  private async spawnBullMQWorker(
    pool: string,
    _queueAlias: string,
    concurrency: number,
    poolConfig: PoolConfig,
  ): Promise<Pick<JobWorker, 'onModuleInit' | 'onModuleDestroy'>> {
    if (!this.db) {
      throw new Error(
        `JobWorkerModule: BullMQ worker spawning requires the Drizzle client ` +
          `(no DRIZZLE provider available) — job_run remains the source of truth.`,
      );
    }
    if (!this.bullConnection) {
      throw new Error(
        `JobWorkerModule: BullMQ worker spawning requires a resolved ` +
          `BULLMQ_CONNECTION. Ensure JobsDomainModule was booted with ` +
          `backend: 'bullmq'.`,
      );
    }
    if (!this.moduleRef) {
      throw new Error(
        `JobWorkerModule: ModuleRef not available — cannot construct ` +
          `BullMQJobWorker with handler DI support.`,
      );
    }
    const queueName = resolvePoolQueueName(pool, this.bullConfig, poolConfig);
    const specifier = './job-worker.bullmq-backend';
    const mod = (await import(specifier)) as {
      BullMQJobWorker: new (...args: unknown[]) => Pick<
        JobWorker,
        'onModuleInit' | 'onModuleDestroy'
      >;
    };
    return new mod.BullMQJobWorker(
      this.db,
      this.orchestrator,
      this.stepService,
      {
        pool,
        queueName,
        concurrency,
        connection: this.bullConnection,
      },
      this.moduleRef,
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
      // BULLMQ-1 Phase 1 — export the options token so `BridgeModule`'s
      // reserved-pool guard (`onModuleInit`) can actually inject it.
      // Previously `exports: []` left the `@Optional()` inject resolving to
      // `undefined` and the guard silently no-opped (a dead check). With the
      // token exported the guard fires for real; consumers that omit the
      // reserved pools (and don't set `allPools`) now fail fast with
      // `BridgeReservedPoolsNotPolledError` — which is correct.
      exports: [JOB_WORKER_MODULE_OPTIONS],
    };
  }
}
