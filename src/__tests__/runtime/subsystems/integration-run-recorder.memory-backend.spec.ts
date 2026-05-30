/**
 * Unit tests for MemoryRunRecorder.listRecent (OBS-4).
 *
 * Pure `bun:test` — covers the read projection introduced in OBS-4 against
 * the memory backend. The write-path paths (`startRun`, `recordItem`,
 * `completeRun`) are exercised elsewhere; this suite focuses on
 * `listRecent` + the seedable `subscriptions` side-map.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryRunRecorder } from '../../../../runtime/subsystems/integration/integration-run-recorder.memory-backend';
import type { IIntegrationRunRecorder } from '../../../../runtime/subsystems/integration/integration-run-recorder.protocol';

async function seedRun(
  recorder: MemoryRunRecorder,
  subscriptionId: string,
  startedAtMs: number,
  options: {
    recordsProcessed?: number;
    status?: 'running' | 'success' | 'no_changes' | 'failed';
    tenantId?: string | null;
  } = {},
): Promise<string> {
  const { id } = await recorder.startRun({
    subscriptionId,
    direction: 'inbound',
    action: 'poll',
    cursorBefore: null,
    tenantId: options.tenantId ?? null,
  });
  const run = recorder.runs.get(id);
  if (!run) throw new Error(`seedRun: missing run ${id}`);
  run.startedAt = new Date(startedAtMs);
  if (options.status && options.status !== 'running') {
    run.status = options.status;
    run.recordsProcessed = options.recordsProcessed ?? 0;
    run.completedAt = new Date(startedAtMs + 1000);
  }
  return id;
}

describe('MemoryRunRecorder.listRecent', () => {
  let recorder: MemoryRunRecorder;

  beforeEach(() => {
    recorder = new MemoryRunRecorder();
  });

  describe('contract conformance', () => {
    it('implements IIntegrationRunRecorder structurally', () => {
      const asPort: IIntegrationRunRecorder = recorder;
      expect(typeof asPort.listRecent).toBe('function');
    });
  });

  describe('empty state', () => {
    it('returns [] when no runs have been started', async () => {
      expect(await recorder.listRecent(10)).toEqual([]);
    });

    it('returns [] when filter matches nothing', async () => {
      await seedRun(recorder, 'sub-a', 1_000);
      expect(await recorder.listRecent(10, 'sub-missing')).toEqual([]);
    });
  });

  describe('ordering + limit', () => {
    it('orders by startedAt DESC', async () => {
      await seedRun(recorder, 'sub-a', 3_000);
      await seedRun(recorder, 'sub-a', 1_000);
      await seedRun(recorder, 'sub-a', 2_000);

      const rows = await recorder.listRecent(10);
      expect(rows.map((r) => r.startedAt.getTime())).toEqual([
        3_000, 2_000, 1_000,
      ]);
    });

    it('truncates to `limit`', async () => {
      await seedRun(recorder, 'sub-a', 1_000);
      await seedRun(recorder, 'sub-a', 2_000);
      await seedRun(recorder, 'sub-a', 3_000);

      const rows = await recorder.listRecent(2);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.startedAt.getTime()).toBe(3_000);
      expect(rows[1]?.startedAt.getTime()).toBe(2_000);
    });
  });

  describe('subscription filter', () => {
    it('filters by subscriptionId when provided', async () => {
      await seedRun(recorder, 'sub-a', 1_000);
      await seedRun(recorder, 'sub-b', 2_000);
      await seedRun(recorder, 'sub-a', 3_000);

      const rows = await recorder.listRecent(10, 'sub-a');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.subscriptionId === 'sub-a')).toBe(true);
    });

    it('returns all subscriptions when filter is omitted', async () => {
      await seedRun(recorder, 'sub-a', 1_000);
      await seedRun(recorder, 'sub-b', 2_000);
      const rows = await recorder.listRecent(10);
      expect(rows).toHaveLength(2);
    });
  });

  describe('tenantId parameter', () => {
    it('accepts tenantId but does NOT filter on it (memory contract)', async () => {
      await seedRun(recorder, 'sub-a', 1_000, { tenantId: 'tenant-a' });
      await seedRun(recorder, 'sub-a', 2_000, { tenantId: 'tenant-b' });

      // Memory backend ignores tenantId — both rows come back regardless
      // of the value passed. This matches MemoryCursorStore's behavior.
      const rowsA = await recorder.listRecent(10, undefined, 'tenant-a');
      expect(rowsA).toHaveLength(2);
      const rowsNone = await recorder.listRecent(10);
      expect(rowsNone).toHaveLength(2);
    });
  });

  describe('connectionId resolution via subscriptions side-map', () => {
    it('returns empty string when no subscription metadata has been seeded', async () => {
      await seedRun(recorder, 'sub-a', 1_000);
      const [row] = await recorder.listRecent(10);
      expect(row?.connectionId).toBe('');
    });

    it('returns the seeded connectionId when the subscription is populated', async () => {
      recorder.subscriptions.set('sub-a', {
        connectionId: 'int-1',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: null,
        updatedAt: new Date(500),
      });
      await seedRun(recorder, 'sub-a', 1_000);

      const [row] = await recorder.listRecent(10);
      expect(row?.connectionId).toBe('int-1');
    });
  });

  describe('IntegrationRunSummary shape', () => {
    it('projects run into the documented summary shape', async () => {
      recorder.subscriptions.set('sub-a', {
        connectionId: 'int-1',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: 'ref-x',
        updatedAt: new Date(500),
      });
      const id = await seedRun(recorder, 'sub-a', 1_000, {
        status: 'success',
        recordsProcessed: 7,
        tenantId: 'tenant-a',
      });

      const [row] = await recorder.listRecent(10);
      expect(row).toEqual({
        id,
        subscriptionId: 'sub-a',
        connectionId: 'int-1',
        status: 'success',
        startedAt: new Date(1_000),
        completedAt: new Date(2_000),
        recordsProcessed: 7,
        tenantId: 'tenant-a',
      });
    });
  });

  describe('clear', () => {
    it('resets runs, items, and subscriptions together', async () => {
      recorder.subscriptions.set('sub-a', {
        connectionId: 'int-1',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: null,
        updatedAt: new Date(500),
      });
      await seedRun(recorder, 'sub-a', 1_000);

      recorder.clear();

      expect(recorder.runs.size).toBe(0);
      expect(recorder.items.size).toBe(0);
      expect(recorder.subscriptions.size).toBe(0);
      expect(await recorder.listRecent(10)).toEqual([]);
    });
  });
});
