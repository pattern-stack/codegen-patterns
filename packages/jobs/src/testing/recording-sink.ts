import type { JobEvent, JobEventType } from '../model/events.ts';
import type { EventSink } from '../ports/event-sink.ts';

export interface RecordingSink extends EventSink {
  readonly events: JobEvent[];
  /** The types in order, optionally only those of one kind. */
  types(filter?: (type: JobEventType) => boolean): JobEventType[];
}

/** Collects every event, for assertions. */
export function recordingSink(): RecordingSink {
  const events: JobEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    types: (filter) =>
      events.map((e) => e.type).filter((t) => (filter ? filter(t) : true)),
  };
}
