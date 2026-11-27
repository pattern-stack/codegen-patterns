/**
 * Bridge subsystem — public API (ADR-023 Phase 2).
 *
 * The bridge is the formalized seam between events (ADR-024) and jobs
 * (`@pattern-stack/jobs`, JOBS-3). It is owned by neither subsystem; it
 * imports from both.
 *
 * The `bridge_delivery` ledger (schema, memory and Drizzle repos), the
 * protocols and tokens, `MissingTenantIdError`, the outbox drain hook (which
 * starts each trigger's run with `JobStarter` in the event's transaction),
 * the codegen-emitted `bridgeRegistry` and `jobTriggers(...)`, the
 * `EventFlowService` facade and `BridgeModule.forRoot()`.
 */

// Schema (BRIDGE-1)
export {
  bridgeDelivery,
  bridgeDeliveryStatusEnum,
} from './bridge-delivery.schema';
export type { BridgeDeliveryRecord } from './bridge-delivery.schema';

// Protocols (BRIDGE-2 + BRIDGE-5 registry + BRIDGE-4 drain hook)
export type {
  IJobBridge,
  IEventFlow,
  IBridgeOutboxDrainHook,
  BridgeDeliveryInsert,
  BridgeOutboxDrainResult,
  BridgeRegistry,
  BridgeTriggerEntry,
  PublishAndStartOptions,
  PublishAndStartResult,
  StatusHistogram,
} from './bridge.protocol';

// DI tokens (BRIDGE-2 + BRIDGE-4 drain hook)
export {
  BRIDGE_DELIVERY_REPO,
  EVENT_FLOW,
  BRIDGE_MULTI_TENANT,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_REGISTRY,
  BRIDGE_OUTBOX_DRAIN_HOOK,
} from './bridge.tokens';

// Errors (BRIDGE-2 + BRIDGE-3 + BRIDGE-8)
export {
  MissingTenantIdError,
  UniqueConstraintError,
} from './bridge-errors';

// Multi-tenancy helper (BRIDGE-8)
export { assertTenantId } from './assert-tenant-id';
export { jobTriggers, type JobTriggerDeclaration } from './bridge.protocol';

// Memory backend (BRIDGE-3)
export { MemoryBridgeDeliveryRepo } from './bridge-delivery.memory-backend';

// Framework handler (BRIDGE-5)

// Drizzle backend + outbox-drain hook (BRIDGE-4)
export { DrizzleBridgeDeliveryRepo } from './bridge-delivery.drizzle-backend';
export { BridgeOutboxDrainHook } from './bridge-outbox-drain-hook';

// EventFlow facade (BRIDGE-7)
export { EventFlowService } from './event-flow.service';

// Module wiring (BRIDGE-8)
export {
  BridgeModule,
  type BridgeModuleOptions,
} from './bridge.module';
