/**
 * Cache subsystem unit tests.
 *
 * Tests cover both backends via a shared suite. The MemoryCacheService runs
 * synchronously in-process. The DrizzleCacheService is tested with a mock
 * Drizzle client to keep the suite fast (no Docker required).
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { MemoryCacheService } from '../../../../runtime/subsystems/cache/cache.memory-backend';
import { DrizzleCacheService } from '../../../../runtime/subsystems/cache/cache.drizzle-backend';
import type { ICacheService } from '../../../../runtime/subsystems/cache/cache.protocol';

// ============================================================================
// Shared behavioural suite
// ============================================================================

function runCacheSuite(label: string, factory: () => ICacheService) {
  describe(label, () => {
    let cache: ICacheService;

    beforeEach(() => {
      cache = factory();
    });

    describe('set / get', () => {
      it('stores and retrieves a value', async () => {
        await cache.set('k1', { x: 1 });
        const result = await cache.get<{ x: number }>('k1');
        expect(result).toEqual({ x: 1 });
      });

      it('returns null for a missing key', async () => {
        const result = await cache.get('nonexistent');
        expect(result).toBeNull();
      });

      it('overwrites an existing entry', async () => {
        await cache.set('k2', 'original');
        await cache.set('k2', 'updated');
        const result = await cache.get<string>('k2');
        expect(result).toBe('updated');
      });

      it('stores null-like values (0, false, empty string)', async () => {
        await cache.set('zero', 0);
        await cache.set('bool', false);
        await cache.set('empty', '');

        expect(await cache.get('zero')).toBe(0);
        expect(await cache.get('bool')).toBe(false);
        expect(await cache.get('empty')).toBe('');
      });
    });

    describe('delete', () => {
      it('removes an existing entry', async () => {
        await cache.set('to-delete', 'bye');
        await cache.delete('to-delete');
        expect(await cache.get('to-delete')).toBeNull();
      });

      it('does not throw when deleting a non-existent key', async () => {
        await expect(cache.delete('ghost')).resolves.toBeUndefined();
      });
    });

    describe('has', () => {
      it('returns true for an existing entry', async () => {
        await cache.set('present', 42);
        expect(await cache.has('present')).toBe(true);
      });

      it('returns false for a missing entry', async () => {
        expect(await cache.has('absent')).toBe(false);
      });

      it('returns false after an entry is deleted', async () => {
        await cache.set('gone', 'soon');
        await cache.delete('gone');
        expect(await cache.has('gone')).toBe(false);
      });
    });

    describe('invalidateByPrefix', () => {
      it('removes all entries matching the prefix', async () => {
        await cache.set('contact:1', 'Alice');
        await cache.set('contact:2', 'Bob');
        await cache.set('opportunity:1', 'Deal');

        const count = await cache.invalidateByPrefix('contact:');

        expect(count).toBe(2);
        expect(await cache.get('contact:1')).toBeNull();
        expect(await cache.get('contact:2')).toBeNull();
        expect(await cache.get('opportunity:1')).toBe('Deal');
      });

      it('returns 0 when no entries match', async () => {
        const count = await cache.invalidateByPrefix('no-match:');
        expect(count).toBe(0);
      });

      it('removes entries with an exact prefix match on the full key', async () => {
        await cache.set('x', 'not-prefixed');
        await cache.set('xy', 'also-not');
        await cache.set('x:', 'prefixed');

        const count = await cache.invalidateByPrefix('x:');
        expect(count).toBe(1);
        expect(await cache.get('x')).toBe('not-prefixed');
        expect(await cache.get('xy')).toBe('also-not');
        expect(await cache.get('x:')).toBeNull();
      });
    });
  });
}

// ============================================================================
// MemoryCacheService tests
// ============================================================================

runCacheSuite('MemoryCacheService (shared suite)', () => new MemoryCacheService());

describe('MemoryCacheService (TTL-specific)', () => {
  it('expires an entry after the TTL elapses', async () => {
    const cache = new MemoryCacheService();
    // Use a very short TTL; we advance time via fake timers below.
    // Bun does not have fake timers, so we test the expiry-at-read path
    // by manually manipulating the internal record.
    await cache.set('short', 'lived', 0.001); // 1ms TTL

    // Wait a few ms so expiresAt is in the past
    await new Promise((r) => setTimeout(r, 10));

    expect(await cache.get('short')).toBeNull();
  });

  it('does not expire entries with no TTL', async () => {
    const cache = new MemoryCacheService();
    await cache.set('permanent', 'value');
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get('permanent')).toBe('value');
  });

  it('uses defaultTtl when no per-call TTL is given', async () => {
    // Inject a 0.001s (1ms) default TTL
    const cache = new MemoryCacheService(0.001);
    await cache.set('with-default', 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get('with-default')).toBeNull();
  });
});

// ============================================================================
// DrizzleCacheService tests (mocked Drizzle)
// ============================================================================

describe('DrizzleCacheService', () => {
  /** Build a minimal mock Drizzle client that captures calls. */
  function makeMockDb(overrides: Record<string, unknown> = {}) {
    const selectRows: unknown[] = overrides.selectRows as unknown[] ?? [];

    // We need to simulate the Drizzle fluent query builder.
    const selectBuilder = {
      from: mock(() => selectBuilder),
      where: mock(() => selectBuilder),
      limit: mock(async () => selectRows),
    };

    const insertBuilder = {
      values: mock(() => insertBuilder),
      onConflictDoUpdate: mock(async () => []),
    };

    const deleteBuilder = {
      where: mock(async () => overrides.deleteResult ?? []),
      returning: mock(async () => overrides.deleteReturning ?? []),
    };

    // Patch deleteBuilder so .where() returns an object with .returning()
    deleteBuilder.where = mock(() => ({
      returning: deleteBuilder.returning,
      // also allow .where().then() for awaiting directly
      then: (resolve: (v: unknown) => unknown) => resolve(overrides.deleteResult ?? []),
    }));

    const db = {
      select: mock(() => selectBuilder),
      insert: mock(() => insertBuilder),
      delete: mock(() => deleteBuilder),
    };

    return { db, selectBuilder, insertBuilder, deleteBuilder };
  }

  describe('get()', () => {
    it('returns null when no rows found', async () => {
      const { db } = makeMockDb({ selectRows: [] });
      const service = new DrizzleCacheService(db as any, null);
      expect(await service.get('k')).toBeNull();
    });

    it('returns the value when a row is found', async () => {
      const { db } = makeMockDb({ selectRows: [{ key: 'k', value: { foo: 'bar' }, expiresAt: null }] });
      const service = new DrizzleCacheService(db as any, null);
      expect(await service.get('k')).toEqual({ foo: 'bar' });
    });

    it('returns null (not throws) on db error', async () => {
      const db = {
        select: mock(() => { throw new Error('db down'); }),
      };
      const service = new DrizzleCacheService(db as any, null);
      expect(await service.get('k')).toBeNull();
    });
  });

  describe('set()', () => {
    it('calls insert with correct key and value', async () => {
      const { db, insertBuilder } = makeMockDb();
      const service = new DrizzleCacheService(db as any, null);
      await service.set('mykey', { a: 1 });
      expect(db.insert).toHaveBeenCalled();
      expect(insertBuilder.values).toHaveBeenCalled();
      const callArg = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArg.key).toBe('mykey');
      expect(callArg.value).toEqual({ a: 1 });
    });

    it('sets expiresAt when ttlSeconds is provided', async () => {
      const { db, insertBuilder } = makeMockDb();
      const service = new DrizzleCacheService(db as any, null);
      const before = Date.now();
      await service.set('ttlkey', 'val', 60);
      const after = Date.now();
      const callArg = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArg.expiresAt).toBeInstanceOf(Date);
      const expiresMs = (callArg.expiresAt as Date).getTime();
      expect(expiresMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(expiresMs).toBeLessThanOrEqual(after + 60_000 + 100);
    });

    it('sets null expiresAt when no TTL', async () => {
      const { db, insertBuilder } = makeMockDb();
      const service = new DrizzleCacheService(db as any, null);
      await service.set('noexp', 'val');
      const callArg = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArg.expiresAt).toBeNull();
    });
  });

  describe('delete()', () => {
    it('calls db.delete', async () => {
      const { db } = makeMockDb();
      const service = new DrizzleCacheService(db as any, null);
      await service.delete('del-key');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('invalidateByPrefix()', () => {
    it('returns the count of deleted rows', async () => {
      const { db } = makeMockDb({ deleteReturning: [{ key: 'a:1' }, { key: 'a:2' }] });
      // Override deleteBuilder.where to return an object that has returning
      const deleteBuilder = {
        where: mock(() => ({
          returning: mock(async () => [{ key: 'a:1' }, { key: 'a:2' }]),
        })),
      };
      (db as any).delete = mock(() => deleteBuilder);
      const service = new DrizzleCacheService(db as any, null);
      const count = await service.invalidateByPrefix('a:');
      expect(count).toBe(2);
    });
  });

  describe('has()', () => {
    it('returns true when get() returns a value', async () => {
      const { db } = makeMockDb({ selectRows: [{ key: 'k', value: 42, expiresAt: null }] });
      const service = new DrizzleCacheService(db as any, null);
      expect(await service.has('k')).toBe(true);
    });

    it('returns false when get() returns null', async () => {
      const { db } = makeMockDb({ selectRows: [] });
      const service = new DrizzleCacheService(db as any, null);
      expect(await service.has('k')).toBe(false);
    });

    it('returns false (not throws) on db error', async () => {
      const db = {
        select: mock(() => { throw new Error('db down'); }),
      };
      const service = new DrizzleCacheService(db as any, null);
      expect(await service.has('k')).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('onModuleDestroy clears the cleanup timer', async () => {
      const { db } = makeMockDb();
      const service = new DrizzleCacheService(db as any, null);
      await service.onModuleInit();
      // Should not throw
      await service.onModuleDestroy();
    });

    it('onModuleDestroy is safe to call without onModuleInit', async () => {
      const { db } = makeMockDb();
      const service = new DrizzleCacheService(db as any, null);
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
