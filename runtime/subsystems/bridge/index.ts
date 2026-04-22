/**
 * Bridge subsystem — public API (ADR-023 Phase 2).
 *
 * The bridge is the formalized seam between events (ADR-024) and jobs
 * (ADR-022). It is owned by neither subsystem; it imports from both.
 *
 * BRIDGE-1 ships only the schema. Protocols, DI tokens, backends, the
 * framework handler, the `IEventFlow` facade, and the `BridgeModule` wiring
 * land in subsequent BRIDGE-N issues. The barrel is intentionally minimal at
 * this point; later issues append exports here as they land.
 */
export {
  bridgeDelivery,
  bridgeDeliveryStatusEnum,
} from './bridge-delivery.schema';
export type { BridgeDeliveryRecord } from './bridge-delivery.schema';
