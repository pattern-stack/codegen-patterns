import { describe, expect, test } from 'bun:test';
import { evalScripting } from '../eval-scripting.ts';

describe('evalScripting', () => {
  test('adapts an ioredis-shaped eval: the keys counted, then keys and arguments in order', async () => {
    const calls: unknown[][] = [];
    const scripting = evalScripting({
      eval: async (...args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(await scripting.eval('return 0', ['k1', 'k2'], [1, 'a'])).toBe(0);
    expect(calls).toEqual([['return 0', 2, 'k1', 'k2', 1, 'a']]);
  });
});
