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
 * Plus pool-config.loader behaviour: defaults, user merge, reserved
 * preservation, user-cannot-flip-reserved.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  _resetPoolConfigCacheForTests,
  allNonReservedPoolNames,
  loadPoolConfig,
} from '../../../../runtime/subsystems/jobs/pool-config.loader';
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
  _resetPoolConfigCacheForTests();
});

// ─── pool-config.loader ─────────────────────────────────────────────────────

describe('loadPoolConfig', () => {
  it('returns the five framework defaults when no file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
    try {
      const config = loadPoolConfig(join(tmp, 'codegen.config.yaml'));
      expect(config.size).toBe(5);
      for (const name of Object.keys(FRAMEWORK_POOLS)) {
        const def = config.get(name);
        expect(def).toBeDefined();
        expect(def?.queue).toBe(FRAMEWORK_POOLS[name]!.queue);
        expect(def?.concurrency).toBe(FRAMEWORK_POOLS[name]!.concurrency);
        expect(def?.reserved).toBe(FRAMEWORK_POOLS[name]!.reserved);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
    const tmp = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
    try {
      const path = join(tmp, 'codegen.config.yaml');
      writeFileSync(
        path,
        `jobs:\n  pools:\n    agents:\n      queue: jobs-agents\n      concurrency: 3\n      description: agent loops\n`,
        'utf8',
      );
      const config = loadPoolConfig(path);
      expect(config.size).toBe(6);
      expect(config.get('agents')?.queue).toBe('jobs-agents');
      expect(config.get('agents')?.concurrency).toBe(3);
      expect(config.get('agents')?.reserved).toBe(false);
      // Framework defaults still present, untouched.
      expect(config.get('batch')?.queue).toBe('jobs-batch');
      expect(config.get('events_inbound')?.reserved).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('silently preserves reserved=true on framework pools when user tries to flip it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
    try {
      const path = join(tmp, 'codegen.config.yaml');
      writeFileSync(
        path,
        `jobs:\n  pools:\n    events_change:\n      concurrency: 99\n      reserved: false\n`,
        'utf8',
      );
      const config = loadPoolConfig(path);
      expect(config.get('events_change')?.reserved).toBe(true);
      // Concurrency override accepted.
      expect(config.get('events_change')?.concurrency).toBe(99);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a user-defined pool with reserved=true', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
    try {
      const path = join(tmp, 'codegen.config.yaml');
      writeFileSync(
        path,
        `jobs:\n  pools:\n    forbidden:\n      queue: jobs-forbidden\n      concurrency: 1\n      reserved: true\n`,
        'utf8',
      );
      expect(() => loadPoolConfig(path)).toThrow(/reserved is framework-only/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('caches by absolute path — second call returns the same map instance', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
    try {
      const path = join(tmp, 'codegen.config.yaml');
      const first = loadPoolConfig(path);
      const second = loadPoolConfig(path);
      expect(first).toBe(second);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allNonReservedPoolNames excludes the three events_* pools', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
    try {
      const config = loadPoolConfig(join(tmp, 'codegen.config.yaml'));
      const names = allNonReservedPoolNames(config);
      expect(names.sort()).toEqual(['batch', 'interactive']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── JobWorkerModule — boot lifecycle ───────────────────────────────────────

describe('JobWorkerModule.forRoot — memory backend, boot lifecycle', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jobs-worker-mod-'));
    configPath = join(tmpDir, 'codegen.config.yaml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

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
          configPath,
          workerFactory: () => {
            const w = new StubWorker();
            stubs.push(w);
            return w;
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    // Default active pools in a fresh tmp dir = the two non-reserved
    // framework pools (interactive + batch).
    expect(stubs.length).toBe(2);
    expect(stubs.every((s) => s.initCalled === 1)).toBe(true);

    await moduleRef.close();
    expect(stubs.every((s) => s.destroyCalled === 1)).toBe(true);
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
          configPath,
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
          configPath,
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
          configPath,
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
          configPath,
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
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jobs-worker-mod-drizzle-'));
    configPath = join(tmpDir, 'codegen.config.yaml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

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
          configPath,
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
          configPath,
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
