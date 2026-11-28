import type { RedisScripting } from './redis-limiters.ts';

/**
 * A Redis client's `EVAL` as ioredis (and node-redis's legacy mode) spell it: the script, the number of keys, then the
 * keys and the arguments in one list. Structural, so the package imports no Redis library.
 */
export interface RedisEvalClient {
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
}

/** The adapter's one call (`RedisScripting`) over a host's client: the keys counted, then keys and arguments in order. */
export const evalScripting = (client: RedisEvalClient): RedisScripting => ({
  eval: (script, keys, args) =>
    client.eval(script, keys.length, ...keys, ...args),
});
