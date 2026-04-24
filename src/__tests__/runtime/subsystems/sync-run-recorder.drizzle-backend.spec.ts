/**
 * Unit tests for DrizzleSyncRunRecorder (SYNC-4).
 *
 * Pure bun:test with `drizzle-orm/pg-proxy` — no Postgres, no Docker.
 *
 * Covers:
 *   - `startRun` INSERTs sync_runs row and returns the generated id
 *   - `recordItem` runs FieldDiffSchema.parse BEFORE the DB call — a
 *     malformed changedFields throws before any INSERT fires (ADR-0003
 *     contract enforcement)
 *   - `completeRun` UPDATEs the run row with terminal status + counts
 *   - multi-tenant strict enforcement on startRun + recordItem
 *   - single-tenant mode ignores tenantId
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { ZodError } from 'zod';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';
import { DrizzleSyncRunRecorder } from '../../../../runtime/subsystems/sync/sync-run-recorder.drizzle-backend';
import { MissingTenantIdError } from '../../../../runtime/subsystems/sync/sync-errors';

interface Captured {
  sql: string;
  params: unknown[];
  method: string;
}

function makeCapturingDb(
  response: { rows: unknown[][] } | { rows: unknown[] },
) {
  const captures: Captured[] = [];
  const db = drizzle(async (sql, params, method) => {
    captures.push({ sql, params, method });
    return response as { rows: unknown[] };
  }) as unknown as DrizzleClient;
  return { db, captures };
}

const RUN_UUID = '11111111-1111-1111-1111-111111111111';

describe('DrizzleSyncRunRecorder — single-tenant', () => {
  let recorder: DrizzleSyncRunRecorder;
  let captures: Captured[];
  let db: DrizzleClient;

  beforeEach(() => {
    ({ db, captures } = makeCapturingDb({
      rows: [[RUN_UUID]] as unknown[][],
    }));
    recorder = new DrizzleSyncRunRecorder(db);
  });

  describe('startRun', () => {
    it('INSERTs into sync_runs and returns the id', async () => {
      const result = await recorder.startRun({
        subscriptionId: 'sub-1',
        direction: 'inbound',
        action: 'poll',
        cursorBefore: null,
      });

      expect(result.id).toBe(RUN_UUID);
      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('insert');
      expect(sql).toContain('"sync_runs"');
      expect(sql.toLowerCase()).toContain('returning');
      // Non-nullable column values bound.
      expect(params).toContain('sub-1');
      expect(params).toContain('inbound');
      expect(params).toContain('poll');
      expect(params).toContain('running');
    });

    it('passes cursor_before through when provided', async () => {
      await recorder.startRun({
        subscriptionId: 'sub-1',
        direction: 'inbound',
        action: 'poll',
        cursorBefore: { systemModstamp: '2026-04-21' },
      });
      const [{ params }] = captures;
      const cursorParam = params.find(
        (p) => typeof p === 'string' && p.includes('systemModstamp'),
      );
      expect(cursorParam).toBeDefined();
    });

    it('throws when INSERT RETURNING produces no rows (driver misbehavior)', async () => {
      ({ db, captures } = makeCapturingDb({ rows: [] }));
      recorder = new DrizzleSyncRunRecorder(db);

      await expect(
        recorder.startRun({
          subscriptionId: 'sub-1',
          direction: 'inbound',
          action: 'poll',
          cursorBefore: null,
        }),
      ).rejects.toThrow(/RETURNING produced no id/);
    });
  });

  describe('recordItem', () => {
    beforeEach(() => {
      ({ db, captures } = makeCapturingDb({ rows: [] }));
      recorder = new DrizzleSyncRunRecorder(db);
    });

    it('INSERTs a row with valid changedFields', async () => {
      await recorder.recordItem({
        syncRunId: RUN_UUID,
        entityType: 'opportunity',
        externalId: 'ext-1',
        operation: 'updated',
        status: 'success',
        changedFields: { amount: { from: 100, to: 120 } },
      });

      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('insert');
      expect(sql).toContain('"sync_run_items"');
      expect(params).toContain(RUN_UUID);
      expect(params).toContain('opportunity');
      expect(params).toContain('ext-1');
      expect(params).toContain('updated');
      expect(params).toContain('success');
      // changedFields serialized as JSON string containing the key.
      const diffParam = params.find(
        (p) => typeof p === 'string' && p.includes('amount'),
      );
      expect(diffParam).toBeDefined();
    });

    it('rejects malformed changedFields BEFORE the DB call (ADR-0003)', async () => {
      await expect(
        recorder.recordItem({
          syncRunId: RUN_UUID,
          entityType: 'opportunity',
          externalId: 'ext-1',
          operation: 'updated',
          status: 'success',
          // Not the {from, to} shape.
          changedFields: { amount: 'not-an-object' } as unknown as Record<
            string,
            { from: unknown; to: unknown }
          >,
        }),
      ).rejects.toBeInstanceOf(ZodError);

      // No INSERT fired — parse threw before the await reached the db.
      expect(captures).toHaveLength(0);
    });

    it('accepts empty-object changedFields for noop/skipped items', async () => {
      await recorder.recordItem({
        syncRunId: RUN_UUID,
        entityType: 'opportunity',
        externalId: 'ext-1',
        operation: 'noop',
        status: 'success',
        changedFields: {},
      });
      expect(captures).toHaveLength(1);
      const [{ params }] = captures;
      expect(params).toContain('noop');
    });
  });

  describe('completeRun', () => {
    beforeEach(() => {
      ({ db, captures } = makeCapturingDb({ rows: [] }));
      recorder = new DrizzleSyncRunRecorder(db);
    });

    it('UPDATEs sync_runs with terminal status + counts + duration', async () => {
      await recorder.completeRun(RUN_UUID, {
        status: 'success',
        recordsFound: 10,
        recordsProcessed: 9,
        cursorAfter: { systemModstamp: '2026-04-21T13:00:00Z' },
        durationMs: 1234,
      });

      expect(captures).toHaveLength(1);
      const [{ sql, params }] = captures;
      expect(sql.toLowerCase()).toContain('update');
      expect(sql).toContain('"sync_runs"');
      expect(sql).toContain('"status"');
      expect(sql).toContain('"records_found"');
      expect(sql).toContain('"records_processed"');
      expect(sql).toContain('"cursor_after"');
      expect(sql).toContain('"duration_ms"');
      expect(sql).toContain('"completed_at"');

      expect(params).toContain('success');
      expect(params).toContain(10);
      expect(params).toContain(9);
      expect(params).toContain(1234);
      expect(params).toContain(RUN_UUID);
    });

    it('passes error string through when provided', async () => {
      await recorder.completeRun(RUN_UUID, {
        status: 'failed',
        recordsFound: 1,
        recordsProcessed: 0,
        cursorAfter: null,
        durationMs: 50,
        error: 'session expired',
      });
      const [{ params }] = captures;
      expect(params).toContain('failed');
      expect(params).toContain('session expired');
    });
  });
});

describe('DrizzleSyncRunRecorder — multi-tenant', () => {
  let recorder: DrizzleSyncRunRecorder;
  let captures: Captured[];
  let db: DrizzleClient;

  beforeEach(() => {
    ({ db, captures } = makeCapturingDb({
      rows: [[RUN_UUID]] as unknown[][],
    }));
    recorder = new DrizzleSyncRunRecorder(db, true);
  });

  describe('startRun — strict tenancy', () => {
    it('throws MissingTenantIdError when tenantId is omitted', async () => {
      await expect(
        recorder.startRun({
          subscriptionId: 'sub-1',
          direction: 'inbound',
          action: 'poll',
          cursorBefore: null,
        }),
      ).rejects.toBeInstanceOf(MissingTenantIdError);
      expect(captures).toHaveLength(0);
    });

    it('throws MissingTenantIdError when tenantId is explicit null', async () => {
      await expect(
        recorder.startRun({
          subscriptionId: 'sub-1',
          direction: 'inbound',
          action: 'poll',
          cursorBefore: null,
          tenantId: null,
        }),
      ).rejects.toBeInstanceOf(MissingTenantIdError);
    });

    it('accepts a valid tenantId and binds it as a param', async () => {
      await recorder.startRun({
        subscriptionId: 'sub-1',
        direction: 'inbound',
        action: 'poll',
        cursorBefore: null,
        tenantId: 'tenant-a',
      });
      expect(captures).toHaveLength(1);
      const [{ params }] = captures;
      expect(params).toContain('tenant-a');
    });
  });

  describe('recordItem — strict tenancy', () => {
    it('throws MissingTenantIdError when tenantId is omitted', async () => {
      ({ db, captures } = makeCapturingDb({ rows: [] }));
      recorder = new DrizzleSyncRunRecorder(db, true);

      await expect(
        recorder.recordItem({
          syncRunId: RUN_UUID,
          entityType: 'opportunity',
          externalId: 'ext-1',
          operation: 'updated',
          status: 'success',
          changedFields: {},
        }),
      ).rejects.toBeInstanceOf(MissingTenantIdError);
      expect(captures).toHaveLength(0);
    });

    it('accepts a valid tenantId and binds it', async () => {
      ({ db, captures } = makeCapturingDb({ rows: [] }));
      recorder = new DrizzleSyncRunRecorder(db, true);

      await recorder.recordItem({
        syncRunId: RUN_UUID,
        entityType: 'opportunity',
        externalId: 'ext-1',
        operation: 'updated',
        status: 'success',
        changedFields: {},
        tenantId: 'tenant-a',
      });
      const [{ params }] = captures;
      expect(params).toContain('tenant-a');
    });
  });

  describe('completeRun — does NOT re-check tenancy', () => {
    it('trusts the run id and fires the UPDATE without tenant guard', async () => {
      // completeRun takes a run id from startRun (which already enforced
      // tenancy); forcing another check here would require threading
      // tenantId through every call path. The run id is a uuid and not
      // guessable cross-tenant.
      ({ db, captures } = makeCapturingDb({ rows: [] }));
      recorder = new DrizzleSyncRunRecorder(db, true);

      await recorder.completeRun(RUN_UUID, {
        status: 'success',
        recordsFound: 1,
        recordsProcessed: 1,
        cursorAfter: null,
        durationMs: 10,
      });

      expect(captures).toHaveLength(1);
    });
  });
});

describe('DrizzleSyncRunRecorder.listRecent (OBS-4) — single-tenant', () => {
  let recorder: DrizzleSyncRunRecorder;
  let captures: Captured[];
  let db: DrizzleClient;

  beforeEach(() => {
    ({ db, captures } = makeCapturingDb({ rows: [] }));
    recorder = new DrizzleSyncRunRecorder(db);
  });

  it('returns [] when no runs exist', async () => {
    expect(await recorder.listRecent(10)).toEqual([]);
    expect(captures).toHaveLength(1);
  });

  it('JOINs sync_runs against sync_subscriptions and SELECTs integration_id', async () => {
    await recorder.listRecent(5);
    expect(captures).toHaveLength(1);
    const [{ sql }] = captures;
    expect(sql.toLowerCase()).toContain('select');
    expect(sql).toContain('"sync_runs"');
    expect(sql).toContain('"sync_subscriptions"');
    expect(sql.toLowerCase()).toContain('join');
    expect(sql).toContain('"integration_id"');
    // ORDER BY started_at DESC LIMIT.
    expect(sql.toLowerCase()).toContain('order by');
    expect(sql.toLowerCase()).toContain('desc');
    expect(sql.toLowerCase()).toContain('limit');
  });

  it('does not include records_processed from a correlated subquery — reads the column directly', async () => {
    await recorder.listRecent(5);
    const [{ sql }] = captures;
    expect(sql).toContain('"records_processed"');
    // No nested `select count` — we read the denormalized column.
    expect(sql.toLowerCase()).not.toContain('count(');
  });

  it('binds subscriptionId when provided', async () => {
    await recorder.listRecent(5, 'sub-1');
    const [{ sql, params }] = captures;
    expect(params).toContain('sub-1');
    // Filter lands on sync_runs.subscription_id (the FK), not the join target id.
    expect(sql).toContain('"subscription_id"');
  });

  it('ignores tenantId when multi-tenant mode is off', async () => {
    await recorder.listRecent(5, undefined, 'tenant-a');
    const [{ sql, params }] = captures;
    // `tenant_id` appears in the SELECT projection (column on sync_runs),
    // but must NOT appear in a WHERE/filter. Single-tenant has no WHERE
    // when subscriptionId is also omitted.
    expect(sql.toLowerCase()).not.toContain('where');
    expect(params).not.toContain('tenant-a');
  });
});

describe('DrizzleSyncRunRecorder.listRecent (OBS-4) — multi-tenant', () => {
  let recorder: DrizzleSyncRunRecorder;
  let captures: Captured[];
  let db: DrizzleClient;

  beforeEach(() => {
    ({ db, captures } = makeCapturingDb({ rows: [] }));
    recorder = new DrizzleSyncRunRecorder(db, true);
  });

  it('throws MissingTenantIdError when tenantId is omitted', async () => {
    await expect(recorder.listRecent(5)).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
    expect(captures).toHaveLength(0);
  });

  it('throws MissingTenantIdError when tenantId is explicit null', async () => {
    await expect(recorder.listRecent(5, undefined, null)).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
  });

  it('binds tenantId into the WHERE clause', async () => {
    await recorder.listRecent(5, undefined, 'tenant-a');
    expect(captures).toHaveLength(1);
    const [{ sql, params }] = captures;
    expect(sql.toLowerCase()).toContain('tenant_id');
    expect(params).toContain('tenant-a');
  });

  it('combines subscriptionId + tenantId filters', async () => {
    await recorder.listRecent(5, 'sub-1', 'tenant-a');
    const [{ params }] = captures;
    expect(params).toContain('sub-1');
    expect(params).toContain('tenant-a');
  });
});

describe('DrizzleSyncRunRecorder — multiTenant constructor default', () => {
  it('defaults multiTenant to false when the token is not provided', async () => {
    const { db, captures } = makeCapturingDb({
      rows: [[RUN_UUID]] as unknown[][],
    });
    const recorder = new DrizzleSyncRunRecorder(db, undefined);

    // No tenantId in input, no throw — single-tenant is the default.
    await recorder.startRun({
      subscriptionId: 'sub-1',
      direction: 'inbound',
      action: 'poll',
      cursorBefore: null,
    });
    expect(captures).toHaveLength(1);
  });
});
