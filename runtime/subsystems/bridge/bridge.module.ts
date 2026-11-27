/**
 * BridgeModule — the event → job bridge (ADR-023, JOBS-3).
 *
 * Wires the delivery ledger (`bridge_delivery`, a memory or Drizzle repo), the generated `bridgeRegistry`, the outbox
 * drain hook (which starts each trigger's run with `JobStarter` in the event's own transaction) and the `IEventFlow`
 * facade (`publish`, `publishAndStart`). Global, so the events outbox drain and app code see its tokens. It needs the
 * jobs subsystem (`JobsEngineModule`, which provides `JobStarter`) and the events subsystem.
 *
 * ```ts
 * imports: [
 *   EventsModule.forRoot({ backend: 'drizzle' }),
 *   JobsEngineModule.forRoot({ definitions: jobDefinitions, worker: true }),
 *   BridgeModule.forRoot({ backend: 'drizzle' }),
 * ]
 * ```
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import {
  BRIDGE_DELIVERY_REPO,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_MULTI_TENANT,
  BRIDGE_OUTBOX_DRAIN_HOOK,
  BRIDGE_REGISTRY,
  EVENT_FLOW,
} from './bridge.tokens';
import { MemoryBridgeDeliveryRepo } from './bridge-delivery.memory-backend';
import { DrizzleBridgeDeliveryRepo } from './bridge-delivery.drizzle-backend';
import { BridgeOutboxDrainHook } from './bridge-outbox-drain-hook';
import { EventFlowService } from './event-flow.service';
import { bridgeRegistry } from './generated/registry';
import type { BridgeRegistry } from './bridge.protocol';

export interface BridgeModuleOptions {
  /**
   * `'memory'` for unit tests (no Postgres), `'drizzle'` for production.
   * Switches `BRIDGE_DELIVERY_REPO` between
   * `MemoryBridgeDeliveryRepo` and `DrizzleBridgeDeliveryRepo`.
   */
  backend: 'memory' | 'drizzle';
  /**
   * Multi-tenancy opt-in. When `true`, the enforcement sites
   * (`EventFlowService.publishAndStart`,
   * `DrizzleBridgeDeliveryRepo.insertDelivery`) throw
   * `MissingTenantIdError` when `tenantId === undefined`. Explicit
   * `null` always passes (cross-tenant work). Defaults to `false`.
   */
  multiTenant?: boolean;
  /**
   * The codegen-emitted `Record<EventTypeName, BridgeTriggerEntry[]>` that
   * drives outbox-drain trigger lookup (BRIDGE-4) and the facade's Case B
   * dedup (BRIDGE-7).
   *
   * **Package mode (ADR-037).** When the runtime is imported from
   * `@pattern-stack/codegen` (not vendored), the bundled
   * `./generated/registry` is a frozen empty placeholder (`{}`) — a
   * consumer's `jobTriggers(...)` declarations are scanned into a registry that lives
   * in THEIR `src/generated/bridge-registry.ts`, which the package can't
   * import. The generated subsystem barrel therefore threads that registry in
   * here: `BridgeModule.forRoot({ ..., registry: bridgeRegistry })`. Omitted
   * (vendored mode / tests) ⇒ falls back to the bundled `./generated/registry`,
   * which in vendored mode IS the consumer's freshly-generated file.
   *
   * Without this, package-mode consumers' triggers never bind and the bridge
   * routes nothing.
   */
  registry?: BridgeRegistry;
}

/** The delivery repo per backend: one row each, so a new backend is a compile error here until it has one. */
const DELIVERY_REPOS: Record<NonNullable<BridgeModuleOptions['backend']>, Provider> = {
  // Framework-free (a plain host builds it too), so Nest builds it with the multi-tenant flag by hand.
  memory: {
    provide: BRIDGE_DELIVERY_REPO,
    useFactory: (multiTenant: boolean) => new MemoryBridgeDeliveryRepo(multiTenant),
    inject: [BRIDGE_MULTI_TENANT],
  },
  drizzle: { provide: BRIDGE_DELIVERY_REPO, useClass: DrizzleBridgeDeliveryRepo },
};

@Module({})
export class BridgeModule {
  static forRoot(opts: BridgeModuleOptions): DynamicModule {
    const repoProvider = DELIVERY_REPOS[opts.backend ?? 'drizzle'];

    return {
      module: BridgeModule,
      global: true,
      // BridgeModule consumes EVENT_BUS / JobStarter / DRIZZLE from sibling
      // subsystems via DI (JobsEngineModule is global); no `imports` needed
      // here. The consumer wires EventsModule + JobsEngineModule BEFORE
      // BridgeModule.
      providers: [
        { provide: BRIDGE_MODULE_OPTIONS, useValue: opts },
        { provide: BRIDGE_MULTI_TENANT, useValue: opts.multiTenant ?? false },
        // Package mode threads the consumer's generated registry through
        // `opts.registry`; vendored mode omits it and we fall back to the
        // bundled `./generated/registry` (which IS the consumer's generated
        // file in a vendored tree). See `BridgeModuleOptions.registry`.
        { provide: BRIDGE_REGISTRY, useValue: opts.registry ?? bridgeRegistry },
        repoProvider,
        // Drain hook — always wired; `DrizzleEventBus` consumes it via
        // `@Optional()`, so non-bridge mounts simply see `undefined`.
        { provide: BRIDGE_OUTBOX_DRAIN_HOOK, useClass: BridgeOutboxDrainHook },
        // Facade — class provider + token alias.
        EventFlowService,
        { provide: EVENT_FLOW, useExisting: EventFlowService },
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
}
