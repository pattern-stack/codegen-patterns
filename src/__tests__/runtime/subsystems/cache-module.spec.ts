/**
 * CacheModule unit tests.
 *
 * Covers the `forRoot` + `forRootAsync` factories. Memory backend goes
 * end-to-end against `MemoryCacheService`; the drizzle backend is
 * asserted structurally with a mock DRIZZLE provider (no Postgres
 * required).
 *
 * Regression test for issue #108 (surfaced during the fix for
 * `EventsModule.forRootAsync`): the cache module's async factory used
 * to hand-construct `DrizzleCacheService` with a literal `null` for the
 * DRIZZLE client, which would NRE on the first call. The factory now
 * routes DRIZZLE through Nest DI.
 */
import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { CacheModule } from '../../../../runtime/subsystems/cache/cache.module';
import { CACHE } from '../../../../runtime/subsystems/cache/cache.tokens';
import { DrizzleCacheService } from '../../../../runtime/subsystems/cache/cache.drizzle-backend';
import { MemoryCacheService } from '../../../../runtime/subsystems/cache/cache.memory-backend';
import { DRIZZLE } from '../../../../runtime/constants/tokens';

describe('CacheModule.forRoot', () => {
  it('resolves CACHE to MemoryCacheService for backend: memory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(CACHE)).toBeInstanceOf(MemoryCacheService);

    await moduleRef.close();
  });

  it('forRoot returns a global DynamicModule', () => {
    const dyn = CacheModule.forRoot({ backend: 'memory' });
    expect(dyn.global).toBe(true);
    expect(dyn.exports).toContain(CACHE);
  });
});

describe('CacheModule.forRootAsync — DI for backend constructor args (#108)', () => {
  /**
   * Minimal Drizzle-shaped mock. `DrizzleCacheService.get()` path is not
   * exercised here; we only need `set()` to reach `db.insert(...)`.
   */
  function makeMockDb() {
    const insertBuilder = {
      values: mock(() => ({
        onConflictDoUpdate: mock(async () => []),
      })),
    };
    const db = {
      insert: mock(() => insertBuilder),
    };
    return { db, insertBuilder };
  }

  it('resolves CACHE to MemoryCacheService from an async factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CacheModule.forRootAsync({
          useFactory: () => ({ backend: 'memory', defaultTtl: 60 }),
        }),
      ],
    }).compile();

    expect(moduleRef.get(CACHE)).toBeInstanceOf(MemoryCacheService);

    await moduleRef.close();
  });

  it('resolves DRIZZLE through DI for the drizzle backend (regression: used to pass null)', async () => {
    const { db, insertBuilder } = makeMockDb();

    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: db }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        CacheModule.forRootAsync({
          useFactory: () => ({ backend: 'drizzle', defaultTtl: 60 }),
        }),
      ],
    }).compile();

    const cache = moduleRef.get(CACHE);
    expect(cache).toBeInstanceOf(DrizzleCacheService);

    // Prove set() reached the injected mock DB. Pre-fix the constructor
    // was called with `null as unknown as ...` for the db argument, so
    // this would throw "Cannot read properties of null (reading 'insert')".
    await (cache as DrizzleCacheService).set('k', { hello: 'world' });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertBuilder.values).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  it('throws a clear error when the drizzle backend is selected but DRIZZLE is not provided', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          CacheModule.forRootAsync({
            useFactory: () => ({ backend: 'drizzle' }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/DRIZZLE provider is not available/);
  });
});
