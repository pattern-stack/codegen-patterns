/**
 * JobWorkerModule unit tests (JOB-5).
 *
 * Covers the order-critical `onModuleInit` sequence:
 *   1. pool config load
 *   2. registry snapshot
 *   3. reserved-pool violation check  ← throws ReservedPoolViolationError
 *   4. orchestrator.upsertJobRows     ← memory + Drizzle (mocked)
 *   5. boot validator (Drizzle only)  ← throws BootValidationError
 *   6. spawn workers via workerFactory stub
 *
 * Plus pool-config behaviour (CFG-1): defaults, override merge, and the
 * pool rules (framework `queue`/`reserved` fixed, user pools need `queue` +
 * `concurrency`, `reserved` is framework-only).
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import {
  JobHandler,
  JobHandlerBase,
  JOB_HANDLER_REGISTRY,
  type JobContext,
} from '../../../../runtime/subsystems/jobs/job-handler.base';
import {
  JobWorkerModule,
  JobWorkerOrchestrator,
} from '../../../../runtime/subsystems/jobs/job-worker.module';
import { JobsDomainModule } from '../../../../runtime/subsystems/jobs/jobs-domain.module';
import {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
} from '../../../../runtime/subsystems/jobs/jobs-domain.tokens';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
import {
  BootValidationError,
  ReservedPoolViolationError,
} from '../../../../runtime/subsystems/jobs/jobs-errors';
import {
  FRAMEWORK_POOLS,
  RESERVED_POOL_NAMES,
  allNonReservedPoolNames,
  allPoolNames,
  poolOverrideIssues,
  resolvePoolConfig,
} from '../../../../runtime/subsystems/jobs/pool-config';
import type {
  IJobOrchestrator,
  JobUpsertEntry,
  JobPoolDef,
} from '../../../../runtime/subsystems/jobs/job-orchestrator.protocol';

// ─── Test scaffolding ───────────────────────────────────────────────────────

/** Stub worker — counts lifecycle calls so we can assert ordering. */
class StubWorker {
  initCalled = 0;
  destroyCalled = 0;
  onModuleInit(): void {
    this.initCalled += 1;
  }
  async onModuleDestroy(): Promise<void> {
    this.destroyCalled += 1;
  }
}

const TEST_TYPES = new Set<string>();
function registerTestType(type: string): string {
  TEST_TYPES.add(type);
  return type;
}

afterEach(() => {
  for (const t of TEST_TYPES) JOB_HANDLER_REGISTRY.delete(t);
  TEST_TYPES.clear();
});

// ─── pool-config ────────────────────────────────────────────────────────────

