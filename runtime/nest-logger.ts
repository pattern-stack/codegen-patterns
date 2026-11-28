/**
 * Binds the runtime's logger port (`./logger`) to Nest's `Logger` (PW-0).
 *
 * The Nest subsystem modules call `useNestLogger()` when they load, so a Nest
 * app's runtime lines (lifecycle events, the event scheduler, the jobs
 * listener) print through Nest's `Logger`, as they did before the port: same
 * format, same `app.useLogger` routing. Plain apps never load this file.
 */
import { Logger as NestLogger } from '@nestjs/common';
import { consoleLoggerFactory, getLoggerFactory, setLoggerFactory, type LoggerFactory } from './logger';

export const nestLoggerFactory: LoggerFactory = (context) => new NestLogger(context);

/** Binds Nest's `Logger`, unless the app already bound a factory of its own (that one wins). */
export function useNestLogger(): void {
  if (getLoggerFactory() === consoleLoggerFactory) setLoggerFactory(nestLoggerFactory);
}
