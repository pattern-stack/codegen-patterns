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
 *   - a pattern-stack app keeps the console default, or calls `setLoggerFactory` with
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

/** Severity-ordered (lowest → highest), Nest's names; a `LOG_LEVEL` threshold enables its suffix. */
export const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const DEFAULT_LOG_LEVEL: LogLevel = 'log';

const envLogLevel = (): string | undefined =>
  typeof process === 'undefined' ? undefined : process.env.LOG_LEVEL;

/**
 * The `LOG_LEVEL` rule, one for every logger: a single severity threshold enables that level and every level
 * above it. `LOG_LEVEL=debug` → `['debug', 'log', 'warn', 'error', 'fatal']`. Unknown input warns and falls back
 * to the default (`'log'` and above). The Nest logger (`createAppLogger`) and the console default both read it.
 */
export function parseLogLevels(threshold: string | undefined = envLogLevel()): LogLevel[] {
  const idx = LOG_LEVELS.indexOf((threshold ?? DEFAULT_LOG_LEVEL).toLowerCase() as LogLevel);
  if (idx === -1) {
    console.warn(`[logging] unknown LOG_LEVEL '${threshold}' — defaulting to '${DEFAULT_LOG_LEVEL}'`);
    return LOG_LEVELS.slice(LOG_LEVELS.indexOf(DEFAULT_LOG_LEVEL));
  }
  return LOG_LEVELS.slice(idx);
}

/** The levels `LOG_LEVEL` enables now, parsed once per value (so an unknown value warns once, not per line). */
let parsed: { raw: string | undefined; enabled: ReadonlySet<LogLevel> } | undefined;
const enabled = (level: LogLevel): boolean => {
  const raw = envLogLevel();
  if (!parsed || parsed.raw !== raw) parsed = { raw, enabled: new Set(parseLogLevels(raw)) };
  return parsed.enabled.has(level);
};

/** The default: the console, each line prefixed with its context, each level gated on `LOG_LEVEL`. */
export const consoleLoggerFactory: LoggerFactory = (context) => ({
  debug: (message, ...rest) => {
    if (enabled('debug')) console.debug(`[${context}]`, message, ...rest);
  },
  log: (message, ...rest) => {
    if (enabled('log')) console.log(`[${context}]`, message, ...rest);
  },
  warn: (message, ...rest) => {
    if (enabled('warn')) console.warn(`[${context}]`, message, ...rest);
  },
  error: (message, ...rest) => {
    if (enabled('error')) console.error(`[${context}]`, message, ...rest);
  },
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
