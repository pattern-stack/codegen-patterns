/**
 * Unit tests for MemoryCursorStore (SYNC-3).
 *
 * Pure `bun:test` — no DI container, no Postgres. Exercises the `ICursorStore`
 * contract: round-trip put/get, null on missing, overwrite semantics, and
 * multi-subscription isolation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryCursorStore } from '../../../../runtime/subsystems/integration/integration-cursor-store.memory-backend';
import type { ICursorStore } from '../../../../runtime/subsystems/integration/integration-cursor-store.protocol';

describe('MemoryCursorStore', () => {
  let store: MemoryCursorStore;

  beforeEach(() => {
    store = new MemoryCursorStore();
  });

  describe('contract conformance', () => {
    it('implements ICursorStore structurally', () => {
      // Assignment to the port type is the structural check — if the
      // class drifts from the port, this won't compile.
      const asPort: ICursorStore = store;
      expect(typeof asPort.get).toBe('function');
      expect(typeof asPort.put).toBe('function');
    });
  });

  describe('get — missing subscription', () => {
    it('returns null when no cursor has been put', async () => {
      const result = await store.get('sub-1');
      expect(result).toBeNull();
    });

    it('returns null for a subscription that was never seen', async () => {
      await store.put('sub-1', { systemModstamp: '2026-04-01' });
      const result = await store.get('sub-2');
      expect(result).toBeNull();
    });
  });

  describe('put + get — round-trip', () => {
    it('returns the same cursor value that was put', async () => {
      const cursor = { systemModstamp: '2026-04-21T13:05:00Z' };
      await store.put('sub-1', cursor);
      const result = await store.get('sub-1');
      expect(result).toEqual(cursor);
    });

    it('accepts opaque cursor shapes (poll-style)', async () => {
      await store.put('sub-1', { systemModstamp: '2026-04-21T13:05:00Z' });
      expect(await store.get('sub-1')).toEqual({
        systemModstamp: '2026-04-21T13:05:00Z',
      });
    });

    it('accepts opaque cursor shapes (cdc-style)', async () => {
      await store.put('sub-1', { replayId: 42 });
      expect(await store.get('sub-1')).toEqual({ replayId: 42 });
    });

    it('accepts opaque cursor shapes (webhook-style)', async () => {
      await store.put('sub-1', { ts: 1_713_705_900_000 });
      expect(await store.get('sub-1')).toEqual({ ts: 1_713_705_900_000 });
    });

    it('accepts primitive cursor values', async () => {
      await store.put('sub-str', 'token-abc');
      await store.put('sub-num', 99);
      await store.put('sub-null', null);
      expect(await store.get('sub-str')).toBe('token-abc');
      expect(await store.get('sub-num')).toBe(99);
      // Explicit null is distinct from "missing" — the port treats both as
      // `null`, but the memory map distinguishes them. Exercising the
      // explicit-null path confirms `put(id, null)` then `get(id) === null`
      // does not regress to "never seen."
      expect(await store.get('sub-null')).toBeNull();
    });
  });

  describe('put — overwrite semantics', () => {
    it('overwrites prior cursor for the same subscription', async () => {
      await store.put('sub-1', { systemModstamp: '2026-04-01' });
      await store.put('sub-1', { systemModstamp: '2026-04-21' });
      expect(await store.get('sub-1')).toEqual({
        systemModstamp: '2026-04-21',
      });
    });
  });

  describe('multi-subscription isolation', () => {
    it('keeps cursors for different subscriptions independent', async () => {
      await store.put('sub-a', { systemModstamp: '2026-04-01' });
      await store.put('sub-b', { replayId: 100 });
      expect(await store.get('sub-a')).toEqual({
        systemModstamp: '2026-04-01',
      });
      expect(await store.get('sub-b')).toEqual({ replayId: 100 });
    });
  });

  describe('clear', () => {
    it('removes all cursors', async () => {
      await store.put('sub-a', { x: 1 });
      await store.put('sub-b', { y: 2 });
      store.clear();
      expect(await store.get('sub-a')).toBeNull();
      expect(await store.get('sub-b')).toBeNull();
    });

    it('allows reuse after clear (tests use in beforeEach)', async () => {
      await store.put('sub-a', { v: 1 });
      store.clear();
      await store.put('sub-a', { v: 2 });
      expect(await store.get('sub-a')).toEqual({ v: 2 });
    });
  });

  describe('cursors map — inspectable state', () => {
    it('exposes the internal map for test assertions', async () => {
      await store.put('sub-1', { systemModstamp: '2026-04-21' });
      expect(store.cursors.size).toBe(1);
      expect(store.cursors.has('sub-1')).toBe(true);
    });
  });

  describe('listAll (OBS-4)', () => {
    it('returns [] when no cursors have been put', async () => {
      expect(await store.listAll()).toEqual([]);
    });

    it('returns one snapshot per cursor, ordered by updatedAt DESC', async () => {
      await store.put('sub-a', { v: 1 });
      await store.put('sub-b', { v: 2 });
      await store.put('sub-c', { v: 3 });

      store.subscriptions.set('sub-a', {
        integrationId: 'int-a',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: null,
        updatedAt: new Date(1_000),
      });
      store.subscriptions.set('sub-b', {
        integrationId: 'int-b',
        adapter: 'hubspot',
        domain: 'contact',
        externalRef: 'filter-x',
        updatedAt: new Date(3_000),
      });
      store.subscriptions.set('sub-c', {
        integrationId: 'int-c',
        adapter: 'github',
        domain: 'issue',
        externalRef: null,
        updatedAt: new Date(2_000),
      });

      const snapshots = await store.listAll();
      expect(snapshots.map((s) => s.subscriptionId)).toEqual([
        'sub-b',
        'sub-c',
        'sub-a',
      ]);
    });

    it('emits empty metadata when no subscription is seeded', async () => {
      await store.put('sub-a', { v: 1 });
      const [snapshot] = await store.listAll();
      expect(snapshot).toEqual({
        subscriptionId: 'sub-a',
        integrationId: '',
        adapter: '',
        domain: '',
        externalRef: null,
        cursor: { v: 1 },
        lastIntegrationAt: null,
        updatedAt: new Date(0),
        tenantId: null,
      });
    });

    it('preserves seeded metadata end-to-end', async () => {
      await store.put('sub-a', { systemModstamp: '2026-04-21' });
      store.subscriptions.set('sub-a', {
        integrationId: 'int-a',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: 'filter-1',
        lastIntegrationAt: new Date(4_000),
        updatedAt: new Date(5_000),
      });

      const [snapshot] = await store.listAll();
      expect(snapshot).toEqual({
        subscriptionId: 'sub-a',
        integrationId: 'int-a',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: 'filter-1',
        cursor: { systemModstamp: '2026-04-21' },
        lastIntegrationAt: new Date(4_000),
        updatedAt: new Date(5_000),
        tenantId: null,
      });
    });

    it('ignores tenantId (memory backend does not filter on it)', async () => {
      await store.put('sub-a', { v: 1 });
      await store.put('sub-b', { v: 2 });

      const snapshots = await store.listAll('tenant-a');
      expect(snapshots).toHaveLength(2);
    });

    it('clear() wipes subscriptions metadata too', async () => {
      await store.put('sub-a', { v: 1 });
      store.subscriptions.set('sub-a', {
        integrationId: 'int-a',
        adapter: 'salesforce',
        domain: 'opportunity',
        externalRef: null,
        updatedAt: new Date(1_000),
      });

      store.clear();

      expect(store.subscriptions.size).toBe(0);
      expect(await store.listAll()).toEqual([]);
    });
  });
});
