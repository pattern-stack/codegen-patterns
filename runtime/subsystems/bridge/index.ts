/**
 * Bridge subsystem — public API (ADR-023 Phase 2).
 *
 * The bridge is the formalized seam between events (ADR-024) and jobs
 * (ADR-022). It is owned by neither subsystem; it imports from both.
 *
 * BRIDGE-1 added the schema. BRIDGE-2 adds the protocols, DI tokens, and
 * the typed `MissingTenantIdError`. Backends (memory in BRIDGE-3, Drizzle
 * in BRIDGE-4), the framework `BridgeDeliveryHandler` (BRIDGE-5), the
 * codegen-emitted `bridgeRegistry` (BRIDGE-6), the `EventFlowService`
 * facade (BRIDGE-7), the `BridgeModule.forRoot()` wiring (BRIDGE-8), and
 * the CLI / scaffold / docs (BRIDGE-9) follow.
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
  BridgeReservedPoolsNotPolledError,
} from './bridge-errors';

// Multi-tenancy helper (BRIDGE-8)
export { assertTenantId } from './assert-tenant-id';

// Reserved pools constant (BRIDGE-8) — consumers spread into
// `JobWorkerModule.forRoot({ pools })`.
export {
  BRIDGE_RESERVED_POOLS,
  type BridgeReservedPool,
} from './reserved-pools';

// Memory backend (BRIDGE-3)
export { MemoryBridgeDeliveryRepo } from './bridge-delivery.memory-backend';

// Framework handler (BRIDGE-5)
export {
  BridgeDeliveryHandler,
  BRIDGE_DELIVERY_JOB_TYPE,
  BridgeDeliveryJobType,
  type BridgeDeliveryInput,
} from './bridge-delivery-handler';

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
