/**
 * Bridge subsystem — public API (ADR-023 Phase 2).
 *
 * The bridge is the formalized seam between events (ADR-024) and jobs (`@pattern-stack/jobs`, JOBS-3). It is owned by
 * neither subsystem; it imports from both. The Nest-free half is `./core` (J-1): the ledger's schema, the protocols,
 * `jobTriggers(...)`, the errors, the memory repo and the drain. This entry adds the Nest host: the DI tokens, the
 * Drizzle delivery repo, the outbox drain hook (the drain over `JobStarter`), the `EventFlowService` facade and
 * `BridgeModule.forRoot()`.
 */
export * from './core';

// DI tokens (BRIDGE-2 + BRIDGE-4 drain hook)
export {
  BRIDGE_DELIVERY_REPO,
  EVENT_FLOW,
  BRIDGE_MULTI_TENANT,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_REGISTRY,
  BRIDGE_OUTBOX_DRAIN_HOOK,
} from './bridge.tokens';

// Drizzle backend + outbox-drain hook (BRIDGE-4)
export { DrizzleBridgeDeliveryRepo } from './bridge-delivery.drizzle-repo';
export { BridgeOutboxDrainHook } from './bridge-outbox-drain-hook';

// EventFlow facade (BRIDGE-7)
export { EventFlowService } from './event-flow.service';

// Module wiring (BRIDGE-8)
export { BridgeModule, type BridgeModuleOptions } from './bridge.module';
