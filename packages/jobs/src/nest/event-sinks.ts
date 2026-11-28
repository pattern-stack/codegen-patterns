import { Logger } from '@nestjs/common';
import { fanOutSinks } from '../host/sinks.ts';
import type { EventSink } from '../ports.ts';

/**
 * One sink over many (`fanOutSinks`), a failing sink reported on a Nest logger.
 */
export function fanOut(
  sinks: readonly EventSink[],
  logger: Pick<Logger, 'warn'> = new Logger('JobEngine'),
): EventSink {
  return fanOutSinks(sinks, (message) => logger.warn(message));
}
