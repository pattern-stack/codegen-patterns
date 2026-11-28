import { describe, expect, it } from 'bun:test';
import {
  JOB_HEALTH_WINDOW,
  type JobHealthRun,
  jobHealthOf,
} from '../health.ts';

let n = 0;
/** A run created at minute `at`, which ran for `ms` when it has finished. */
function run(
  status: JobHealthRun['status'],
  at: number,
  ms?: number,
): JobHealthRun {
  n += 1;
  const createdAt = new Date(Date.UTC(2026, 10, 22, 0, at));
  const startedAt = status === 'pending' ? null : createdAt;
  const finished = ['completed', 'failed', 'canceled'].includes(status);
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tenantId: 'tenant',
    status,
    createdAt,
    startedAt,
    completedAt:
      finished && startedAt && ms !== undefined
        ? new Date(startedAt.getTime() + ms)
        : null,
  };
}

describe('jobHealthOf', () => {
  it('reads success over finished runs and durations over completed ones', () => {
    const health = jobHealthOf([
      run('completed', 1, 1_000),
      run('completed', 2, 3_000),
      run('completed', 3, 2_000),
      run('failed', 4, 500),
      run('canceled', 5, 10),
      run('running', 6),
    ]);
    expect(health).toMatchObject({
      window: 6,
      open: 1,
      completed: 3,
      failed: 1,
      canceled: 1,
      successRate: 0.75,
      durationMs: { avg: 2_000, p50: 2_000, max: 3_000 },
      durations: [1_000, 3_000, 2_000],
    });
    expect(health.lastRun?.status).toBe('running');
  });

  it('takes the lower median of an even count', () => {
    expect(
      jobHealthOf([run('completed', 1, 1_000), run('completed', 2, 3_000)])
        .durationMs,
    ).toEqual({ avg: 2_000, p50: 1_000, max: 3_000 });
  });

  it(`reads only the newest ${JOB_HEALTH_WINDOW} runs, in any order given`, () => {
    const old = Array.from({ length: 5 }, (_, i) => run('failed', i, 1));
    const recent = Array.from({ length: JOB_HEALTH_WINDOW }, (_, i) =>
      run('completed', 100 + i, 1),
    );
    const health = jobHealthOf([...recent, ...old].reverse());
    expect(health).toMatchObject({
      window: JOB_HEALTH_WINDOW,
      failed: 0,
      successRate: 1,
    });
    expect(health.lastRun).toBe(recent[recent.length - 1] ?? null);
  });

  it('has no rate, durations or last run with nothing to read', () => {
    expect(jobHealthOf([])).toEqual({
      window: 0,
      open: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      successRate: null,
      durationMs: null,
      durations: [],
      lastRun: null,
    });
    expect(jobHealthOf([run('pending', 1)]).successRate).toBeNull();
  });
});

describe('jobHealthOf — a queued run (review #969)', () => {
  it('counts as open, never as canceled', () => {
    const health = jobHealthOf([run('queued', 1), run('canceled', 2, 5)]);
    expect(health.open).toBe(1);
    expect(health.canceled).toBe(1);
  });
});
