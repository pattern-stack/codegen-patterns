import type { Run } from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';

/** What a process does with a run: work it (its version), leave it to a process on its version, or fail it as gone. */
export type VersionStanding = 'ours' | 'leave' | 'gone';

/**
 * The drain window a version bump gives, as one rule both executors read. A version is a hash, so a process can't
 * tell an older version from a newer one; it reads time instead. A run of another version is gone only once this
 * process has been up `graceMs` and the run itself is older than `graceMs`: before that it may be a version a rolling
 * deploy is still bringing up (a new replica's run, reached by an old worker), or one still draining. So the window
 * must cover the deploy. With `graceMs` 0 (one process, none other to leave a run to) every other version is gone.
 */
export interface DrainWindow {
  standing(definition: { version: string }, run: Run): VersionStanding;
  /** `AdvanceDeps.versionGone`: whether this run's advance fails it (`JobVersionGoneError`). */
  gone(run: Run): boolean;
}

export function drainWindow(clock: Clock, graceMs: number): DrainWindow {
  const bootAt = clock.now().getTime();
  const gone = (run: Run) => {
    const now = clock.now().getTime();
    return now - bootAt >= graceMs && now - run.createdAt.getTime() >= graceMs;
  };
  return {
    gone,
    standing: (definition, run) =>
      definition.version === run.jobVersion ? 'ours' : gone(run) ? 'gone' : 'leave',
  };
}
