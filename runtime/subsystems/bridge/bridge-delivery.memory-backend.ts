/**
 * MemoryBridgeDeliveryRepo — in-memory `IJobBridge` (BRIDGE-3, ADR-023 Phase 2).
 *
 * Behavioral twin of the Drizzle backend (BRIDGE-4) for use in
 * `just test-unit`. No Docker, no Postgres, fully synchronous. Backs a
 * `Map<"${eventId}::${triggerId}", BridgeDeliveryRecord>` so the UNIQUE
 * `(event_id, trigger_id)` constraint can be simulated cheaply.
 *
 * Precedent: `MemoryEventBus` (EVT-5), `MemoryJobOrchestrator`
 * (jobs subsystem). Same shape — a class implementing the protocol plus
 * test-only helpers (`getDeliveriesForEvent`, `getByStatus`, `clear`) that
 * BRIDGE-5's framework-handler tests and BRIDGE-7's facade tests will
 * exercise.
 *
 * The synthetic `UniqueConstraintError` carries a `constraint` field equal
 * to the Drizzle constraint name (`uq_bridge_delivery_event_trigger`, set
 * in BRIDGE-1's schema) so consumers — including BRIDGE-4's
 * `INSERT … ON CONFLICT (event_id, trigger_id) DO NOTHING` path and
 * BRIDGE-7's Case B dedup tests — can branch on the same discriminator
 * regardless of which backend is wired up. ADR-023 explicitly relies on
 * this constraint as the dedup mechanism in two places (replay; facade-
 * vs-drain Case B); a typed error makes both call sites checkable.
 */
import { randomUUID } from 'node:crypto';

import type {
  BridgeDeliveryInsert,
  IJobBridge,
  StatusHistogram,
} from './bridge.protocol';
import type { BridgeDeliveryRecord } from './bridge-delivery.schema';
import { UniqueConstraintError } from './bridge-errors';

const BRIDGE_DELIVERY_UNIQUE_CONSTRAINT =
  'uq_bridge_delivery_event_trigger' as const;

function key(eventId: string, triggerId: string): string {
  return `${eventId}::${triggerId}`;
}

export class MemoryBridgeDeliveryRepo implements IJobBridge {
  private readonly deliveries = new Map<string, BridgeDeliveryRecord>();

  async insertDelivery(row: BridgeDeliveryInsert): Promise<void> {
    const k = key(row.eventId, row.triggerId);
    if (this.deliveries.has(k)) {
      throw new UniqueConstraintError(
        BRIDGE_DELIVERY_UNIQUE_CONSTRAINT,
        row.eventId,
        row.triggerId,
      );
    }
    // Materialize a full BridgeDeliveryRecord — fill in DB defaults that
    // the insert payload allowed to be omitted.
    const record: BridgeDeliveryRecord = {
      id: row.id ?? randomUUID(),
      eventId: row.eventId,
      triggerId: row.triggerId,
      wrapperRunId: row.wrapperRunId ?? null,
      userRunId: row.userRunId ?? null,
      status: row.status ?? 'pending',
      skipReason: row.skipReason ?? null,
      error: (row.error as Record<string, unknown> | null | undefined) ?? null,
      tenantId: row.tenantId ?? null,
      attemptedAt:
        row.attemptedAt instanceof Date ? row.attemptedAt : new Date(),
      deliveredAt:
        row.deliveredAt instanceof Date ? row.deliveredAt : null,
    };
    this.deliveries.set(k, record);
  }

  async findDelivery(
    eventId: string,
    triggerId: string,
  ): Promise<BridgeDeliveryRecord | null> {
    return this.deliveries.get(key(eventId, triggerId)) ?? null;
  }

  async findDeliveryById(id: string): Promise<BridgeDeliveryRecord | null> {
    for (const record of this.deliveries.values()) {
      if (record.id === id) return record;
    }
    return null;
  }

  async markDelivered(id: string, userRunId: string): Promise<void> {
    const record = this.findById(id);
    record.status = 'delivered';
    record.userRunId = userRunId;
    record.deliveredAt = new Date();
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    const record = this.findById(id);
    record.status = 'skipped';
    record.skipReason = reason;
  }

  async markFailed(
    id: string,
    error: Record<string, unknown>,
  ): Promise<void> {
    const record = this.findById(id);
    record.status = 'failed';
    record.error = error;
  }

  /**
   * Observability read — see `IJobBridge.getStatusHistogram` JSDoc for the
   * tenant-filter and windowHours contract.
   *
   * Unlike `insertDelivery`, this read does NOT call `assertTenantId`:
   * `tenantId === undefined` is the supported cross-tenant admin view.
   */
  async getStatusHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram> {
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      throw new RangeError('windowHours must be positive');
    }

    const cutoffMs = Date.now() - windowHours * 3_600_000;
    const histogram: StatusHistogram = {
      pending: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
    };

    for (const record of this.deliveries.values()) {
      if (record.attemptedAt.getTime() < cutoffMs) continue;
      if (tenantId === null && record.tenantId !== null) continue;
      if (typeof tenantId === 'string' && record.tenantId !== tenantId) {
        continue;
      }
      // tenantId === undefined → no tenant filter.
      histogram[record.status] += 1;
    }

    return histogram;
  }

  // ─── Test helpers ────────────────────────────────────────────────────────

  /** All deliveries for a given event (any status, declaration order). */
  getDeliveriesForEvent(eventId: string): BridgeDeliveryRecord[] {
    return [...this.deliveries.values()].filter((r) => r.eventId === eventId);
  }

  /** All deliveries currently in the given status. */
  getByStatus(
    status: BridgeDeliveryRecord['status'],
  ): BridgeDeliveryRecord[] {
    return [...this.deliveries.values()].filter((r) => r.status === status);
  }

  /** Reset the store. Tests use this in `beforeEach`. */
  clear(): void {
    this.deliveries.clear();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private findById(id: string): BridgeDeliveryRecord {
    for (const record of this.deliveries.values()) {
      if (record.id === id) return record;
    }
    throw new Error(
      `MemoryBridgeDeliveryRepo: no delivery with id '${id}' (transition ` +
        `methods may not be called for unknown rows; the framework handler ` +
        `should always findDelivery first or operate on a row it just ` +
        `inserted).`,
    );
  }
}
