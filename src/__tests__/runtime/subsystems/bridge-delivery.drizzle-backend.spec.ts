/**
 * Unit tests for `DrizzleBridgeDeliveryRepo` (BRIDGE-4, ADR-023 Phase 2).
 *
 * `drizzle-orm/pg-proxy` driver — captures the issued SQL + params and
 * returns canned responses. No Postgres, no Docker. Mirrors the shape of
 * `sync-run-recorder.drizzle-backend.spec.ts` (SYNC-4 precedent).
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';

import type { DrizzleClient } from '../../../../runtime/types/drizzle';
import { DrizzleBridgeDeliveryRepo } from '../../../../runtime/subsystems/bridge';
import type { BridgeDeliveryInsert } from '../../../../runtime/subsystems/bridge';

interface Captured {
  sql: string;
  params: unknown[];
  method: string;
}

function makeCapturingDb(rows: unknown[][] = []) {
  const captures: Captured[] = [];
  const db = drizzle(async (sql, params, method) => {
    captures.push({ sql, params, method });
    return { rows };
  }) as unknown as DrizzleClient;
  return { db, captures };
}

const DELIVERY_ID = '00000000-0000-0000-0000-000000000001';
const EVENT_ID = '00000000-0000-0000-0000-000000000002';
const TRIGGER_ID = 'send_welcome_email#0';

describe('DrizzleBridgeDeliveryRepo — insertDelivery', () => {
  it('emits INSERT … ON CONFLICT (event_id, trigger_id) DO NOTHING', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db);

    const row: BridgeDeliveryInsert = {
      id: DELIVERY_ID,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      wrapperRunId: 'wrapper-1',
      status: 'pending',
      tenantId: null,
    };
    await repo.insertDelivery(row);

    expect(captures).toHaveLength(1);
    const sql = captures[0]!.sql.toLowerCase();
    expect(sql).toContain('insert into "bridge_delivery"');
    expect(sql).toContain('on conflict ("event_id","trigger_id") do nothing');
    expect(captures[0]!.params).toContain(EVENT_ID);
    expect(captures[0]!.params).toContain(TRIGGER_ID);
  });

  it('passes through tenantId for multi-tenancy plumbing', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db);
    await repo.insertDelivery({
      id: DELIVERY_ID,
      eventId: EVENT_ID,
      triggerId: TRIGGER_ID,
      status: 'pending',
      tenantId: 'tenant-9',
    });
    expect(captures[0]!.params).toContain('tenant-9');
  });
});

describe('DrizzleBridgeDeliveryRepo — find queries', () => {
  it('findDelivery selects by (event_id, trigger_id) with LIMIT 1', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db);

    await repo.findDelivery(EVENT_ID, TRIGGER_ID);

    expect(captures).toHaveLength(1);
    const sql = captures[0]!.sql.toLowerCase();
    expect(sql).toContain('select');
    expect(sql).toContain('from "bridge_delivery"');
    expect(sql).toContain('"event_id"');
    expect(sql).toContain('"trigger_id"');
    expect(sql).toContain('limit');
    expect(captures[0]!.params).toContain(EVENT_ID);
    expect(captures[0]!.params).toContain(TRIGGER_ID);
  });

  it('findDeliveryById selects by id with LIMIT 1', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db);

    await repo.findDeliveryById(DELIVERY_ID);

    expect(captures).toHaveLength(1);
    const sql = captures[0]!.sql.toLowerCase();
    expect(sql).toContain('from "bridge_delivery"');
    expect(sql).toContain('"id"');
    expect(captures[0]!.params).toContain(DELIVERY_ID);
  });

  it('returns null when the row is not found', async () => {
    const { db } = makeCapturingDb([]); // empty rows
    const repo = new DrizzleBridgeDeliveryRepo(db);
    expect(await repo.findDelivery(EVENT_ID, TRIGGER_ID)).toBeNull();
    expect(await repo.findDeliveryById(DELIVERY_ID)).toBeNull();
  });
});

describe('DrizzleBridgeDeliveryRepo — state transitions', () => {
  let captures: Captured[];
  let repo: DrizzleBridgeDeliveryRepo;

  beforeEach(() => {
    const c = makeCapturingDb();
    captures = c.captures;
    repo = new DrizzleBridgeDeliveryRepo(c.db);
  });

  it('markDelivered UPDATEs status, user_run_id, delivered_at', async () => {
    await repo.markDelivered(DELIVERY_ID, 'user-run-7');
    const sql = captures[0]!.sql.toLowerCase();
    expect(sql).toContain('update "bridge_delivery"');
    expect(sql).toContain('"status"');
    expect(sql).toContain('"user_run_id"');
    expect(sql).toContain('"delivered_at"');
    expect(captures[0]!.params).toContain('delivered');
    expect(captures[0]!.params).toContain('user-run-7');
    expect(captures[0]!.params).toContain(DELIVERY_ID);
  });

  it('markSkipped UPDATEs status + skip_reason', async () => {
    await repo.markSkipped(DELIVERY_ID, 'predicate_false');
    expect(captures[0]!.params).toContain('skipped');
    expect(captures[0]!.params).toContain('predicate_false');
    expect(captures[0]!.params).toContain(DELIVERY_ID);
  });

  it('markFailed UPDATEs status + error JSON', async () => {
    await repo.markFailed(DELIVERY_ID, { message: 'boom', stack: 's' });
    const sql = captures[0]!.sql.toLowerCase();
    expect(sql).toContain('"error"');
    expect(captures[0]!.params).toContain('failed');
    expect(captures[0]!.params).toContain(DELIVERY_ID);
  });
});
