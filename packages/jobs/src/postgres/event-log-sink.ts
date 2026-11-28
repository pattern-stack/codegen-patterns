import type { EventSink } from '../ports/event-sink.ts';
import type { PostgresJobStore } from './postgres-job-store.ts';

/**
 * The event log (`job_run_events`): one row per event, ids, counts and types only. `step.progress` is not kept: it is
 * throttled but still most of a run's events, and the step's row (live through Electric) already carries its counts.
 * A failed write is the fan-out's to report; it never fails a run.
 */
export const eventLogSink = (
  store: Pick<PostgresJobStore, 'appendEvent'>,
): EventSink => ({
  async emit(event) {
    if (event.type === 'step.progress') return;
    await store.appendEvent(event);
  },
});
