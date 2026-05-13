/**
 * MemoryOAuthStateStore — generate / single-use consume / replay / TTL.
 */
import { describe, it, expect } from 'bun:test';
import { MemoryOAuthStateStore } from '../../../../../runtime/subsystems/auth/backends/state-store.memory-backend';
import { OAuthStateError } from '../../../../../runtime/subsystems/auth/protocols/oauth-state-store';

describe('MemoryOAuthStateStore', () => {
  it('generate → consume round-trips the record', async () => {
    const store = new MemoryOAuthStateStore();
    const state = await store.generate({ userId: 'u-1', redirect: '/done' });
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(20);
    const record = await store.consume(state);
    expect(record).toEqual({ userId: 'u-1', redirect: '/done' });
  });

  it('preserves an absent redirect', async () => {
    const store = new MemoryOAuthStateStore();
    const state = await store.generate({ userId: 'u-2' });
    const record = await store.consume(state);
    expect(record.userId).toBe('u-2');
    expect(record.redirect).toBeUndefined();
  });

  it('throws OAuthStateError on replay', async () => {
    const store = new MemoryOAuthStateStore();
    const state = await store.generate({ userId: 'u-3' });
    await store.consume(state);
    await expect(store.consume(state)).rejects.toBeInstanceOf(OAuthStateError);
  });

  it('throws OAuthStateError for unknown state', async () => {
    const store = new MemoryOAuthStateStore();
    let caught: unknown;
    try {
      await store.consume('never-issued');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthStateError);
    expect((caught as OAuthStateError).reason).toBe('missing');
  });

  it('throws OAuthStateError on expiry', async () => {
    let now = 1_000;
    const store = new MemoryOAuthStateStore({ ttlMs: 500, now: () => now });
    const state = await store.generate({ userId: 'u-4' });
    now += 1_000; // advance past TTL
    let caught: unknown;
    try {
      await store.consume(state);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthStateError);
    expect((caught as OAuthStateError).reason).toBe('expired');
  });

  it('issues distinct tokens for distinct generate calls', async () => {
    const store = new MemoryOAuthStateStore();
    const a = await store.generate({ userId: 'u' });
    const b = await store.generate({ userId: 'u' });
    expect(a).not.toBe(b);
  });
});
