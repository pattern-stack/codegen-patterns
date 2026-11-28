/**
 * Job factories on the Nest host (JOBS-3, the default taken for "a job step needs the app's services"): a
 * `jobFactory`'s dependencies are resolved from the app's container through `ModuleRef`, from any module, and a
 * missing one stops the boot naming the job and the dependency.
 *
 * The load-bearing case is a YAML job (RFC-0005): the jobs emitter's own output (`<type>.job.generated.ts` and the
 * emit-once `<type>.job.ts`) is written to disk, the author's arm body filled in to call the provider's
 * `ExecuteIntegrationUseCase` under its per-entity token (`<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>`, which the
 * integration assembly exports from its own module), and the job, booted in the real `JobsEngineModule`, run to
 * completion: the arm reaches the use case.
 */
import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parse as parseYaml } from 'yaml';
import {
  type AnyJob,
  buildJobs,
  defineJob,
  injected,
  jobFactory,
  type Registry,
  runToCompletion,
  step,
} from '@pattern-stack/jobs';
import { JOBS_REGISTRY } from '@pattern-stack/jobs/nest';
import { MemoryJobStore } from '@pattern-stack/jobs/testing';
import { z } from 'zod';

import { DRIZZLE } from '../../../../runtime/constants/tokens';
import { JobsEngineModule } from '../../../../runtime/subsystems/jobs/jobs-engine.module';
import type {
  ExecuteIntegrationInput,
  ExecuteIntegrationResult,
} from '../../../../runtime/subsystems/integration/execute-integration.use-case';
import { generateJobHandlerBase, generateJobHandlerSubclass } from '../../../cli/shared/job-emission-generator';
import { JobDefinitionSchema } from '../../../schema/job-definition.schema';

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const SYNC_TOKEN = 'DOCUMENT_INTEGRATION_USE_CASE__DRIVE';

/** A use case double: records each `execute` and answers a successful run. */
function fakeUseCase() {
  const calls: ExecuteIntegrationInput<Record<string, unknown>>[] = [];
  return {
    calls,
    async execute(input: ExecuteIntegrationInput<Record<string, unknown>>): Promise<ExecuteIntegrationResult> {
      calls.push(input);
      return {
        runId: `int-${calls.length}`,
        status: 'success',
        recordsFound: 3,
        recordsProcessed: 3,
        recordsFailed: 0,
        cursorBefore: null,
        cursorAfter: null,
        durationMs: 1,
      };
    },
  };
}

/** The integration assembly's shape: the use case exported under its token from a module of its own (not global). */
function integrationModule(useCase: ReturnType<typeof fakeUseCase>) {
  @Module({ providers: [{ provide: SYNC_TOKEN, useValue: useCase }], exports: [SYNC_TOKEN] })
  class DocumentIntegrationModule {}
  return DocumentIntegrationModule;
}

/** The app's database module; the store is built over it, and nothing here queries. */
@Global()
@Module({ providers: [{ provide: DRIZZLE, useValue: {} }], exports: [DRIZZLE] })
class StubDatabaseModule {}

