/**
 * BridgeModule — `DynamicModule.forRoot({ backend, multiTenant })`
 * factory that wires the entire bridge subsystem (BRIDGE-8, ADR-023
 * Phase 2).
 *
 * The bridge is the formalized seam between events (ADR-024) and jobs
 * (ADR-022). It is owned by neither subsystem and consumes their tokens
 * via DI. `BridgeModule` is the *combiner* — neither `EventsModule` nor
 * `JobsDomainModule` know about it.
 *
 * Consumer wiring (must be imported AFTER `EventsModule`,
 * `JobsDomainModule`, and `JobWorkerModule`):
 * ```ts
 * @Module({
 *   imports: [
 *     EventsModule.forRoot({ backend: 'drizzle' }),
 *     JobWorkerModule.forRoot({
 *       mode: 'embedded',
 *       backend: 'drizzle',
 *       pools: ['interactive', 'batch', ...BRIDGE_RESERVED_POOLS],
 *     }),
 *     BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * Boot-time check: `onModuleInit` inspects `JobWorkerModule`'s active
 * pools and throws `BridgeReservedPoolsNotPolledError` when any of the
 * three reserved bridge pools isn't being polled. Converts the
 * "wrappers sit pending forever" footgun into a fail-fast.
 *
 * Handler registration: ONE `@JobHandler('@framework/bridge_delivery',
 * ...)` decorator on `BridgeDeliveryHandler` auto-registers it in
 * `JOB_HANDLER_REGISTRY` at module-load time. We declare the class as a
 * Nest provider here so DI resolves its constructor deps; per-direction
 * routing happens via `job_run.pool='events_<direction>'` set by
 * `BridgeOutboxDrainHook` (BRIDGE-4) — workers polling each reserved
 * pool independently claim wrappers from their own pool and dispatch to
 * the same handler class. The reserved-pool validator exemption
 * (BRIDGE-5) lets the framework handler legitimately target a reserved
 * pool.
 */
import {
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';

import {
  JOB_WORKER_MODULE_OPTIONS,
  type JobWorkerModuleOptions,
} from '../jobs/job-worker.module';

import {
  BRIDGE_DELIVERY_REPO,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_MULTI_TENANT,
  BRIDGE_OUTBOX_DRAIN_HOOK,
  BRIDGE_REGISTRY,
  EVENT_FLOW,
} from './bridge.tokens';
import { BridgeReservedPoolsNotPolledError } from './bridge-errors';
import { MemoryBridgeDeliveryRepo } from './bridge-delivery.memory-backend';
import { DrizzleBridgeDeliveryRepo } from './bridge-delivery.drizzle-backend';
import { BridgeOutboxDrainHook } from './bridge-outbox-drain-hook';
import { EventFlowService } from './event-flow.service';
import { BridgeDeliveryHandler } from './bridge-delivery-handler';
import { bridgeRegistry } from './generated/registry';
import { BRIDGE_RESERVED_POOLS } from './reserved-pools';

export interface BridgeModuleOptions {
  /**
   * `'memory'` for unit tests (no Postgres), `'drizzle'` for production.
   * Switches `BRIDGE_DELIVERY_REPO` between
   * `MemoryBridgeDeliveryRepo` and `DrizzleBridgeDeliveryRepo`.
   */
  backend: 'memory' | 'drizzle';
  /**
   * Multi-tenancy opt-in. When `true`, the three enforcement sites
   * (`EventFlowService.publishAndStart`, `BridgeDeliveryHandler.run`,
   * `DrizzleBridgeDeliveryRepo.insertDelivery`) throw
   * `MissingTenantIdError` when `tenantId === undefined`. Explicit
   * `null` always passes (cross-tenant work). Defaults to `false`.
   */
  multiTenant?: boolean;
}

@Module({})
export class BridgeModule implements OnModuleInit {
  static forRoot(opts: BridgeModuleOptions): DynamicModule {
    const repoProvider: Provider =
      opts.backend === 'memory'
        ? { provide: BRIDGE_DELIVERY_REPO, useClass: MemoryBridgeDeliveryRepo }
        : { provide: BRIDGE_DELIVERY_REPO, useClass: DrizzleBridgeDeliveryRepo };

    return {
      module: BridgeModule,
      global: true,
      // BridgeModule consumes EVENT_BUS / JOB_ORCHESTRATOR / DRIZZLE
      // from sibling subsystems via DI; no `imports` needed here. The
      // consumer is responsible for wiring EventsModule + JobsDomainModule
      // (or JobWorkerModule, which transitively imports the latter)
      // BEFORE BridgeModule.
      providers: [
        { provide: BRIDGE_MODULE_OPTIONS, useValue: opts },
        { provide: BRIDGE_MULTI_TENANT, useValue: opts.multiTenant ?? false },
        { provide: BRIDGE_REGISTRY, useValue: bridgeRegistry },
        repoProvider,
        // Drain hook — always wired; `DrizzleEventBus` consumes it via
        // `@Optional()`, so non-bridge mounts simply see `undefined`.
        { provide: BRIDGE_OUTBOX_DRAIN_HOOK, useClass: BridgeOutboxDrainHook },
        // Facade — class provider + token alias.
        EventFlowService,
        { provide: EVENT_FLOW, useExisting: EventFlowService },
        // Framework handler — provider so DI can construct it. The
        // `@JobHandler` decorator already auto-registers it in
        // `JOB_HANDLER_REGISTRY` at module-load time, and its `jobs`
        // row is upserted at `JobWorkerModule.onModuleInit`. We just
        // need the class instantiated as a Nest provider so its DI
        // deps (BRIDGE_DELIVERY_REPO, JOB_ORCHESTRATOR, EVENT_BUS,
        // BRIDGE_REGISTRY, BRIDGE_MULTI_TENANT) resolve.
        BridgeDeliveryHandler,
      ],
      exports: [
        EVENT_FLOW,
        BRIDGE_DELIVERY_REPO,
        BRIDGE_REGISTRY,
        BRIDGE_MULTI_TENANT,
        BRIDGE_MODULE_OPTIONS,
        BRIDGE_OUTBOX_DRAIN_HOOK,
      ],
    };
  }

  /**
   * `JOB_WORKER_MODULE_OPTIONS` is declared `@Optional()` so unit tests
   * that mount `BridgeModule` alone (no `JobWorkerModule`) boot
   * cleanly — the boot-time check skips when the token is undefined.
   */
  constructor(
    @Optional()
    @Inject(JOB_WORKER_MODULE_OPTIONS)
    private readonly workerOpts?: JobWorkerModuleOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.workerOpts) return;
    const activePools = this.workerOpts.pools ?? [];
    const missing = BRIDGE_RESERVED_POOLS.filter(
      (p) => !activePools.includes(p),
    );
    if (missing.length > 0) {
      throw new BridgeReservedPoolsNotPolledError(missing);
    }
  }
}
