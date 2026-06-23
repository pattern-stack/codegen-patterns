/**
 * BullMQ event scheduler driver — wiring + optional-peer guard (BULLMQ-2, ADR-041).
 *
 * ADR-041 option #2: the event bus stays Drizzle (no bespoke BullMQ event bus).
 * BullMQ's events role is the SCHEDULER clock, selected by
 * `events.scheduler.driver: 'bullmq'`, implemented in the lazily-loaded
 * `event-scheduler.bullmq-backend.ts`. These pin:
 *   - the scheduler file only `import type`s from 'bullmq' (no eager value import);
 *   - `forRoot({ scheduler: { driver: 'bullmq' } })` wires the dispatcher +
 *     resolves EVENTS_BULLMQ_CONNECTION WITHOUT loading bullmq (lazy at boot);
 *   - the connection resolves from redisUrl → REDIS_URL env → localhost.
 * The broker behaviour (a tick firing) is covered by the Docker-gated
 * test/integration/bullmq.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventsModule, EventSchedulerLifecycle } from '../../../../runtime/subsystems/events/events.module';
import { EVENTS_BULLMQ_CONNECTION } from '../../../../runtime/subsystems/events/events.tokens';
import { DRIZZLE } from '../../../../runtime/constants/tokens';

const BACKEND_FILE = 'event-scheduler.bullmq-backend.ts';

@Global()
@Module({
  providers: [{ provide: DRIZZLE, useValue: {} }],
  exports: [DRIZZLE],
})
class FakeDrizzleModule {}

describe('BullMQ event scheduler — optional-peer lazy import', () => {
  it(`${BACKEND_FILE} has ZERO top-level value imports of 'bullmq' (type-only)`, () => {
    const src = readFileSync(
      join(import.meta.dir, '../../../../runtime/subsystems/events', BACKEND_FILE),
      'utf8',
    );
    const bullmqImportLines = src
      .split('\n')
      .filter((l) => /from\s+['"]bullmq['"]/.test(l));
    expect(bullmqImportLines.length).toBeGreaterThan(0);
    for (const line of bullmqImportLines) {
      expect(line.trimStart().startsWith('import type')).toBe(true);
    }
  });

  it('events.module.ts does NOT statically import the bullmq scheduler file (lazy only)', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../../../runtime/subsystems/events/events.module.ts'),
      'utf8',
    );
    // A static `from './event-scheduler.bullmq-backend'` would force a drizzle/
    // poll consumer's tsc to resolve the pruned file. It must be reached only
    // through the non-literal dynamic import in `loadBullMqScheduler`.
    const staticImport = /^\s*import .*from\s+['"]\.\/event-scheduler\.bullmq-backend['"]/m;
    expect(staticImport.test(src)).toBe(false);
  });
});

describe('EventsModule scheduler driver wiring', () => {
  it('scheduler.driver=bullmq resolves EVENTS_BULLMQ_CONNECTION + registers the dispatcher, without connecting', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        EventsModule.forRoot({
          backend: 'drizzle',
          scheduler: { driver: 'bullmq' },
          redisUrl: 'redis://sched-host:6395/1',
          // No eventRegistry → onApplicationBootstrap (not called by compile) is a
          // no-op anyway; we only assert the wiring here.
        }),
      ],
    }).compile();

    // The connection token resolves (the scheduler driver uses it).
    expect((moduleRef.get(EVENTS_BULLMQ_CONNECTION) as { url: string }).url).toBe(
      'redis://sched-host:6395/1',
    );
    // The dispatcher is registered; it lazy-loads the bullmq scheduler only at
    // onApplicationBootstrap (not at compile), so no Redis connection opens here.
    expect(moduleRef.get(EventSchedulerLifecycle)).toBeInstanceOf(EventSchedulerLifecycle);

    await moduleRef.close();
  });

  it('poll driver (default) still registers the dispatcher + a (harmless) connection token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDrizzleModule, EventsModule.forRoot({ backend: 'drizzle' })],
    }).compile();
    expect(moduleRef.get(EventSchedulerLifecycle)).toBeInstanceOf(EventSchedulerLifecycle);
    // Connection token defaults to localhost (harmless; only used by the bullmq driver).
    expect((moduleRef.get(EVENTS_BULLMQ_CONNECTION) as { url: string }).url).toBe(
      'redis://localhost:6379',
    );
    await moduleRef.close();
  });
});
