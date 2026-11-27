import { describe, expect, it } from 'bun:test';
import { runShape } from '../../shapes/index.ts';
import {
  createRegistry,
  type Run,
  type RunProgress,
  type StepState,
} from '../../index.ts';
import { toyPublicDry } from '../../testing.ts';
import { publicJobCatalogOf } from '../public-job-catalog.ts';
import {
  revisionOf,
  runSummaryOf,
  runViewOf,
  WIRE_VOCABULARY_PARITY,
  wireErrorOf,
} from '../run-view.ts';

const T = new Date('2026-11-15T12:00:00.000Z');
const job = toyPublicDry();
const publicJob = (() => {
  const p = publicJobCatalogOf(createRegistry([job])).get(job.key);
  if (!p) throw new Error('no toy job');
  return p;
})();

const run = (over: Partial<Run> = {}): Run => ({
  id: '6f1c1f0e-4a52-4c1e-9a0b-0f5b1b7d2a10',
  jobKey: job.key,
  jobVersion: job.version,
  tenantId: 'tenant-a',
  dryRun: true,
  status: 'running',
  pauseReason: null,
  trigger: 'agent',
  requestedBy: null,
  chunkSize: 1000,
  chunkConcurrency: null,
  budget: { maxItems: 10, maxUsd: 1, deadline: T },
  cache: 'read-write',
  dedupeKey: null,
  subject: null,
  spend: { calls: 1, inputTokens: 10, costUsd: 0.01 },
  reservedUsd: 0,
  error: null,
  parentRunId: null,
  parentStep: null,
  childKey: null,
  depth: 0,
  createdAt: T,
  startedAt: T,
  completedAt: null,
  ...over,
});

const chunks = { pending: 0, running: 0, completed: 0, failed: 0, canceled: 0 };
const state = (over: Partial<StepState>): StepState => ({
  runId: run().id,
  name: 'items',
  index: 0,
  kind: 'step',
  status: 'completed',
  attempts: 1,
  counts: { total: 0, done: 0, cached: 0, failed: 0, skipped: 0 },
  chunks,
  planned: true,
  wait: null,
  settledBy: null,
  sourceCursor: null,
  speculation: null,
  error: null,
  startedAt: T,
  completedAt: T,
  ...over,
});

const progress = (r: Run, steps: StepState[]): RunProgress => ({
  run: r,
  steps,
  chunks,
});

describe('wireErrorOf', () => {
  it('carries the type and a fixed sentence, never the stored text', () => {
    expect(
      wireErrorOf(
        { type: 'RunPlanningError', message: 'secret detail' },
        'run',
      ),
    ).toEqual({
      type: 'RunPlanningError',
      message:
        'The run could not be planned: an input the job refused, or a step that failed outside its items.',
    });
    expect(wireErrorOf({ type: 'Error', message: 'x' }, 'step')).toEqual({
      type: 'Error',
      message: 'The step failed.',
    });
    expect(wireErrorOf({ type: 'ProviderError', message: 'x' }, 'run')).toEqual(
      {
        type: 'ProviderError',
        message: 'The run failed.',
      },
    );
    expect(wireErrorOf({ type: 'bad type!', message: 'x' }, 'run')?.type).toBe(
      'Error',
    );
    expect(
      wireErrorOf({ type: 'A'.repeat(65), message: 'x' }, 'run')?.type,
    ).toBe('Error');
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty'])
      expect(wireErrorOf({ type: inherited, message: 'x' }, 'run')).toEqual({
        type: inherited,
        message: 'The run failed.',
      });
    expect(wireErrorOf(null, 'run')).toBeNull();
  });

  it("leaves a step's provider text out of every field of the view", () => {
    const secret = 'provider said: sk-live-12345';
    const view = runViewOf(
      publicJob,
      progress(
        run({ status: 'failed', error: { type: 'Error', message: secret } }),
        [
          state({
            status: 'failed',
            error: { type: 'Error', message: secret },
          }),
        ],
      ),
      null,
    );
    expect(view.steps[0]?.error).toEqual({
      type: 'Error',
      message: 'The step failed.',
    });
    expect(JSON.stringify(view)).not.toContain('sk-live');
    expect(runShape.safeParse(view).success).toBe(true);
  });
});

describe('runViewOf', () => {
  it("synthesizes the steps not yet started, only on the job's own version", () => {
    const started = [state({ name: 'items', index: 0 })];
    const view = runViewOf(publicJob, progress(run(), started), null);
    expect(view.steps.map((s) => [s.name, s.status, s.kind])).toEqual([
      ['items', 'completed', 'step'],
      ['score', 'pending', 'map'],
      ['summary', 'pending', 'step'],
    ]);
    const other = runViewOf(
      publicJob,
      progress(run({ jobVersion: 'older' }), started),
      null,
    );
    expect(other.steps.map((s) => s.name)).toEqual(['items']);
  });

  it("sums the map steps' counts", () => {
    const view = runViewOf(
      publicJob,
      progress(run(), [
        state({
          name: 'items',
          index: 0,
          counts: { total: 9, done: 9, cached: 0, failed: 0, skipped: 0 },
        }),
        state({
          name: 'score',
          index: 1,
          kind: 'map',
          status: 'running',
          counts: { total: 4, done: 2, cached: 1, failed: 1, skipped: 0 },
        }),
      ]),
      null,
    );
    expect(view.counts).toEqual({
      total: 4,
      done: 2,
      cached: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it('keeps a revision stable across key order, and moves it when a count moves', () => {
    const base = runViewOf(publicJob, progress(run(), [state({})]), null);
    const { output: _o, revision, ...rest } = base;
    const reordered = Object.fromEntries(
      Object.entries(rest).reverse(),
    ) as typeof rest;
    expect(revisionOf(reordered)).toBe(revision);
    const moved = runViewOf(
      publicJob,
      progress(run(), [
        state({
          counts: { total: 1, done: 1, cached: 0, failed: 0, skipped: 0 },
        }),
      ]),
      null,
    );
    expect(moved.revision).not.toBe(revision);
    const withOutput = runViewOf(publicJob, progress(run(), [state({})]), {
      a: 1,
    });
    expect(withOutput.revision).toBe(revision);
  });

  it('maps the run record alone for a list row', () => {
    expect(runSummaryOf(run())).toMatchObject({
      budget: {
        maxItems: 10,
        maxUsd: 1,
        maxCalls: null,
        deadlineAt: T.toISOString(),
      },
      createdAt: T.toISOString(),
      completedAt: null,
    });
  });

  it('holds the restated vocabulary equal to the engine (compile time)', () => {
    expect(WIRE_VOCABULARY_PARITY.every(Boolean)).toBe(true);
  });
});
