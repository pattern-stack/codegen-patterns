/**
 * Compact console logger + `LOG_LEVEL` threshold.
 *
 * Nest's default `ConsoleLogger` preamble —
 *   `[Nest] <pid>  - <full locale date>   LEVEL [Context] <message>`
 * — is ~55 chars before the message. In a split-pane dev TUI (process-compose,
 * tmux) every line wraps 2–3×, drowning the actual content. And the generated
 * entrypoints pass no `logger:` option, so consumers have no log-level knob:
 * every subsystem `debug` line (e.g. EventScheduler's per-slot `materialised …`)
 * always prints.
 *
 * This module is the proven swe-brain (second-dogfood) consumer pattern lifted
 * into the runtime so consumers stop rebuilding it by hand:
 *
 *   - `CompactConsoleLogger` — drops the `[Nest] <pid>  - ` prefix (a supervisor
 *     pane header already names the process) and shortens the timestamp to
 *     `HH:mm:ss`.
 *   - `parseLogLevels` / the `LOG_LEVEL` env convention — a single severity
 *     threshold enables that level and everything above it (owned by the
 *     Nest-free `runtime/logger.ts`, which the console default reads too).
 *   - `createAppLogger` — the factory the entrypoints hand to `NestFactory`.
 */
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { parseLogLevels } from '../../logger';

const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * A `ConsoleLogger` with a compact one-line format tuned for split-pane TUIs.
 */
export class CompactConsoleLogger extends ConsoleLogger {
  /** Drop `[Nest] <pid>  - ` — a supervisor pane header already identifies the process. */
  protected override formatPid(_pid: number): string {
    return '';
  }

  /** `12:48:42`, not `06/07/2026, 12:48:42 PM`. */
  protected override getTimestamp(): string {
    return TIME.format(Date.now());
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    _pidMessage: string,
    _formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const output = this.stringifyMessage(message, logLevel);
    // padStart(5) (vs Nest's 7) aligns LOG/WARN/DEBUG/ERROR; `verbose` may jitter.
    const level = this.colorize(
      logLevel.toUpperCase().padStart(5, ' '),
      logLevel,
    );
    return `${this.getTimestamp()} ${level} ${contextMessage}${output}${timestampDiff}\n`;
  }
}

/**
 * Build the app-wide logger that entrypoints hand to `NestFactory`.
 *
 * @param threshold explicit `LOG_LEVEL` override. CLI tools that must stay quiet
 *   regardless of the ambient env pass e.g. `'warn'`. When omitted, the
 *   `LOG_LEVEL` env var (then the `'log'` default) wins.
 *
 * @example
 *   const app = await NestFactory.create(AppModule, { logger: createAppLogger() });
 */
export function createAppLogger(threshold?: LogLevel): CompactConsoleLogger {
  return new CompactConsoleLogger('', {
    logLevels: parseLogLevels(threshold ?? process.env.LOG_LEVEL),
    timestamp: true,
  });
}
