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
