import { errorTypeOf } from '../model/errors.ts';
import type { JobEvent } from '../model/events.ts';
import type { Run } from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';

export interface EmitterOptions {
  /** step.progress at most this often per step. Default 1000. */
  progressIntervalMs?: number;
  /** A sink's failure never fails a run; it is reported here (default: one line naming the event and error type). */
  onSinkError?: (err: unknown, event: JobEvent) => void;
}

/** One event to every sink, in order; step.progress throttled per run and step. */
export function createEmitter(
  sinks: readonly EventSink[],
  clock: Clock,
  options: EmitterOptions = {},
): EventSink {
  const interval = options.progressIntervalMs ?? 1_000;
  const onSinkError =
    options.onSinkError ??
    ((err: unknown, event: JobEvent) => {
      process.stderr.write(
        `@pattern-stack/jobs: an event sink failed on ${event.type} (${errorTypeOf(err)})\n`,
      );
    });
  const lastProgress = new Map<string, number>();
  return {
    async emit(event) {
      if (event.type === 'step.progress' || event.type === 'step.completed') {
        const key = `${event.runId}\u0000${event.step}`;
        if (event.type === 'step.completed') lastProgress.delete(key);
        else {
          const now = clock.now().getTime();
          const last = lastProgress.get(key);
          if (last !== undefined && now - last < interval) return;
          lastProgress.set(key, now);
        }
      }
      for (const sink of sinks) {
        try {
          await sink.emit(event);
        } catch (err) {
          onSinkError(err, event);
        }
      }
    },
  };
}

/** The ids every event carries. */
export const eventBase = (run: Run, clock: Clock) => ({
  runId: run.id,
  jobKey: run.jobKey,
  jobVersion: run.jobVersion,
  tenantId: run.tenantId,
  at: clock.now(),
});
