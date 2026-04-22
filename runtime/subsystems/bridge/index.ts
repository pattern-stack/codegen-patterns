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

// Protocols (BRIDGE-2)
export type {
  IJobBridge,
  IEventFlow,
  BridgeDeliveryInsert,
  PublishAndStartOptions,
  PublishAndStartResult,
} from './bridge.protocol';

// DI tokens (BRIDGE-2)
export {
  BRIDGE_DELIVERY_REPO,
  EVENT_FLOW,
  BRIDGE_MULTI_TENANT,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_REGISTRY,
} from './bridge.tokens';

// Errors (BRIDGE-2 + BRIDGE-3)
export {
  MissingTenantIdError,
  UniqueConstraintError,
} from './bridge-errors';

// Memory backend (BRIDGE-3)
export { MemoryBridgeDeliveryRepo } from './bridge-delivery.memory-backend';
