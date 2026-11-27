import type { RUN_STATUSES } from './vocabulary.ts';

/** The runs each job's health reads: its newest, whatever their status. */
export const JOB_HEALTH_WINDOW = 20;

/** What health reads of a run: a synced `job_runs` row and the server's run both carry it. */
export interface JobHealthRun {
  id: string;
  tenantId: string;
  status: (typeof RUN_STATUSES)[number];
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface JobHealthOf<R extends JobHealthRun> {
  /** The runs read: at most `JOB_HEALTH_WINDOW`. */
  window: number;
  /** Pending, running, waiting or paused. */
  open: number;
  completed: number;
  failed: number;
  canceled: number;
  /** completed / (completed + failed); null with neither. */
  successRate: number | null;
  /** Started to completed over the completed runs (p50 the lower median); null with none. */
  durationMs: { avg: number; p50: number; max: number } | null;
  /** The completed runs' durations, oldest first. */
  durations: number[];
  /** The newest run read. */
  lastRun: R | null;
}

const OPEN: ReadonlySet<JobHealthRun['status']> = new Set([
  'pending',
  'running',
  'waiting',
  'paused',
]);

const newestFirst = (a: JobHealthRun, b: JobHealthRun) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

/**
 * A set of runs' health: the newest `JOB_HEALTH_WINDOW` of them whatever their status, success over the finished
 * ones (completed or failed; a cancel is neither), durations over the completed ones. The one definition: the server
 * applies it to each job's newest runs (`jobsOps.jobs`), the browser to the synced runs of any scope.
 */
export function jobHealthOf<R extends JobHealthRun>(
  runs: readonly R[],
): JobHealthOf<R> {
  const newest = [...runs].sort(newestFirst).slice(0, JOB_HEALTH_WINDOW);
  let open = 0;
  let completed = 0;
  let failed = 0;
  let canceled = 0;
  const durations: number[] = [];
  for (const run of [...newest].reverse()) {
    if (OPEN.has(run.status)) open += 1;
    else if (run.status === 'completed') {
      completed += 1;
      if (run.startedAt && run.completedAt)
        durations.push(
          Math.max(0, run.completedAt.getTime() - run.startedAt.getTime()),
        );
    } else if (run.status === 'failed') failed += 1;
    else canceled += 1;
  }
  return {
    window: newest.length,
    open,
    completed,
    failed,
    canceled,
    successRate:
      completed + failed === 0 ? null : completed / (completed + failed),
    durationMs: durationStats(durations),
    durations,
    lastRun: newest[0] ?? null,
  };
}

function durationStats(
  durations: readonly number[],
): JobHealthOf<JobHealthRun>['durationMs'] {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((total, ms) => total + ms, 0);
  return {
    avg: Math.round(sum / sorted.length),
    p50: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}
