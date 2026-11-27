/**
 * The runtime's logger port (PW-0). Framework-free: nothing here imports Nest.
 *
 * Runtime code logs through `createLogger(context)`, never through a framework's
 * logger. Which logger prints is bound once, by the app or by the framework
 * layer:
 *
 *   - a NestJS app binds Nest's `Logger` (`runtime/nest-logger.ts`, called from
 *     the Nest subsystem modules), so its lines keep Nest's format and follow
 *     `app.useLogger` / the factory `logger:` option;
 *   - a plain app keeps the console default, or calls `setLoggerFactory` with
 *     its own.
 *
 * A logger made before the binding still prints through the bound factory: the
 * one `createLogger` returns looks the factory up on each call. That is what
 * lets a module-level `const logger = createLogger('…')` exist before the app
 * has decided.
 *
 * The method names are Nest's (`log` is info), so code moved off Nest's
 * `Logger` keeps its call sites.
 */

/** What runtime code logs through. */
export interface Logger {
  debug(message: unknown, ...rest: unknown[]): void;
  log(message: unknown, ...rest: unknown[]): void;
  warn(message: unknown, ...rest: unknown[]): void;
  error(message: unknown, ...rest: unknown[]): void;
}

/** Makes the logger for one context (a class or component name). */
export type LoggerFactory = (context: string) => Logger;

/** `debug` lines print only when `LOG_LEVEL` is `debug` or `verbose` (the threshold the Nest logger reads too). */
const debugEnabled = (): boolean => {
  const level = (typeof process === 'undefined' ? undefined : process.env.LOG_LEVEL)?.toLowerCase();
  return level === 'debug' || level === 'verbose';
};

/** The default: the console, each line prefixed with its context; `debug` only under `LOG_LEVEL=debug`. */
export const consoleLoggerFactory: LoggerFactory = (context) => ({
  debug: (message, ...rest) => {
    if (debugEnabled()) console.debug(`[${context}]`, message, ...rest);
  },
  log: (message, ...rest) => console.log(`[${context}]`, message, ...rest),
  warn: (message, ...rest) => console.warn(`[${context}]`, message, ...rest),
  error: (message, ...rest) => console.error(`[${context}]`, message, ...rest),
});

let factory: LoggerFactory = consoleLoggerFactory;

/** Bind the factory every runtime logger prints through, including ones made before this call. */
export function setLoggerFactory(next: LoggerFactory): void {
  factory = next;
}

/** The factory bound now. */
export function getLoggerFactory(): LoggerFactory {
  return factory;
}

/** A logger for `context` that prints through whichever factory is bound when it is called. */
export function createLogger(context: string): Logger {
  let made: { from: LoggerFactory; logger: Logger } | undefined;
  const current = (): Logger => {
    if (made?.from !== factory) made = { from: factory, logger: factory(context) };
    return made.logger;
  };
  return {
    debug: (message, ...rest) => current().debug(message, ...rest),
    log: (message, ...rest) => current().log(message, ...rest),
    warn: (message, ...rest) => current().warn(message, ...rest),
    error: (message, ...rest) => current().error(message, ...rest),
  };
}
