/**
 * Unit tests for MemoryCursorStore (SYNC-3).
 *
 * Pure `bun:test` — no DI container, no Postgres. Exercises the `ICursorStore`
 * contract: round-trip put/get, null on missing, overwrite semantics, and
 * multi-subscription isolation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryCursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.memory-backend';
import type { ICursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.protocol';

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
});
