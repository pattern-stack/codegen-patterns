/**
 * BullMQ backend unit tests (BULLMQ-1, Phase 2).
 *
 * These cover the parts that DO NOT require a live Redis/Valkey:
 *   - `sha1JobId` — colon-safe, stable derivation (spec §Gotcha 1).
 *   - `resolveBullMqConfig` — redis_url / env / default precedence + bull_board.
 *   - `resolvePoolQueueName` — pool→queue alias + prefix.
 *   - DI wiring: `JobsDomainModule.forRoot({ backend: 'bullmq' })` resolves
 *     `BullMQJobOrchestrator` for `JOB_ORCHESTRATOR` and keeps the Drizzle
 *     run/step services. Constructing the orchestrator does NOT open a Redis
 *     connection (BullMQ connects lazily on first `queue.add`), so this is
 *     safe without a broker.
 *
 * The behavioural claim/dispatch path (start → queue.add → worker → complete)
 * is the port-promotion gate that requires Redis up; it runs in CI/local with
 * a broker (see docs/specs/BULLMQ-1.md §Verification). It is deliberately NOT
 * faked here.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  BULLMQ_CONNECTION,
  BULLMQ_RESOLVED_CONFIG,
  BullMQJobOrchestrator,
  resolveBullMqConfig,
  resolvePoolQueueName,
  sha1JobId,
} from '../../../../runtime/subsystems/jobs';
import { JobsDomainModule } from '../../../../runtime/subsystems/jobs/jobs-domain.module';
import { JOB_ORCHESTRATOR } from '../../../../runtime/subsystems/jobs/jobs-domain.tokens';
import { DrizzleJobRunService } from '../../../../runtime/subsystems/jobs/job-run-service.drizzle-backend';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
import {
  FRAMEWORK_POOLS,
  loadPoolConfig,
  _resetPoolConfigCacheForTests,
} from '../../../../runtime/subsystems/jobs/pool-config.loader';

afterEach(() => {
  _resetPoolConfigCacheForTests();
  delete process.env.REDIS_URL;
});

// ─── sha1JobId (spec §Gotcha 1) ──────────────────────────────────────────────

describe('sha1JobId', () => {
  it('is colon-safe even for vendor:externalId-shaped keys', () => {
    const id = sha1JobId('salesforce:0061t00000abcDE');
    expect(id).not.toContain(':');
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is stable — same logical key maps to the same id (dedup primitive)', () => {
    expect(sha1JobId('account:123')).toBe(sha1JobId('account:123'));
  });

  it('distinct keys map to distinct ids', () => {
    expect(sha1JobId('account:1')).not.toBe(sha1JobId('account:2'));
  });
});

// ─── resolveBullMqConfig ─────────────────────────────────────────────────────

describe('resolveBullMqConfig', () => {
  it('prefers explicit redis_url', () => {
    const cfg = resolveBullMqConfig({ redis_url: 'redis://explicit:6380' });
    expect((cfg.connection as { url: string }).url).toBe('redis://explicit:6380');
  });

  it('falls back to process.env.REDIS_URL', () => {
    process.env.REDIS_URL = 'redis://from-env:6381';
    const cfg = resolveBullMqConfig(undefined);
    expect((cfg.connection as { url: string }).url).toBe('redis://from-env:6381');
  });

  it('defaults to localhost when neither is set', () => {
    const cfg = resolveBullMqConfig(undefined);
    expect((cfg.connection as { url: string }).url).toBe('redis://localhost:6379');
  });

  it('carries queue_prefix through', () => {
    const cfg = resolveBullMqConfig({ queue_prefix: 'myapp' });
    expect(cfg.queuePrefix).toBe('myapp');
  });

  it('resolves bull_board with default mount path when enabled', () => {
    const cfg = resolveBullMqConfig({ bull_board: { enabled: true } });
    expect(cfg.bullBoard).toEqual({ enabled: true, mountPath: '/admin/queues' });
  });

  it('honours explicit bull_board.mount_path', () => {
    const cfg = resolveBullMqConfig({
      bull_board: { enabled: true, mount_path: '/api/admin/queues' },
    });
    expect(cfg.bullBoard?.mountPath).toBe('/api/admin/queues');
  });

  it('omits bullBoard when disabled', () => {
    const cfg = resolveBullMqConfig({ bull_board: { enabled: false } });
    expect(cfg.bullBoard).toBeUndefined();
  });
});

// ─── resolvePoolQueueName ────────────────────────────────────────────────────

describe('resolvePoolQueueName', () => {
  it('maps a logical pool name to its queue alias', () => {
    const poolConfig = loadPoolConfig();
    expect(resolvePoolQueueName('batch', null, poolConfig)).toBe(
      FRAMEWORK_POOLS.batch!.queue,
    );
  });

  it('applies the queue_prefix namespace', () => {
    const poolConfig = loadPoolConfig();
    const cfg = resolveBullMqConfig({ queue_prefix: 'myapp' });
    expect(resolvePoolQueueName('batch', cfg, poolConfig)).toBe(
      `myapp:${FRAMEWORK_POOLS.batch!.queue}`,
    );
  });

  it('falls back to the logical name for an unknown pool', () => {
    const poolConfig = loadPoolConfig();
    expect(resolvePoolQueueName('unknown_pool', null, poolConfig)).toBe(
      'unknown_pool',
    );
  });
});

// ─── DI wiring: JobsDomainModule.forRoot({ backend: 'bullmq' }) ──────────────

describe('JobsDomainModule.forRoot({ backend: "bullmq" })', () => {
  it('resolves BullMQJobOrchestrator and Drizzle run service; binds connection token', async () => {
    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: {} }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        JobsDomainModule.forRoot({
          backend: 'bullmq',
          extensions: { bullmq: { redis_url: 'redis://localhost:6399' } },
        }),
      ],
    }).compile();

    // Orchestrator is the BullMQ backend (constructing it does NOT connect).
    expect(moduleRef.get(JOB_ORCHESTRATOR)).toBeInstanceOf(BullMQJobOrchestrator);
    // Run service stays Drizzle — listForScope is an unchanged Postgres query.
    const { JOB_RUN_SERVICE } = await import(
      '../../../../runtime/subsystems/jobs/jobs-domain.tokens'
    );
    expect(moduleRef.get(JOB_RUN_SERVICE)).toBeInstanceOf(DrizzleJobRunService);
    // Connection token is bound + resolved from the extension block.
    expect((moduleRef.get(BULLMQ_CONNECTION) as { url: string }).url).toBe(
      'redis://localhost:6399',
    );
    expect(moduleRef.get(BULLMQ_RESOLVED_CONFIG)).toBeDefined();

    await moduleRef.close();
  });

  it('does NOT export the BullMQ tokens for the drizzle backend', () => {
    const dyn = JobsDomainModule.forRoot({ backend: 'drizzle' });
    expect(dyn.exports).not.toContain(BULLMQ_CONNECTION);
  });
});

// ─── Optional-peer lazy-import guard (boot-crash regression) ─────────────────
//
// `bullmq` is an OPTIONAL peer dep. `jobs-domain.module.ts` STATICALLY imports
// the BullMQ backend files, so a drizzle-only consumer who didn't install
// bullmq loads them at module-eval. A top-level VALUE import of 'bullmq' would
// resolve eagerly → MODULE_NOT_FOUND boot crash. These tests pin the fix:
// the backend files must only `import type` from 'bullmq', and constructing
// the orchestrator must not load the package.
describe('BullMQ backend — optional-peer lazy import (boot-crash regression)', () => {
  const backendFiles = [
    'job-orchestrator.bullmq-backend.ts',
    'job-worker.bullmq-backend.ts',
  ];

  for (const file of backendFiles) {
    it(`${file} has ZERO top-level value imports of 'bullmq' (type-only)`, () => {
      const src = readFileSync(
        join(
          import.meta.dir,
          '../../../../runtime/subsystems/jobs',
          file,
        ),
        'utf8',
      );
      const bullmqImportLines = src
        .split('\n')
        .filter((l) => /from\s+['"]bullmq['"]/.test(l));
      // Every static import of 'bullmq' must be `import type` — value
      // constructors are loaded via `await import('bullmq')` only.
      expect(bullmqImportLines.length).toBeGreaterThan(0);
      for (const line of bullmqImportLines) {
        expect(line.trimStart().startsWith('import type')).toBe(true);
      }
    });
  }

  it('constructing BullMQJobOrchestrator does not load bullmq (ctors stay unloaded)', async () => {
    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: {} }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        JobsDomainModule.forRoot({ backend: 'bullmq' }),
      ],
    }).compile();

    const orch = moduleRef.get(JOB_ORCHESTRATOR) as BullMQJobOrchestrator & {
      QueueCtor: unknown;
      FlowProducerCtor: unknown;
    };
    // The lazy ctors are only populated on first dispatch/cancel — never at
    // construction. (If they were eager, a drizzle-only consumer without
    // bullmq installed would crash at boot.)
    expect(orch.QueueCtor).toBeNull();
    expect(orch.FlowProducerCtor).toBeNull();

    await moduleRef.close();
  });

  it('drizzle JobsDomainModule.forRoot boots with no DRIZZLE-coupled bullmq dependency', async () => {
    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: {} }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    // The drizzle path must construct cleanly — it statically imports the
    // bullmq backend file (which only `import type`s bullmq) without ever
    // touching the package.
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDrizzleModule, JobsDomainModule.forRoot({ backend: 'drizzle' })],
    }).compile();
    expect(moduleRef.get(JOB_ORCHESTRATOR)).toBeDefined();
    await moduleRef.close();
  });
});
