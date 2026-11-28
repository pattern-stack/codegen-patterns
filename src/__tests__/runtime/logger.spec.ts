/**
 * The runtime's logger port (PW-0): a logger prints through whichever factory is
 * bound when it is called, including one made before the binding, and the Nest
 * binding routes to Nest's `Logger`.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger as NestLogger } from '@nestjs/common';

import {
  consoleLoggerFactory,
  createLogger,
  getLoggerFactory,
  setLoggerFactory,
  type Logger,
} from '../../../runtime/logger';
import { nestLoggerFactory, useNestLogger } from '../../../runtime/nest-logger';

function recorder() {
  const lines: Array<[string, string, unknown]> = [];
  const factory = (context: string): Logger => ({
    debug: (m) => void lines.push([context, 'debug', m]),
    log: (m) => void lines.push([context, 'log', m]),
    warn: (m) => void lines.push([context, 'warn', m]),
    error: (m) => void lines.push([context, 'error', m]),
  });
  return { lines, factory };
}

afterEach(() => {
  mock.restore();
  setLoggerFactory(consoleLoggerFactory);
});

describe('the logger port', () => {
  it('defaults to the console, prefixed with the context', () => {
    expect(getLoggerFactory()).toBe(consoleLoggerFactory);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    createLogger('Thing').warn('careful', 42);
    expect(warn).toHaveBeenCalledWith('[Thing]', 'careful', 42);
  });

  it('prints a logger made before the binding through the factory bound later', () => {
    const early = createLogger('Early');
    const { lines, factory } = recorder();
    setLoggerFactory(factory);
    early.log('hello');
    early.error('bad');
    expect(lines).toEqual([
      ['Early', 'log', 'hello'],
      ['Early', 'error', 'bad'],
    ]);
  });

  it('makes one logger per context per factory, not one per call', () => {
    let made = 0;
    setLoggerFactory((context) => {
      made += 1;
      return consoleLoggerFactory(context);
    });
    spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = createLogger('Once');
    logger.log('a');
    logger.log('b');
    expect(made).toBe(1);
  });

  it('follows a rebinding', () => {
    const logger = createLogger('Moves');
    const first = recorder();
    const second = recorder();
    setLoggerFactory(first.factory);
    logger.log('one');
    setLoggerFactory(second.factory);
    logger.log('two');
    expect(first.lines).toEqual([['Moves', 'log', 'one']]);
    expect(second.lines).toEqual([['Moves', 'log', 'two']]);
  });

  it('prints debug on the console only under LOG_LEVEL=debug', () => {
    const debug = spyOn(console, 'debug').mockImplementation(() => undefined);
    const saved = process.env.LOG_LEVEL;
    try {
      delete process.env.LOG_LEVEL;
      createLogger('Quiet').debug('hidden');
      expect(debug).not.toHaveBeenCalled();
      process.env.LOG_LEVEL = 'debug';
      createLogger('Loud').debug('shown');
      expect(debug).toHaveBeenCalledWith('[Loud]', 'shown');
    } finally {
      if (saved === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = saved;
    }
  });

  it('gates every console level on the LOG_LEVEL threshold, as parseLogLevels reads it', () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const saved = process.env.LOG_LEVEL;
    try {
      process.env.LOG_LEVEL = 'warn';
      const logger = createLogger('Threshold');
      logger.log('dropped');
      logger.warn('kept');
      expect(log).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[Threshold]', 'kept');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      if (saved === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = saved;
    }
  });

  it('useNestLogger leaves a factory the app bound on purpose', () => {
    const { factory } = recorder();
    setLoggerFactory(factory);
    useNestLogger();
    expect(getLoggerFactory()).toBe(factory);
  });

  it('binds to Nest’s Logger with useNestLogger', () => {
    useNestLogger();
    expect(getLoggerFactory()).toBe(nestLoggerFactory);
    const warn = spyOn(NestLogger.prototype, 'warn').mockImplementation(() => undefined);
    createLogger('Nested').warn('through nest');
    expect(warn).toHaveBeenCalledWith('through nest');
  });
});