describe('resolvePoolConfig (CFG-1)', () => {
  it('returns the five framework defaults with no overrides', () => {
    const config = resolvePoolConfig();
    expect(config.size).toBe(5);
    for (const name of Object.keys(FRAMEWORK_POOLS)) {
      const def = config.get(name);
      expect(def).toEqual({ ...FRAMEWORK_POOLS[name]! });
    }
  });

  it('marks the three events_* pools reserved (RESERVED_POOL_NAMES)', () => {
    expect(RESERVED_POOL_NAMES.has('events_inbound')).toBe(true);
    expect(RESERVED_POOL_NAMES.has('events_change')).toBe(true);
    expect(RESERVED_POOL_NAMES.has('events_outbound')).toBe(true);
    expect(RESERVED_POOL_NAMES.has('interactive')).toBe(false);
    expect(RESERVED_POOL_NAMES.has('batch')).toBe(false);
  });

  it('merges a user-defined pool with the framework defaults preserved', () => {
    const config = resolvePoolConfig({
      agents: { queue: 'jobs-agents', concurrency: 3, description: 'agent loops' },
    });
    expect(config.size).toBe(6);
    expect(config.get('agents')).toEqual({
      queue: 'jobs-agents',
      concurrency: 3,
      reserved: false,
      description: 'agent loops',
    });
    expect(config.get('batch')?.queue).toBe('jobs-batch');
    expect(config.get('events_inbound')?.reserved).toBe(true);
  });

  it('tunes a framework pool\'s concurrency + description only', () => {
    const config = resolvePoolConfig({ events_change: { concurrency: 99, description: 'tuned' } });
    expect(config.get('events_change')).toEqual({
      queue: 'jobs-events-change',
      concurrency: 99,
      reserved: true,
      description: 'tuned',
    });
  });

  it('names every broken rule (poolOverrideIssues) and throws on them', () => {
    const overrides = {
      events_change: { reserved: false },
      batch: { queue: 'elsewhere' },
      forbidden: { queue: 'jobs-forbidden', concurrency: 1, reserved: true },
      bare: {},
    };
    expect(poolOverrideIssues(overrides).map((i) => i.path.join('.'))).toEqual([
      'events_change.reserved',
      'batch.queue',
      'forbidden.reserved',
      'bare.queue',
      'bare.concurrency',
    ]);
    expect(() => resolvePoolConfig(overrides)).toThrow(/jobs\.pools\.forbidden\.reserved: .*framework-only/);
  });

  it('allNonReservedPoolNames excludes the three events_* pools', () => {
    expect(allNonReservedPoolNames(resolvePoolConfig()).sort()).toEqual(['batch', 'interactive']);
  });

  it('allPoolNames includes the three reserved events_* pools (BULLMQ-1)', () => {
    expect(allPoolNames(resolvePoolConfig()).sort()).toEqual([
      'batch',
      'events_change',
      'events_inbound',
      'events_outbound',
      'interactive',
    ]);
  });
});

// ─── JobWorkerModule — boot lifecycle ───────────────────────────────────────

