/**
 * CompactConsoleLogger + LOG_LEVEL threshold unit tests.
 *
 * Covers:
 *   - parseLogLevels: default → log-and-above; explicit thresholds; garbage
 *     input falls back to the default with a warning.
 *   - CompactConsoleLogger format: no `[Nest]`/pid prefix, HH:mm:ss timestamp,
 *     5-wide level padding, context preserved.
 *   - level suppression: a `debug` line is dropped at the default threshold.
 */
import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import type { LogLevel } from '@nestjs/common';

import {
  parseLogLevels,
  createAppLogger,
  CompactConsoleLogger,
} from '../../../../runtime/shared/logging';

/** Strip ANSI color escapes so format assertions are color-config-independent. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

describe('parseLogLevels', () => {
  it("defaults to 'log' and above when LOG_LEVEL is unset", () => {
    expect(parseLogLevels(undefined)).toEqual(['log', 'warn', 'error', 'fatal']);
  });

  it('enables the threshold level and everything above it', () => {
    expect(parseLogLevels('debug')).toEqual([
      'debug',
      'log',
      'warn',
      'error',
      'fatal',
    ]);
    expect(parseLogLevels('verbose')).toEqual([
      'verbose',
      'debug',
      'log',
      'warn',
      'error',
      'fatal',
    ]);
    expect(parseLogLevels('warn')).toEqual(['warn', 'error', 'fatal']);
    expect(parseLogLevels('error')).toEqual(['error', 'fatal']);
    expect(parseLogLevels('fatal')).toEqual(['fatal']);
  });

  it('is case-insensitive', () => {
    expect(parseLogLevels('DEBUG')).toEqual(parseLogLevels('debug'));
    expect(parseLogLevels('Warn')).toEqual(parseLogLevels('warn'));
  });

  it('falls back to the default with a warning on garbage input', () => {
    const warn = mock(() => undefined);
    const original = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      const levels = parseLogLevels('shout');
      expect(levels).toEqual(['log', 'warn', 'error', 'fatal']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('shout');
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain("defaulting to 'log'");
    } finally {
      console.warn = original;
    }
  });

  it('reads process.env.LOG_LEVEL when no arg is given', () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'error';
    try {
      expect(parseLogLevels()).toEqual(['error', 'fatal']);
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });
});

/** Exposes the protected formatMessage for direct format assertions. */
class TestLogger extends CompactConsoleLogger {
  public format(
    level: LogLevel,
    message: unknown,
    contextMessage: string,
  ): string {
    // pidMessage / formattedLogLevel are unused by the override; pass blanks.
    return (
      this as unknown as {
        formatMessage(
          l: LogLevel,
          m: unknown,
          p: string,
          f: string,
          c: string,
          t: string,
        ): string;
      }
    ).formatMessage(level, message, '', '', contextMessage, '');
  }
}

describe('CompactConsoleLogger format', () => {
  it('drops the [Nest] <pid> - preamble', () => {
    const line = stripAnsi(new TestLogger().format('log', 'hello', '[Boot] '));
    expect(line).not.toContain('[Nest]');
    // No process-id digits run before the timestamp.
    expect(line.startsWith('[Nest]')).toBe(false);
  });

  it('uses an HH:mm:ss timestamp, not a full locale date', () => {
    const line = stripAnsi(new TestLogger().format('log', 'hello', ''));
    // Leads with HH:mm:ss (24-hour).
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} /);
    // None of the locale-date artifacts Nest's default prints.
    expect(line).not.toContain('AM');
    expect(line).not.toContain('PM');
    expect(line).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('pads the level to 5 chars and preserves context + message', () => {
    const line = stripAnsi(new TestLogger().format('log', 'hello world', '[Boot] '));
    // `LOG` padded to width 5 → two leading spaces.
    expect(line).toContain('  LOG ');
    expect(line).toContain('[Boot] ');
    expect(line).toContain('hello world');
    // Single trailing newline.
    expect(line.endsWith('\n')).toBe(true);
  });

  it('keeps wider levels unpadded-beyond-content (WARN/ERROR are 5 chars)', () => {
    expect(stripAnsi(new TestLogger().format('warn', 'x', ''))).toContain('WARN ');
    expect(stripAnsi(new TestLogger().format('error', 'x', ''))).toContain('ERROR ');
    expect(stripAnsi(new TestLogger().format('debug', 'x', ''))).toContain('DEBUG ');
  });
});

describe('createAppLogger — level suppression', () => {
  let stdout: ReturnType<typeof mock>;
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    stdout = mock(() => true);
    process.stdout.write = stdout as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('suppresses debug at the default (log) threshold', () => {
    const logger = createAppLogger(); // default → log and above
    logger.debug('should-be-suppressed', 'Ctx');
    logger.log('should-print', 'Ctx');

    const written = stdout.mock.calls.map((c) => stripAnsi(String(c[0]))).join('');
    expect(written).not.toContain('should-be-suppressed');
    expect(written).toContain('should-print');
  });

  it('emits debug when the explicit threshold is debug', () => {
    const logger = createAppLogger('debug');
    logger.debug('now-visible', 'Ctx');

    const written = stdout.mock.calls.map((c) => stripAnsi(String(c[0]))).join('');
    expect(written).toContain('now-visible');
  });

  it('the explicit threshold overrides the env var', () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug'; // env would enable debug…
    try {
      const logger = createAppLogger('warn'); // …but the explicit arg wins.
      logger.debug('env-says-debug', 'Ctx');
      logger.log('still-quiet', 'Ctx');
      logger.warn('this-prints', 'Ctx');

      const written = stdout.mock.calls
        .map((c) => stripAnsi(String(c[0])))
        .join('');
      expect(written).not.toContain('env-says-debug');
      expect(written).not.toContain('still-quiet');
      expect(written).toContain('this-prints');
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });
});
