/**
 * Unit tests for the `bridge_delivery` Drizzle schema (BRIDGE-1, ADR-023 Phase 2).
 *
 * Pure structural / metadata checks — no Postgres, no Docker. Mirrors the
 * shape of `domain-events.schema.spec.ts` (EVT-1).
 *
 * Index assertions are intentionally omitted: Drizzle stores index metadata
 * on a non-public table symbol with no stable introspection API. Presence of
 * the indexes is enforced by the schema source itself (see
 * `bridge-delivery.schema.ts` index callback).
 */
import { describe, it, expect } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import {
  bridgeDelivery,
  bridgeDeliveryStatusEnum,
  type BridgeDeliveryRecord,
} from '../../../../runtime/subsystems/bridge/bridge-delivery.schema';

describe('bridge-delivery.schema — import smoke', () => {
  it('exports the pgTable declaration as an object', () => {
    expect(typeof bridgeDelivery).toBe('object');
    expect(bridgeDelivery).not.toBeNull();
  });

  it('exports the status pgEnum declaration', () => {
    expect(bridgeDeliveryStatusEnum).toBeDefined();
    expect(Array.isArray(bridgeDeliveryStatusEnum.enumValues)).toBe(true);
  });
});

describe('bridge_delivery — column presence', () => {
  const cols = getTableColumns(bridgeDelivery) as Record<string, unknown>;

  it.each([
    'id',
    'eventId',
    'triggerId',
    'wrapperRunId',
    'userRunId',
    'status',
    'skipReason',
    'error',
    'tenantId',
    'attemptedAt',
    'deliveredAt',
  ])('includes column %s', (key) => {
    expect(cols[key]).toBeDefined();
  });
});

describe('bridge_delivery_status — enum values', () => {
  it('declares exactly pending | delivered | skipped | failed', () => {
    // pgEnum exposes the enum values via `enumValues`. Order is preserved
    // from the declaration (matches the schema's documented order).
    expect(bridgeDeliveryStatusEnum.enumValues).toEqual([
      'pending',
      'delivered',
      'skipped',
      'failed',
    ]);
  });
});

describe('bridge_delivery — column nullability invariants', () => {
  // The bridge ledger has specific nullability semantics that the schema
  // file documents at length; pin them here so a refactor cannot quietly
  // flip them and break the facade-eager dedup or status-machine guarantees.
  const cols = getTableColumns(bridgeDelivery) as Record<
    string,
    { notNull: boolean }
  >;

  it('event_id is NOT NULL', () => {
    expect(cols.eventId.notNull).toBe(true);
  });

  it('trigger_id is NOT NULL', () => {
    expect(cols.triggerId.notNull).toBe(true);
  });

  it('wrapper_run_id is nullable (facade-eager path has no wrapper)', () => {
    expect(cols.wrapperRunId.notNull).toBe(false);
  });

  it('user_run_id is nullable (null until delivered; never set for skipped/failed)', () => {
    expect(cols.userRunId.notNull).toBe(false);
  });

  it('tenant_id is nullable (unconditional emit; service-layer enforcement in BRIDGE-8)', () => {
    expect(cols.tenantId.notNull).toBe(false);
  });

  it('status is NOT NULL', () => {
    expect(cols.status.notNull).toBe(true);
  });
});

describe('BridgeDeliveryRecord — type-level compile check', () => {
  it('resolves to a concrete row type that includes all BRIDGE-1 columns', () => {
    // If InferSelectModel widened to `any`, TypeScript would not catch a
    // shape mismatch here. Exercising every field is a compile-time guard.
    const row: BridgeDeliveryRecord = {
      id: '00000000-0000-0000-0000-000000000000',
      eventId: '00000000-0000-0000-0000-000000000001',
      triggerId: 'send_welcome_email#0',
      wrapperRunId: null,
      userRunId: null,
      status: 'pending',
      skipReason: null,
      error: null,
      tenantId: null,
      attemptedAt: new Date(),
      deliveredAt: null,
    };
    expect(row.id).toBeDefined();
    expect(row.triggerId).toBe('send_welcome_email#0');
    expect(row.status).toBe('pending');
    expect(row.wrapperRunId).toBeNull();
    expect(row.userRunId).toBeNull();
  });

  it('accepts the four valid status values', () => {
    const statuses: BridgeDeliveryRecord['status'][] = [
      'pending',
      'delivered',
      'skipped',
      'failed',
    ];
    expect(statuses).toHaveLength(4);
  });
});