describe('JobWorkerModule.forRoot — memory backend, boot lifecycle', () => {
  it('boots clean with a well-formed handler registry; spawns one worker per non-reserved pool', async () => {
    const TYPE = registerTestType('worker-mod-test.clean-boot');

    @JobHandler(TYPE, { pool: 'batch' })
    class CleanHandler extends JobHandlerBase<unknown, unknown> {
      async run(_ctx: JobContext<unknown>): Promise<unknown> {
        return {};
      }
    }
    void CleanHandler;

    const stubs: StubWorker[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'memory',
          workerFactory: () => {
            const w = new StubWorker();
            stubs.push(w);
            return w;
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    // Default active pools with no `domainModulePools` = the two
    // non-reserved framework pools (interactive + batch).
    expect(stubs.length).toBe(2);
    expect(stubs.every((s) => s.initCalled === 1)).toBe(true);

    await moduleRef.close();
    expect(stubs.every((s) => s.destroyCalled === 1)).toBe(true);
  });

  it('spawns workers from the domainModulePools it is given (CFG-1)', async () => {
    const spawned: Array<{ pool: string; concurrency: number }> = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'memory',
          domainModulePools: {
            batch: { concurrency: 7 },
            reports: { queue: 'jobs-reports', concurrency: 2 },
          },
          workerFactory: (opts) => {
            spawned.push({ pool: opts.pool, concurrency: opts.concurrency });
            return new StubWorker();
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    expect(spawned.sort((a, b) => a.pool.localeCompare(b.pool))).toEqual([
      { pool: 'batch', concurrency: 7 },
      { pool: 'interactive', concurrency: 20 },
      { pool: 'reports', concurrency: 2 },
    ]);
    await moduleRef.close();
  });

  it('throws ReservedPoolViolationError for a handler targeting events_change', async () => {
    const TYPE = registerTestType('worker-mod-test.reserved-violator');

    @JobHandler(TYPE, { pool: 'events_change' })
    class Violator extends JobHandlerBase<unknown, unknown> {
      async run(_ctx: JobContext<unknown>): Promise<unknown> {
        return {};
      }
    }
    void Violator;

    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'memory',
          workerFactory: () => new StubWorker(),
        }),
      ],
    }).compile();

    let caught: unknown = null;
    try {
      await moduleRef.init();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReservedPoolViolationError);
    const e = caught as ReservedPoolViolationError;
    expect(e.offenders.length).toBe(1);
    expect(e.offenders[0]?.handlerClass).toBe('Violator');
    expect(e.offenders[0]?.pool).toBe('events_change');

    await moduleRef.close().catch(() => undefined);
  });

  it('honours the explicit pools list from options', async () => {
    const TYPE = registerTestType('worker-mod-test.explicit-pools');

    @JobHandler(TYPE, { pool: 'batch' })
    class _H extends JobHandlerBase<unknown, unknown> {
      async run(): Promise<unknown> {
        return {};
      }
    }
    void _H;

    const stubs: StubWorker[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'memory',
          pools: ['batch'],
          workerFactory: () => {
            const w = new StubWorker();
            stubs.push(w);
            return w;
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    expect(stubs.length).toBe(1);
    await moduleRef.close();
  });

  it('allPools: true spawns a worker for every pool, reserved lanes included (BULLMQ-1)', async () => {
    const TYPE = registerTestType('worker-mod-test.all-pools');

    @JobHandler(TYPE, { pool: 'batch' })
    class _H extends JobHandlerBase<unknown, unknown> {
      async run(): Promise<unknown> {
        return {};
      }
    }
    void _H;

    const stubs: StubWorker[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'standalone',
          backend: 'memory',
          allPools: true,
          workerFactory: () => {
            const w = new StubWorker();
            stubs.push(w);
            return w;
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    // Five framework pools in a fresh tmp dir: interactive, batch, and the
    // three reserved events_* lanes.
    expect(stubs.length).toBe(5);
    await moduleRef.close();
  });

  it('explicit pools list wins over allPools (precedence)', async () => {
    const stubs: StubWorker[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'standalone',
          backend: 'memory',
          allPools: true,
          pools: ['batch'],
          workerFactory: () => {
            const w = new StubWorker();
            stubs.push(w);
            return w;
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    expect(stubs.length).toBe(1);
    await moduleRef.close();
  });

  it('throws when an explicit pool name is missing from the resolved config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'memory',
          pools: ['nonexistent'],
          workerFactory: () => new StubWorker(),
        }),
      ],
    }).compile();

    let caught: unknown = null;
    try {
      await moduleRef.init();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/not defined in the resolved pool config/);

    await moduleRef.close().catch(() => undefined);
  });

  it('memory mode skips the boot validator entirely (no orphan check)', async () => {
    // Verify Q4 resolution: even if `upsertJobRows` (mocked) returned
    // orphans, memory mode would not throw. We verify by overriding the
    // JOB_ORCHESTRATOR provider with a mock that lies about orphans.

    const upsertCalls: Array<{ entries: JobUpsertEntry[]; orphans: string[] }> = [];
    const mockOrch: IJobOrchestrator = {
      start: () => Promise.reject(new Error('not used in this test')),
      cancel: () => Promise.resolve(),
      replay: () => Promise.reject(new Error('not used')),
      upsertJobRows: async (
        entries: JobUpsertEntry[],
        _pools: ReadonlyMap<string, JobPoolDef>,
      ) => {
        const orphans = ['orphaned_type'];
        upsertCalls.push({ entries, orphans });
        // Return orphans — Drizzle mode would throw, memory mode must not.
        return { orphaned: orphans };
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'memory',
          workerFactory: () => new StubWorker(),
        }),
      ],
    })
      .overrideProvider(JOB_ORCHESTRATOR)
      .useValue(mockOrch)
      .compile();

    // Boot must succeed even though mock returned an orphan.
    await moduleRef.init();
    expect(upsertCalls.length).toBe(1);

    await moduleRef.close();
  });
});

// ─── JobWorkerModule — Drizzle-mode boot validator ─────────────────────────

