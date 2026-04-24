/**
 * DrizzleBridgeDeliveryRepo — Postgres implementation of `IJobBridge`
 * (BRIDGE-4, ADR-023 Phase 2).
 *
 * Behavioral twin of `MemoryBridgeDeliveryRepo` (BRIDGE-3). The key
 * difference is `insertDelivery`: where the memory backend throws
 * `UniqueConstraintError` on a duplicate `(event_id, trigger_id)`, the
 * Drizzle backend uses `INSERT … ON CONFLICT (event_id, trigger_id) DO
 * NOTHING` and surfaces the dedup as a silent no-op. This matches the
 * BRIDGE-4 spec recommendation — a thrown error inside the per-event tx
 * would abort sibling triggers, which is exactly the failure mode the
 * facade's Case B pre-write was designed to prevent.
 *
 * Tests that need to assert "the constraint fired" use `findDelivery` to
 * confirm the existing row is the facade-eager pre-write (or the prior
 * drain attempt's row), not the one this call tried to insert. The
 * `UniqueConstraintError` branch from BRIDGE-3 is the memory-backend
 * fidelity path; the Drizzle backend models the same idempotency through
 * SQL semantics rather than a thrown error.
 *
 * The other four methods (`findDelivery`, `findDeliveryById`,
 * `mark{Delivered,Skipped,Failed}`) are straightforward
 * `SELECT … LIMIT 1` / `UPDATE … WHERE id = ?` queries.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, and, gte, isNull, sql } from 'drizzle-orm';

import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';
import type { DrizzleTransaction } from '../events/event-bus.protocol';

import { bridgeDelivery } from './bridge-delivery.schema';
import type { BridgeDeliveryRecord } from './bridge-delivery.schema';
import type {
  BridgeDeliveryInsert,
  IJobBridge,
  StatusHistogram,
} from './bridge.protocol';
import { assertTenantId } from './assert-tenant-id';
import { BRIDGE_MULTI_TENANT } from './bridge.tokens';

@Injectable()
export class DrizzleBridgeDeliveryRepo implements IJobBridge {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    /**
     * Site (c) of the three ADR-023 §Multi-tenancy enforcement sites.
     * `@Optional()` so unit tests / non-bridge mounts that don't provide
     * the token still construct the repo cleanly; defaults to `false`,
     * which makes `assertTenantId` a no-op.
     */
    @Optional()
    @Inject(BRIDGE_MULTI_TENANT)
    private readonly multiTenant: boolean = false,
  ) {}

  async insertDelivery(
    row: BridgeDeliveryInsert,
    tx?: DrizzleTransaction,
  ): Promise<void> {
    // Multi-tenancy gate — last-line defense. Even if callers skipped
    // sites (a) `EventFlowService.publishAndStart` and (b)
    // `BridgeDeliveryHandler.run`, a direct repo call still fails fast
    // BEFORE any SQL is issued.
    assertTenantId(
      'DrizzleBridgeDeliveryRepo.insertDelivery',
      this.multiTenant,
      row.tenantId,
    );
    const client = (tx ?? this.db) as DrizzleClient;
    // ON CONFLICT DO NOTHING — surfaces dedup as silent no-op so the
    // per-event tx stays atomic across sibling triggers. RETURNING is
    // omitted here: the public IJobBridge contract is `Promise<void>`,
    // and the drain hook (BRIDGE-4) uses its own
    // `tx.insert(...).onConflictDoNothing().returning({id})` pattern
    // when it needs the rowcount discriminator. See class-level JSDoc.
    await client
      .insert(bridgeDelivery)
      .values(row)
      .onConflictDoNothing({
        target: [bridgeDelivery.eventId, bridgeDelivery.triggerId],
      });
  }

  async findDelivery(
    eventId: string,
    triggerId: string,
  ): Promise<BridgeDeliveryRecord | null> {
    const rows = await this.db
      .select()
      .from(bridgeDelivery)
      .where(
        and(
          eq(bridgeDelivery.eventId, eventId),
          eq(bridgeDelivery.triggerId, triggerId),
        ),
      )
      .limit(1);
    return (rows[0] as BridgeDeliveryRecord | undefined) ?? null;
  }

  async findDeliveryById(id: string): Promise<BridgeDeliveryRecord | null> {
    const rows = await this.db
      .select()
      .from(bridgeDelivery)
      .where(eq(bridgeDelivery.id, id))
      .limit(1);
    return (rows[0] as BridgeDeliveryRecord | undefined) ?? null;
  }

  async markDelivered(
    id: string,
    userRunId: string,
    tx?: DrizzleTransaction,
  ): Promise<void> {
    const client = (tx ?? this.db) as DrizzleClient;
    await client
      .update(bridgeDelivery)
      .set({
        status: 'delivered',
        userRunId,
        deliveredAt: new Date(),
      })
      .where(eq(bridgeDelivery.id, id));
  }

  async markSkipped(
    id: string,
    reason: string,
    tx?: DrizzleTransaction,
  ): Promise<void> {
    const client = (tx ?? this.db) as DrizzleClient;
    await client
      .update(bridgeDelivery)
      .set({ status: 'skipped', skipReason: reason })
      .where(eq(bridgeDelivery.id, id));
  }

  async markFailed(
    id: string,
    error: Record<string, unknown>,
    tx?: DrizzleTransaction,
  ): Promise<void> {
    const client = (tx ?? this.db) as DrizzleClient;
    await client
      .update(bridgeDelivery)
      .set({ status: 'failed', error })
      .where(eq(bridgeDelivery.id, id));
  }

  /**
   * Observability read — see `IJobBridge.getStatusHistogram` JSDoc for the
   * tenant-filter and windowHours contract.
   *
   * Tenant-filter note: this method intentionally does NOT call
   * `assertTenantId`. The write methods on this repo (`insertDelivery`)
   * treat `tenantId === undefined` as a misconfiguration and fail fast.
   * Reads are different — `undefined` is the supported "cross-tenant
   * admin view" mode that OBS-5 uses to render a framework-wide health
   * panel. Callers that need strict tenant scoping pass an explicit
   * string or `null`.
   *
   * Cast note: `count(*)::int` is applied in SQL so the node-pg driver
   * returns a `number` instead of the default `bigint → string` for
   * `count(*)`. Don't relax this cast — consumers (and the protocol)
   * type the result as `number`.
   */
  async getStatusHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram> {
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      throw new RangeError('windowHours must be positive');
    }

    const cutoff = sql<Date>`now() - make_interval(hours => ${windowHours})`;

    const conditions = [gte(bridgeDelivery.attemptedAt, cutoff)];
    if (tenantId === null) {
      conditions.push(isNull(bridgeDelivery.tenantId));
    } else if (typeof tenantId === 'string') {
      conditions.push(eq(bridgeDelivery.tenantId, tenantId));
    }
    // tenantId === undefined → no tenant filter (cross-tenant view).

    const rows = await this.db
      .select({
        status: bridgeDelivery.status,
        count: sql<number>`count(*)::int`,
      })
      .from(bridgeDelivery)
      .where(and(...conditions))
      .groupBy(bridgeDelivery.status);

    const histogram: StatusHistogram = {
      pending: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
    };
    for (const row of rows) {
      // row.status is typed as the enum union; narrow is safe because the
      // enum values match StatusHistogram keys 1:1 (BRIDGE-1 schema).
      histogram[row.status as keyof StatusHistogram] = Number(row.count);
    }
    return histogram;
  }
}
