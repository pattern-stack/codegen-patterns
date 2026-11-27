import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { errorTypeOf, logSink } from '../index.ts';
import type { EventSink } from '../ports.ts';

/**
 * The engine's events on the active span, through `@opentelemetry/api` (d89): the observation the host's worker opened
 * for the job (the run's root on its first job, a stage after). `step.completed` sets numeric attributes
 * `jobs.step.<name>.<count>` from its counts and speculation; `step.failed` and `run.failed` set an ERROR status with
 * the error's type. Other events write nothing (the event log keeps them). It opens no span, so it leaves no hole in
 * the host's trace tree; it writes ids, counts and types, never content; with no active span or no SDK it does nothing,
 * and it never throws.
 */
export function activeSpanSink(): EventSink {
  return {
    async emit(event) {
      try {
        const span = trace.getActiveSpan();
        if (!span) return;
        if (event.type === 'step.completed') {
          const prefix = `jobs.step.${event.step}`;
          for (const [count, n] of Object.entries(event.counts))
            span.setAttribute(`${prefix}.${count}`, n);
          for (const [field, n] of Object.entries(event.speculation ?? {}))
            span.setAttribute(`${prefix}.speculation.${field}`, n);
        } else if (event.type === 'step.failed' || event.type === 'run.failed')
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.errorType,
          });
      } catch {
        // A trace write never fails a run.
      }
    },
  };
}

/** One log line per event: the core's `logSink` on a Nest logger. */
export const nestLogSink = (logger: Pick<Logger, 'log'>): EventSink =>
  logSink((line) => logger.log(line));

/**
 * One sink over many, each awaited in turn. A sink's throw never stops the others or the caller; it is reported by
 * the event's and the error's type (no message, no content), as the engine's emitter reports one.
 */
export function fanOut(
  sinks: readonly EventSink[],
  logger: Pick<Logger, 'warn'> = new Logger('JobEngine'),
): EventSink {
  return {
    async emit(event) {
      for (const sink of sinks) {
        try {
          await sink.emit(event);
        } catch (err) {
          logger.warn(
            `a job event sink failed on ${event.type} (${errorTypeOf(err)})`,
          );
        }
      }
    },
  };
}