async function bootJobs(definitions: readonly unknown[], extra: unknown[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      StubDatabaseModule,
      ...(extra as never[]),
      JobsEngineModule.forRoot({ definitions: definitions as never, worker: false, limiters: { integration: { inFlight: 2 } } }),
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

const runIt = (job: AnyJob, input: unknown) =>
  runToCompletion(
    job,
    { input, tenantId: 'tenant-1', trigger: 'agent', requestedBy: null, budget: { maxItems: 10 } } as never,
    { store: new MemoryJobStore(), executor: { pollMs: 1 } },
  );

// ── The YAML job: the emitter's own output, the author's arm filled in ──────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, 'src/__tests__/runtime/subsystems/.job-factory-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function emittedDrivePollJob(): Promise<unknown> {
  const job = JobDefinitionSchema.parse(
    parseYaml(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/jobs/drive_poll.yaml'), 'utf8')),
  );
  fs.writeFileSync(path.join(tmpDir, 'drive_poll.job.generated.ts'), generateJobHandlerBase({ job }));
  const emitOnce = generateJobHandlerSubclass({ job });
  // The author's edit: name the dependency, and call it from the arm.
  const authored = emitOnce
    .replace("import { jobFactory } from '@pattern-stack/jobs';", "import { injected, jobFactory } from '@pattern-stack/jobs';")
    .replace('deps: {},', `deps: { sync: injected<{ execute(input: unknown): Promise<{ recordsProcessed: number }> }>('${SYNC_TOKEN}') },`)
    .replace(
      /throw new Error\('drive_poll: arm document is not implemented'\);/,
      [
        'const result = await deps.sync.execute({',
        "          subscription: { id: 'sub-1', domain: 'document' },",
        "          userId: 'system', provider: 'drive', direction: 'inbound', action: 'poll',",
        '          detection: drivePollArmDetection.document, tenantId: _ctx.tenantId,',
        '        });',
        "        return { domain: 'document', kind: 'poll', recordsProcessed: result.recordsProcessed };",
      ].join('\n'),
    );
  expect(authored).not.toBe(emitOnce);
  fs.writeFileSync(path.join(tmpDir, 'drive_poll.job.ts'), authored);
  return (await import(path.join(tmpDir, 'drive_poll.job.ts'))).drivePollJob;
}

describe('job factories on JobsEngineModule', () => {
  it('a YAML job arm reaches ExecuteIntegrationUseCase, resolved from another module through ModuleRef', async () => {
    const useCase = fakeUseCase();
    const drivePollJob = await emittedDrivePollJob();
    const moduleRef = await bootJobs([drivePollJob], [integrationModule(useCase)]);
    const registry = moduleRef.get<Registry>(JOBS_REGISTRY);
    expect(registry.has('drive_poll')).toBe(true);

    const outcome = await runIt(registry.get('drive_poll'), {});
    expect(outcome.run.status).toBe('completed');
    expect(outcome.output).toEqual({ domain: 'document', kind: 'poll', recordsProcessed: 3 });
    expect(useCase.calls).toHaveLength(1);
    expect(useCase.calls[0]).toMatchObject({ provider: 'drive', action: 'poll', tenantId: 'tenant-1' });
    await moduleRef.close();
  });

  it('a class token resolves too, and a plain defineJob value sits beside factories unchanged', async () => {
    class Clock {
      now(): string {
        return '2026-11-27T00:00:00.000Z';
      }
    }
    @Module({ providers: [Clock], exports: [Clock] })
    class ClockModule {}
    const stamped = jobFactory({
      deps: { clock: Clock },
      create: ({ clock }) =>
        defineJob({
          key: 'toy.stamped',
          input: z.object({}),
          output: z.object({ at: z.string() }),
          steps: (s) => s.add('stamp', step({ run: () => ({ at: clock.now() }) })),
        }),
    });
    const plain = defineJob({
      key: 'toy.plain',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      steps: (s) => s.add('ok', step({ run: () => ({ ok: true }) })),
    });
    const moduleRef = await bootJobs([stamped, plain], [ClockModule]);
    const registry = moduleRef.get<Registry>(JOBS_REGISTRY);
    expect((await runIt(registry.get('toy.stamped'), {})).output).toEqual({ at: '2026-11-27T00:00:00.000Z' });
    expect(registry.get('toy.plain')).toBe(plain);
    await moduleRef.close();
  });

  it('a dependency no module provides stops the boot, naming the job and the dependency', async () => {
    const orphan = jobFactory({
      deps: { sync: injected<{ execute(): Promise<void> }>('NOWHERE_INTEGRATION_USE_CASE') },
      create: ({ sync }) =>
        defineJob({
          key: 'toy.orphan',
          input: z.object({}),
          output: z.object({}),
          steps: (s) => s.add('go', step({ run: async () => (await sync.execute(), {}) })),
        }),
    });
    await expect(bootJobs([orphan], [])).rejects.toThrow(
      /job 'toy\.orphan': its dependency 'sync' \(NOWHERE_INTEGRATION_USE_CASE\) is not a provider of this app/,
    );
  });
});

describe('buildJobs (framework-free)', () => {
  it('resolves a dependency only on first use, so the list can be built before the providers exist', () => {
    const resolved: unknown[] = [];
    const job = jobFactory({
      deps: { svc: injected<{ hi(): string }>('SVC') },
      create: ({ svc }) =>
        defineJob({
          key: 'toy.lazy',
          input: z.object({}),
          output: z.object({ said: z.string() }),
          steps: (s) => s.add('hi', step({ run: () => ({ said: svc.hi() }) })),
        }),
    });
    const [built] = buildJobs([job], (token) => {
      resolved.push(token);
      return { hi: () => 'hi' };
    });
    expect(built?.key).toBe('toy.lazy');
    expect(resolved).toEqual([]);
  });
});
