import type { JobEvent } from '../model/events.ts';
import type { EventSink } from '../ports/event-sink.ts';

/** One structured log line per event: its type and ids, never content. */
export function logSink(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): EventSink {
  return {
    emit(event: JobEvent) {
      const { at, ...rest } = event;
      write(
        JSON.stringify({
          msg: `job ${event.type}`,
          ...rest,
          at: at.toISOString(),
        }),
      );
    },
  };
}
