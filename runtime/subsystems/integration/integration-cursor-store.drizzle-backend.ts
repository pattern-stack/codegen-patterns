/**
 * PostgresCursorStore — Drizzle-backed `ICursorStore` (SYNC-4).
 *
 * Reads/writes `integration_subscriptions.cursor` directly — no service
 * composition. Consumers that want a service layer around subscriptions
 * wire it themselves; the port's contract is just cursor persistence.
 *
 * ## What `put` stamps
 *
 * `put` writes three columns in one statement: `cursor`, `last_integration_at`,
 * and `updated_at`. Rationale: SYNC-1's scheduling index
 * `(enabled, last_integration_at)` is useless if `last_integration_at` doesn't advance
 * with every cursor put. Every real consumer needs this stamped, so
 * bundling it here avoids every consumer wrapping the port in a service
 * layer just to stamp a timestamp.
 *
 * ## Multi-tenancy
 *
 * When `INTEGRATION_MULTI_TENANT` is true (SYNC-6):
 *   - every read/write is scoped by `AND tenant_id = $tenantId`
 *   - a null/missing `tenantId` throws `MissingTenantIdError` via the
 *     shared `assertTenantId` helper (one message shape across the
 *     orchestrator + both backends, SYNC-6)
 *   - explicit `null` also throws — matches JOB-8 / EVT-6 strict-enforcement
 *
 * When the flag is off, `tenantId` is ignored. Cross-tenant isolation is
 * the caller's problem in single-tenant deployments.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { DRIZZLE } from '../../constants/tokens';
import type {
  CursorSnapshot,
  ICursorStore,
} from './integration-cursor-store.protocol';
import { integrationSubscriptions } from './integration-audit.schema';
import { INTEGRATION_MULTI_TENANT } from './integration.tokens';
import { assertTenantId } from './integration-errors';

@Injectable()
export class PostgresCursorStore implements ICursorStore {
  private readonly multiTenant: boolean;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Optional() @Inject(INTEGRATION_MULTI_TENANT) multiTenant?: boolean,
  ) {
    this.multiTenant = multiTenant ?? false;
  }

  async get(
    subscriptionId: string,
    tenantId?: string | null,
  ): Promise<unknown | null> {
    const where = this.buildWhere(subscriptionId, tenantId, 'cursor.get');

    const rows = await this.db
      .select({ cursor: integrationSubscriptions.cursor })
      .from(integrationSubscriptions)
      .where(where)
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0]?.cursor ?? null;
  }

  async put(
    subscriptionId: string,
    cursor: unknown,
    tenantId?: string | null,
  ): Promise<void> {
    const where = this.buildWhere(subscriptionId, tenantId, 'cursor.put');

    await this.db
      .update(integrationSubscriptions)
      .set({
        cursor,
        lastIntegrationAt: new Date(),
        updatedAt: new Date(),
      })
      .where(where);
  }

  async listAll(tenantId?: string | null): Promise<CursorSnapshot[]> {
    assertTenantId(tenantId, {
      multiTenant: this.multiTenant,
      operation: 'cursor.listAll',
    });

    const where = this.multiTenant
      ? eq(integrationSubscriptions.tenantId, tenantId as string)
      : undefined;

    const rows = await this.db
      .select({
        id: integrationSubscriptions.id,
        connectionId: integrationSubscriptions.connectionId,
        adapter: integrationSubscriptions.adapter,
        domain: integrationSubscriptions.domain,
        externalRef: integrationSubscriptions.externalRef,
        cursor: integrationSubscriptions.cursor,
        lastIntegrationAt: integrationSubscriptions.lastIntegrationAt,
        updatedAt: integrationSubscriptions.updatedAt,
        tenantId: integrationSubscriptions.tenantId,
      })
      .from(integrationSubscriptions)
      .where(where)
      .orderBy(desc(integrationSubscriptions.updatedAt));

    return rows.map((row) => ({
      subscriptionId: row.id,
      connectionId: row.connectionId,
      adapter: row.adapter,
      domain: row.domain,
      externalRef: row.externalRef,
      cursor: row.cursor ?? null,
      lastIntegrationAt: row.lastIntegrationAt,
      updatedAt: row.updatedAt,
      tenantId: row.tenantId,
    }));
  }

  /**
   * Centralized WHERE clause — `get` and `put` share identical semantics.
   * Drift here would let a caller read under one tenancy rule and write
   * under another.
   */
  private buildWhere(
    subscriptionId: string,
    tenantId: string | null | undefined,
    operation: string,
  ): SQL | undefined {
    assertTenantId(tenantId, {
      multiTenant: this.multiTenant,
      operation,
    });
    if (this.multiTenant) {
      return and(
        eq(integrationSubscriptions.id, subscriptionId),
        eq(integrationSubscriptions.tenantId, tenantId as string),
      );
    }
    return eq(integrationSubscriptions.id, subscriptionId);
  }
}
