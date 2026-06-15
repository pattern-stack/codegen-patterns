/**
 * BullMQEventBus — wiring + optional-peer lazy-import guard (BULLMQ-2, ADR-041).
 *
 * `bullmq` is an OPTIONAL peer dep. The events backend file is filtered out of
 * non-bullmq installs and lazy-loaded via `EventsModule.forRoot({ backend:
 * 'bullmq' })` → `loadBullMqEventBus()` (dynamic import), so a drizzle/memory
 * consumer who never installed bullmq never resolves it. These tests pin:
 *   - the backend file only `import type`s from 'bullmq' (no eager value import);
 *   - `forRoot({ backend: 'bullmq' })` builds + DI-constructs the bus WITHOUT
 *     loading the bullmq value ctors or opening a Redis connection;
 *   - the connection resolves from `redisUrl` → `REDIS_URL` env → localhost.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventsModule } from '../../../../runtime/subsystems/events/events.module';
import { EVENT_BUS, EVENT_READ_PORT } from '../../../../runtime/subsystems/events/events.tokens';
import { DRIZZLE } from '../../../../runtime/constants/tokens';

const BACKEND_FILE = 'event-bus.bullmq-backend.ts';

@Global()
@Module({
  providers: [{ provide: DRIZZLE, useValue: {} }],
  exports: [DRIZZLE],
})
class FakeDrizzleModule {}

describe('BullMQEventBus — optional-peer lazy import (boot-crash regression)', () => {
  it(`${BACKEND_FILE} has ZERO top-level value imports of 'bullmq' (type-only)`, () => {
    const src = readFileSync(
      join(import.meta.dir, '../../../../runtime/subsystems/events', BACKEND_FILE),
      'utf8',
    );
    const bullmqImportLines = src
      .split('\n')
      .filter((l) => /from\s+['"]bullmq['"]/.test(l));
    // Every static import of 'bullmq' must be `import type` — value
    // constructors load via `await import('bullmq')` only.
    expect(bullmqImportLines.length).toBeGreaterThan(0);
    for (const line of bullmqImportLines) {
      expect(line.trimStart().startsWith('import type')).toBe(true);
    }
  });

  it('forRoot({ backend: bullmq }) DI-constructs the bus without loading bullmq ctors or connecting', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        EventsModule.forRoot({ backend: 'bullmq', redisUrl: 'redis://test-host:6390/2' }),
      ],
    }).compile();

    const bus = moduleRef.get(EVENT_BUS) as {
      constructor: { name: string };
      QueueCtor: unknown;
      WorkerCtor: unknown;
      conn: { url: string };
    };
    expect(bus.constructor.name).toBe('BullMQEventBus');
    // Lazy ctors are populated only in onModuleInit / first enqueue — never at
    // construction. `.compile()` does not run lifecycle hooks, so they stay null
    // (a drizzle/memory consumer without bullmq installed would crash at boot if
    // these were eager).
    expect(bus.QueueCtor).toBeNull();
    expect(bus.WorkerCtor).toBeNull();
    // Connection resolved from the explicit redisUrl.
    expect(bus.conn.url).toBe('redis://test-host:6390/2');

    // The bullmq backend keeps the Postgres outbox → it DOES provide a read
    // port (unlike the deleted redis pub/sub backend).
    expect(moduleRef.get(EVENT_READ_PORT)).toBe(moduleRef.get(EVENT_BUS));

    await moduleRef.close();
  });

  it('connection falls back to REDIS_URL env, then localhost', async () => {
    const prev = process.env['REDIS_URL'];
    try {
      process.env['REDIS_URL'] = 'redis://from-env:6399';
      const m1 = await Test.createTestingModule({
        imports: [FakeDrizzleModule, EventsModule.forRoot({ backend: 'bullmq' })],
      }).compile();
      expect((m1.get(EVENT_BUS) as { conn: { url: string } }).conn.url).toBe(
        'redis://from-env:6399',
      );
      await m1.close();

      delete process.env['REDIS_URL'];
      const m2 = await Test.createTestingModule({
        imports: [FakeDrizzleModule, EventsModule.forRoot({ backend: 'bullmq' })],
      }).compile();
      expect((m2.get(EVENT_BUS) as { conn: { url: string } }).conn.url).toBe(
        'redis://localhost:6379',
      );
      await m2.close();
    } finally {
      if (prev === undefined) delete process.env['REDIS_URL'];
      else process.env['REDIS_URL'] = prev;
    }
  });
});