describe('JobWorkerModule.forRoot — Drizzle mode boot validator', () => {
  /**
   * The test below exercises the validator without a real DB by overriding
   * `JOB_ORCHESTRATOR` with a mock and importing only `JobsDomainModule`'s
   * surface via the worker module. Drizzle backend wiring is otherwise
   * gated on a real `DRIZZLE` provider — which the worker module marks
   * `@Optional()` so the testing module compiles.
   */
  it('throws BootValidationError when the orchestrator returns orphaned types', async () => {
    const mockOrch: IJobOrchestrator = {
      start: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.resolve(),
      replay: () => Promise.reject(new Error('unused')),
      upsertJobRows: async () => ({ orphaned: ['stale_type_one', 'stale_type_two'] }),
    };

    // We must override JOB_ORCHESTRATOR, but JobsDomainModule (Drizzle
    // backend) wires a real DrizzleJobOrchestrator that needs DRIZZLE.
    // Workaround: bypass JobWorkerModule's internal JobsDomainModule
    // import by composing the providers directly.
    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'drizzle',
          workerFactory: () => new StubWorker(),
        }),
      ],
    })
      .overrideProvider(DRIZZLE)
      .useValue({})
      .overrideProvider(JOB_ORCHESTRATOR)
      .useValue(mockOrch)
      .overrideProvider(JOB_RUN_SERVICE)
      .useValue({})
      .overrideProvider(JOB_STEP_SERVICE)
      .useValue({})
      .compile();

    let caught: unknown = null;
    try {
      await moduleRef.init();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootValidationError);
    expect((caught as BootValidationError).missingHandlers).toEqual([
      'stale_type_one',
      'stale_type_two',
    ]);

    await moduleRef.close().catch(() => undefined);
  });

  it('passes upsertJobRows the registry entries and resolved pool config', async () => {
    const TYPE = registerTestType('worker-mod-test.upsert-args');

    @JobHandler(TYPE, { pool: 'batch' })
    class _H extends JobHandlerBase<unknown, unknown> {
      async run(): Promise<unknown> {
        return {};
      }
    }
    void _H;

    let captured: { entries: JobUpsertEntry[]; pools: ReadonlyMap<string, JobPoolDef> } | null = null;
    const mockOrch: IJobOrchestrator = {
      start: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.resolve(),
      replay: () => Promise.reject(new Error('unused')),
      upsertJobRows: async (entries, pools) => {
        captured = { entries, pools };
        return { orphaned: [] };
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JobWorkerModule.forRoot({
          mode: 'embedded',
          backend: 'drizzle',
          workerFactory: () => new StubWorker(),
        }),
      ],
    })
      .overrideProvider(DRIZZLE)
      .useValue({})
      .overrideProvider(JOB_ORCHESTRATOR)
      .useValue(mockOrch)
      .overrideProvider(JOB_RUN_SERVICE)
      .useValue({})
      .overrideProvider(JOB_STEP_SERVICE)
      .useValue({})
      .compile();

    await moduleRef.init();

    expect(captured).not.toBeNull();
    const cap = captured as unknown as {
      entries: JobUpsertEntry[];
      pools: ReadonlyMap<string, JobPoolDef>;
    };
    expect(cap.entries.some((e) => e.type === TYPE)).toBe(true);
    expect(cap.pools.get('batch')).toBeDefined();
    expect(cap.pools.get('events_change')?.reserved).toBe(true);

    await moduleRef.close();
  });
});

// ─── JobWorkerOrchestrator class export ─────────────────────────────────────

describe('JobWorkerOrchestrator (lifecycle holder export)', () => {
  it('is exported alongside the module so consumers can DI it directly', () => {
    expect(JobWorkerOrchestrator).toBeDefined();
    expect(typeof JobWorkerOrchestrator).toBe('function');
  });

  it('JobsDomainModule.forRoot is reachable from the JOB-5 surface', () => {
    expect(JobsDomainModule.forRoot).toBeInstanceOf(Function);
  });
});
