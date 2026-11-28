/**
 * The bridge's Nest-free entry (J-1): the `bridge_delivery` ledger's schema, the protocols, `jobTriggers(...)`, the
 * errors and the tenant check, the memory delivery repo, and `BridgeOutboxDrainer` (the drain that starts each
 * trigger's run in the event's transaction). A pattern-stack app's `events` system builds the drainer over the `jobs`
 * system's starter. `index.ts` adds the Nest half: the tokens, the Drizzle repo, the drain hook, `EventFlowService`
 * and `BridgeModule`.
 */

// Schema (BRIDGE-1)
export { bridgeDelivery, bridgeDeliveryStatusEnum } from './bridge-delivery.schema';
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
export { jobTriggers, type JobTriggerDeclaration } from './bridge.protocol';

// Errors (BRIDGE-2 + BRIDGE-3 + BRIDGE-8) and the multi-tenancy helper (BRIDGE-8)
export { MissingTenantIdError, UniqueConstraintError } from './bridge-errors';
export { assertTenantId } from './assert-tenant-id';

// The delivery repos, framework-free: memory (BRIDGE-3) and Drizzle (BRIDGE-4; Nest's `DrizzleBridgeDeliveryRepo` is it under tokens)
export { MemoryBridgeDeliveryRepo } from './bridge-delivery.memory-backend';
export { DrizzleBridgeDeliveries } from './bridge-delivery.drizzle-backend';

// The drain (BRIDGE-4, J-1)
export { type BridgeDeliveryLedger, type BridgeJobStarter, BridgeOutboxDrainer } from './bridge-outbox-drainer';
