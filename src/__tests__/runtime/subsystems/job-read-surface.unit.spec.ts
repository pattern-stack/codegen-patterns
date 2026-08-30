/**
 * #568 part 2 — the jobs read surface the ports were missing.
 *
 * `IJobRunService` offered `listJobRuns` + `countByPoolAndStatus`;
 * `IJobStepService` offered `recordStep` + `findStep`. So a consumer could not,
 * through these ports:
 *   - fetch ONE run by id (only page and filter client-side)
 *   - list a run's steps (findStep is singular AND completed-only)
 *   - count runs (only sum countByPoolAndStatus's rows, which is correct only
 *     while every run has a pool and a status — an invariant nothing states)
 *
 * Each gap forced raw SQL against tables this subsystem owns and may migrate.
 * Every test below names the donor mutation that reddens it.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { JobRunRow } from '../../../../runtime/subsystems/jobs/job-orchestration.schema';
import { MemoryJobStore } from '../../../../runtime/subsystems/jobs/memory-job-store';
import { MemoryJobOrchestrator } from '../../../../runtime/subsystems/jobs/job-orchestrator.memory-backend';
import { MemoryJobRunService } from '../../../../runtime/subsystems/jobs/job-run-service.memory-backend';
import { MemoryJobStepService } from '../../../../runtime/subsystems/jobs/job-step-service.memory-backend';
import { MissingTenantIdError } from '../../../../runtime/subsystems/jobs/jobs-errors';

function build(multiTenant: boolean) {
  const store = new MemoryJobStore();
  const stepService = new MemoryJobStepService(store);
  const orchestrator = new MemoryJobOrchestrator(store, stepService, multiTenant);
  const runService = new MemoryJobRunService(store, orchestrator, multiTenant);
  return { store, runService, stepService };
}

let seq = 0;
function seedRun(
  store: MemoryJobStore,
  overrides: Partial<JobRunRow> & Pick<JobRunRow, 'status' | 'pool'>,
): JobRunRow {
  seq += 1;
  const id = overrides.id ?? `run-${seq}`;
  const now = new Date('2026-01-01T00:00:00Z');
  const row = {
    id,
    jobType: 'test.job',
    jobVersion: 1,
    parentRunId: null,
    rootRunId: id,
    parentClosePolicy: 'terminate',
    scopeEntityType: null,
    scopeEntityId: null,
    tenantId: null,
    tags: {},
    priority: 0,
    concurrencyKey: null,
    dedupeKey: null,
    input: {},
    output: null,
    error: null,
    triggerSource: 'manual',
    attempt: 1,
    maxAttempts: 1,
    scheduledFor: now,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  } as unknown as JobRunRow;
  store.runs.set(id, row);
  return row;
}

describe('IJobRunService.getRun — one run by id', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build(false);
    seedRun(h.store, { id: 'r-1', pool: 'batch', status: 'completed' });
    seedRun(h.store, { id: 'r-2', pool: 'interactive', status: 'failed' });
  });

  it('returns the full row, not a summary projection', async () => {
    // DONOR: return a JobRunSummary here instead. A run inspector renders
    // input/output/error/tags, and a second round trip to fetch what the list
    // dropped is exactly the shape this method removes.
    const run = await h.runService.getRun('r-1');
    expect(run?.id).toBe('r-1');
    expect(run).toHaveProperty('input');
    expect(run).toHaveProperty('output');
    expect(run).toHaveProperty('error');
  });

  it('returns null for an unknown id rather than throwing', async () => {
    // DONOR: throw instead. "No such run" is a real answer to a legitimate
    // question, not an exception — the caller renders 404, not 500.
    expect(await h.runService.getRun('nope')).toBeNull();
  });

  it('does not confuse two runs', async () => {
    expect((await h.runService.getRun('r-2'))?.status).toBe('failed');
  });
});

describe('IJobRunService.getRun — the id is not the authorisation', () => {
  it('refuses a run belonging to another tenant, even given its exact id', async () => {
    // DONOR: drop the tenantCheck from getRun. The run is then returned to a
    // caller scoped to a different tenant purely because it knew the id —
    // a cross-tenant read through a method that looks like a plain lookup.
    const h = build(true);
    seedRun(h.store, { id: 'mine', pool: 'batch', status: 'completed', tenantId: 't-1' });
    seedRun(h.store, { id: 'theirs', pool: 'batch', status: 'completed', tenantId: 't-2' });

    expect((await h.runService.getRun('mine', 't-1'))?.id).toBe('mine');
    expect(await h.runService.getRun('theirs', 't-1')).toBeNull();
  });

  it('throws when multi-tenant is on and no tenant is supplied', async () => {
    const h = build(true);
    seedRun(h.store, { id: 'x', pool: 'batch', status: 'completed', tenantId: 't-1' });
    await expect(h.runService.getRun('x')).rejects.toThrow(MissingTenantIdError);
  });

  it('ignores tenantId entirely when multi-tenant is off', async () => {
    const h = build(false);
    seedRun(h.store, { id: 'x', pool: 'batch', status: 'completed', tenantId: null });
    expect((await h.runService.getRun('x', 'anything'))?.id).toBe('x');
  });
});

describe('IJobRunService.countRuns', () => {
  it('counts every run regardless of pool or status', async () => {
    // DONOR: implement as a sum over countByPoolAndStatus. That is what
    // callers were doing, and it is correct only while every run has both a
    // pool and a status — an invariant nothing in the schema states.
    const h = build(false);
    seedRun(h.store, { pool: 'batch', status: 'completed' });
    seedRun(h.store, { pool: 'batch', status: 'failed' });
    seedRun(h.store, { pool: 'interactive', status: 'running' });
    expect(await h.runService.countRuns()).toBe(3);
  });

  it('is 0 on an empty store, not an error', async () => {
    expect(await build(false).runService.countRuns()).toBe(0);
  });

  it('counts only the caller tenant when multi-tenant is on', async () => {
    const h = build(true);
    seedRun(h.store, { pool: 'batch', status: 'completed', tenantId: 't-1' });
    seedRun(h.store, { pool: 'batch', status: 'completed', tenantId: 't-1' });
    seedRun(h.store, { pool: 'batch', status: 'completed', tenantId: 't-2' });
    expect(await h.runService.countRuns('t-1')).toBe(2);
    expect(await h.runService.countRuns('t-2')).toBe(1);
  });
});

describe('IJobStepService.listSteps — a timeline, not a memoisation lookup', () => {
  it('returns steps that findStep deliberately hides', async () => {
    // THE POINT OF THE METHOD. `findStep` filters to `completed` because it
    // serves ctx.step memoisation. A timeline needs the opposite: the FAILED
    // step is the interesting one and a RUNNING step is where the run is now.
    //
    // DONOR: implement listSteps by reusing findStep's completed-only filter.
    // This test goes from 3 steps to 1 and the timeline silently loses the
    // failure an operator opened the page to find.
    const h = build(false);
    await h.stepService.recordStep({
      jobRunId: 'r-1', stepId: 's1', seq: 1, status: 'completed', output: { ok: true },
    } as never);
    await h.stepService.recordStep({
      jobRunId: 'r-1', stepId: 's2', seq: 2, status: 'failed', output: null,
    } as never);
    await h.stepService.recordStep({
      jobRunId: 'r-1', stepId: 's3', seq: 3, status: 'running', output: null,
    } as never);

    const steps = await h.stepService.listSteps('r-1');
    expect(steps.map((s) => s.stepId)).toEqual(['s1', 's2', 's3']);
    expect(await h.stepService.findStep('r-1', 's2')).toBeNull();
  });

  it('returns [] for a run with no steps — a real answer, not "unknown run"', async () => {
    // `[]` here means "this run recorded no steps". A caller distinguishes
    // that from a nonexistent run by asking getRun first; this method does
    // not conflate the two by throwing.
    expect(await build(false).stepService.listSteps('never-ran')).toEqual([]);
  });

  it('does not leak another run’s steps', async () => {
    const h = build(false);
    await h.stepService.recordStep({
      jobRunId: 'r-1', stepId: 'a', seq: 1, status: 'completed', output: null,
    } as never);
    await h.stepService.recordStep({
      jobRunId: 'r-2', stepId: 'b', seq: 1, status: 'completed', output: null,
    } as never);
    expect((await h.stepService.listSteps('r-1')).map((s) => s.stepId)).toEqual(['a']);
  });
});
