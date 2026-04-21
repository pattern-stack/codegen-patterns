/**
 * InMemoryOAuthStateStore — put / single-use consume / TTL expiry.
 */
import { describe, it, expect } from 'bun:test';
import { InMemoryOAuthStateStore } from '../../../../../runtime/subsystems/auth/backends/oauth-state-store/in-memory';

describe('InMemoryOAuthStateStore', () => {
  it('returns the entry on consume', async () => {
    const store = new InMemoryOAuthStateStore();
    const createdAt = new Date();
    await store.put('state-1', { userId: 'user-1', createdAt });
    const entry = await store.consume('state-1');
    expect(entry?.userId).toBe('user-1');
  });

  it('consume is single-use', async () => {
    const store = new InMemoryOAuthStateStore();
    await store.put('state-2', { userId: 'user-2', createdAt: new Date() });
    const first = await store.consume('state-2');
    const second = await store.consume('state-2');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('returns null for unknown state', async () => {
    const store = new InMemoryOAuthStateStore();
    expect(await store.consume('unknown')).toBeNull();
  });

  it('expires entries past the TTL', async () => {
    let now = 1_000;
    const store = new InMemoryOAuthStateStore({ ttlMs: 500, now: () => now });
    await store.put('state-ttl', { userId: 'u', createdAt: new Date(now) });
    now += 1_000; // advance beyond ttl
    expect(await store.consume('state-ttl')).toBeNull();
  });
});
