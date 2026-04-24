/**
 * Unit tests for `MemoryBridgeDeliveryRepo` (BRIDGE-3, ADR-023 Phase 2).
 *
 * Pure in-memory; no Postgres, no Docker. The Drizzle backend (BRIDGE-4)
 * carries the integration counterpart.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  MemoryBridgeDeliveryRepo,
  UniqueConstraintError,
  type BridgeDeliveryInsert,
  type IJobBridge,
} from '../../../../runtime/subsystems/bridge';

const EVENT_A = '00000000-0000-0000-0000-00000000000a';
const EVENT_B = '00000000-0000-0000-0000-00000000000b';
const TRIGGER_X = 'send_welcome_email#0';
const TRIGGER_Y = 'sync_contact_to_hubspot#0';

function row(
  eventId: string,
  triggerId: string,
  overrides: Partial<BridgeDeliveryInsert> = {},
): BridgeDeliveryInsert {
  return {
    id: randomUUID(),
    eventId,
    triggerId,
    wrapperRunId: null,
    userRunId: null,
    status: 'pending',
    skipReason: null,
    error: null,
    tenantId: null,
    attemptedAt: new Date(),
    deliveredAt: null,
    ...overrides,
  };
}

describe('MemoryBridgeDeliveryRepo — protocol compliance', () => {
  let repo: IJobBridge;

  beforeEach(() => {
    repo = new MemoryBridgeDeliveryRepo();
  });

  it('inserts a row and finds it back by (eventId, triggerId)', async () => {
    const r = row(EVENT_A, TRIGGER_X);
    await repo.insertDelivery(r);
    const found = await repo.findDelivery(EVENT_A, TRIGGER_X);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(r.id!);
    expect(found?.status).toBe('pending');
  });

  it('returns null for a missing key', async () => {
    expect(await repo.findDelivery(EVENT_A, TRIGGER_X)).toBeNull();
  });

  it('throws UniqueConstraintError on duplicate (eventId, triggerId)', async () => {
    await repo.insertDelivery(row(EVENT_A, TRIGGER_X));
    let caught: unknown;
    try {
      await repo.insertDelivery(row(EVENT_A, TRIGGER_X));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UniqueConstraintError);
    const err = caught as UniqueConstraintError;
    // The discriminator must equal the Drizzle constraint name from
    // BRIDGE-1 so call sites can share branch logic across backends.
    expect(err.constraint).toBe('uq_bridge_delivery_event_trigger');
    expect(err.eventId).toBe(EVENT_A);
    expect(err.triggerId).toBe(TRIGGER_X);
  });

  it('allows the same triggerId for a different eventId', async () => {
    await repo.insertDelivery(row(EVENT_A, TRIGGER_X));
    await repo.insertDelivery(row(EVENT_B, TRIGGER_X));
    expect((await repo.findDelivery(EVENT_A, TRIGGER_X))?.eventId).toBe(EVENT_A);
    expect((await repo.findDelivery(EVENT_B, TRIGGER_X))?.eventId).toBe(EVENT_B);
  });

  it('allows different triggerIds for the same eventId', async () => {
    await repo.insertDelivery(row(EVENT_A, TRIGGER_X));
    await repo.insertDelivery(row(EVENT_A, TRIGGER_Y));
    const found = (
      repo as MemoryBridgeDeliveryRepo
    ).getDeliveriesForEvent(EVENT_A);
    expect(found).toHaveLength(2);
  });
});

describe('MemoryBridgeDeliveryRepo — state transitions', () => {
  let repo: MemoryBridgeDeliveryRepo;

  beforeEach(() => {
    repo = new MemoryBridgeDeliveryRepo();
  });

  it('markDelivered sets status, userRunId, and deliveredAt', async () => {
    const r = row(EVENT_A, TRIGGER_X);
    await repo.insertDelivery(r);
    const before = await repo.findDelivery(EVENT_A, TRIGGER_X);
    expect(before?.status).toBe('pending');
    expect(before?.deliveredAt).toBeNull();

    await repo.markDelivered(r.id!, 'run-123');

    const after = await repo.findDelivery(EVENT_A, TRIGGER_X);
    expect(after?.status).toBe('delivered');
    expect(after?.userRunId).toBe('run-123');
    expect(after?.deliveredAt).toBeInstanceOf(Date);
  });

  it('markSkipped sets status and skipReason', async () => {
    const r = row(EVENT_A, TRIGGER_X);
    await repo.insertDelivery(r);
    await repo.markSkipped(r.id!, 'when_returned_false');
    const found = await repo.findDelivery(EVENT_A, TRIGGER_X);
    expect(found?.status).toBe('skipped');
    expect(found?.skipReason).toBe('when_returned_false');
  });

  it('markFailed sets status and error', async () => {
    const r = row(EVENT_A, TRIGGER_X);
    await repo.insertDelivery(r);
    const errPayload = { message: 'boom', stack: 'stack', retryable: false };
    await repo.markFailed(r.id!, errPayload);
    const found = await repo.findDelivery(EVENT_A, TRIGGER_X);
    expect(found?.status).toBe('failed');
    expect(found?.error).toEqual(errPayload);
  });

  it('throws on transition for unknown id', async () => {
    expect(repo.markDelivered('does-not-exist', 'run-x')).rejects.toThrow(
      /no delivery with id/,
    );
    expect(repo.markSkipped('does-not-exist', 'reason')).rejects.toThrow(
      /no delivery with id/,
    );
    expect(repo.markFailed('does-not-exist', {})).rejects.toThrow(
      /no delivery with id/,
    );
  });
});

describe('MemoryBridgeDeliveryRepo — test helpers', () => {
  let repo: MemoryBridgeDeliveryRepo;

  beforeEach(() => {
    repo = new MemoryBridgeDeliveryRepo();
  });

  it('getDeliveriesForEvent returns all rows for that event', async () => {
    await repo.insertDelivery(row(EVENT_A, TRIGGER_X));
    await repo.insertDelivery(row(EVENT_A, TRIGGER_Y));
    await repo.insertDelivery(row(EVENT_B, TRIGGER_X));
    expect(repo.getDeliveriesForEvent(EVENT_A)).toHaveLength(2);
    expect(repo.getDeliveriesForEvent(EVENT_B)).toHaveLength(1);
    expect(repo.getDeliveriesForEvent('00000000-0000-0000-0000-000000000fff')).toHaveLength(0);
  });

  it('getByStatus filters by status', async () => {
    const r1 = row(EVENT_A, TRIGGER_X);
    const r2 = row(EVENT_A, TRIGGER_Y);
    const r3 = row(EVENT_B, TRIGGER_X);
    await repo.insertDelivery(r1);
    await repo.insertDelivery(r2);
    await repo.insertDelivery(r3);
    await repo.markDelivered(r1.id!, 'run-1');
    await repo.markSkipped(r2.id!, 'when_returned_false');

    expect(repo.getByStatus('delivered')).toHaveLength(1);
    expect(repo.getByStatus('skipped')).toHaveLength(1);
    expect(repo.getByStatus('pending')).toHaveLength(1);
    expect(repo.getByStatus('failed')).toHaveLength(0);
  });

  it('clear empties the store', async () => {
    await repo.insertDelivery(row(EVENT_A, TRIGGER_X));
    expect(repo.getDeliveriesForEvent(EVENT_A)).toHaveLength(1);
    repo.clear();
    expect(repo.getDeliveriesForEvent(EVENT_A)).toHaveLength(0);
    // Insert with the same key now succeeds — the constraint state is gone.
    await expect(
      repo.insertDelivery(row(EVENT_A, TRIGGER_X)),
    ).resolves.toBeUndefined();
  });
});

describe('MemoryBridgeDeliveryRepo — getStatusHistogram (OBS-3)', () => {
  let repo: MemoryBridgeDeliveryRepo;

  beforeEach(() => {
    repo = new MemoryBridgeDeliveryRepo();
  });

  it('returns all-zero histogram when no deliveries exist', async () => {
    const h = await repo.getStatusHistogram(24);
    expect(h).toEqual({ pending: 0, delivered: 0, skipped: 0, failed: 0 });
  });

  it('counts one delivery in each status correctly', async () => {
    const now = new Date();
    const pending = row(EVENT_A, 'trig#0', { attemptedAt: now });
    const delivered = row(EVENT_A, 'trig#1', { attemptedAt: now });
    const skipped = row(EVENT_A, 'trig#2', { attemptedAt: now });
    const failed = row(EVENT_A, 'trig#3', { attemptedAt: now });
    await repo.insertDelivery(pending);
    await repo.insertDelivery(delivered);
    await repo.insertDelivery(skipped);
    await repo.insertDelivery(failed);
    await repo.markDelivered(delivered.id!, 'run-d');
    await repo.markSkipped(skipped.id!, 'predicate_false');
    await repo.markFailed(failed.id!, { message: 'boom' });

    const h = await repo.getStatusHistogram(24);
    expect(h).toEqual({ pending: 1, delivered: 1, skipped: 1, failed: 1 });
  });

  it('excludes deliveries attempted before the windowHours cutoff', async () => {
    const old = new Date(Date.now() - 48 * 3_600_000); // 48h ago
    const recent = new Date();
    await repo.insertDelivery(row(EVENT_A, 'old#0', { attemptedAt: old }));
    await repo.insertDelivery(row(EVENT_A, 'new#0', { attemptedAt: recent }));

    const h = await repo.getStatusHistogram(24); // 24h window
    expect(h).toEqual({ pending: 1, delivered: 0, skipped: 0, failed: 0 });
  });

  it('includes deliveries exactly at the boundary (>= cutoff)', async () => {
    // Freeze the comparison: put the delivery at exactly cutoff by using
    // an attemptedAt that is `now - windowHours * 3_600_000` — this is
    // the precise boundary. We rely on the implementation using `<`
    // (strict) to exclude BELOW cutoff, so equal should be INCLUDED.
    const windowHours = 1;
    const boundary = new Date(Date.now() - windowHours * 3_600_000);
    await repo.insertDelivery(
      row(EVENT_A, 'boundary#0', { attemptedAt: boundary }),
    );
    const h = await repo.getStatusHistogram(windowHours);
    expect(h.pending).toBe(1);
  });

  it('tenantId undefined matches all rows regardless of tenant', async () => {
    const now = new Date();
    await repo.insertDelivery(
      row(EVENT_A, 'a#0', { attemptedAt: now, tenantId: 't-1' }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'b#0', { attemptedAt: now, tenantId: 't-2' }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'c#0', { attemptedAt: now, tenantId: null }),
    );
    const h = await repo.getStatusHistogram(24);
    expect(h.pending).toBe(3);
  });

  it('tenantId === null matches only rows with tenantId IS NULL', async () => {
    const now = new Date();
    await repo.insertDelivery(
      row(EVENT_A, 'a#0', { attemptedAt: now, tenantId: 't-1' }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'b#0', { attemptedAt: now, tenantId: null }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'c#0', { attemptedAt: now, tenantId: null }),
    );
    const h = await repo.getStatusHistogram(24, null);
    expect(h.pending).toBe(2);
  });

  it('tenantId === string matches only rows where tenantId equals that string', async () => {
    const now = new Date();
    await repo.insertDelivery(
      row(EVENT_A, 'a#0', { attemptedAt: now, tenantId: 't-1' }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'b#0', { attemptedAt: now, tenantId: 't-1' }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'c#0', { attemptedAt: now, tenantId: 't-2' }),
    );
    await repo.insertDelivery(
      row(EVENT_A, 'd#0', { attemptedAt: now, tenantId: null }),
    );
    const h = await repo.getStatusHistogram(24, 't-1');
    expect(h.pending).toBe(2);
  });

  it('returns zero-fill for statuses with no matching rows', async () => {
    const now = new Date();
    const r = row(EVENT_A, 'only-pending#0', { attemptedAt: now });
    await repo.insertDelivery(r);
    const h = await repo.getStatusHistogram(24);
    expect(h).toEqual({ pending: 1, delivered: 0, skipped: 0, failed: 0 });
  });

  it('throws RangeError for windowHours <= 0', async () => {
    expect(repo.getStatusHistogram(0)).rejects.toThrow(RangeError);
    expect(repo.getStatusHistogram(-1)).rejects.toThrow(RangeError);
    expect(repo.getStatusHistogram(Number.NaN)).rejects.toThrow(RangeError);
  });
});

describe('MemoryBridgeDeliveryRepo — facade Case B simulation', () => {
  // ADR-023 §`publishAndStart` + existing `triggers:` collision: the
  // facade pre-writes a (status='delivered', wrapper_run_id=null) row;
  // the drain's later insert MUST surface as a constraint violation so
  // BRIDGE-4 / BRIDGE-7 know to skip that trigger.
  it('drain insert after facade pre-write throws UniqueConstraintError', async () => {
    const repo = new MemoryBridgeDeliveryRepo();
    // Facade pre-write:
    await repo.insertDelivery(
      row(EVENT_A, TRIGGER_X, {
        status: 'delivered',
        wrapperRunId: null,
        userRunId: 'eager-run-id',
        deliveredAt: new Date(),
      }),
    );
    // Simulated drain insert:
    let caught: unknown;
    try {
      await repo.insertDelivery(
        row(EVENT_A, TRIGGER_X, {
          status: 'pending',
          wrapperRunId: 'wrapper-run-id',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UniqueConstraintError);
    // Existing row is unchanged — drain didn't overwrite the facade's
    // `delivered` row.
    const existing = await repo.findDelivery(EVENT_A, TRIGGER_X);
    expect(existing?.status).toBe('delivered');
    expect(existing?.userRunId).toBe('eager-run-id');
  });
});
