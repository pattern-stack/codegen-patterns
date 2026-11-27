import type { JobEvent } from '../model/events.ts';

/** Where events go: a log, a trace, a domain-event bus. A sink's failure never fails a run. */
export interface EventSink {
  emit(event: JobEvent): void | Promise<void>;
}
