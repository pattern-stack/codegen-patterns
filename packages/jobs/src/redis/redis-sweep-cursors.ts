import type { SweepCursors } from '../ports/sweep-cursors.ts';
import type { RedisScripting } from './redis-limiters.ts';

const GET = `return redis.call('GET', KEYS[1])`;
const SET = `if ARGV[1] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[1]) end return 1`;

/**
 * Sweep cursors on Redis or Valkey, one per name for every process: whichever worker the scheduled sweep lands on
 * continues where the last one, on any worker, left off. Prefix default `jobs:sweep`.
 */
export function redisSweepCursors(
  client: RedisScripting,
  options: { prefix?: string } = {},
): SweepCursors {
  const prefix = options.prefix ?? 'jobs:sweep';
  return {
    async get(name) {
      const value = await client.eval(GET, [`${prefix}:${name}`], []);
      return typeof value === 'string' && value ? value : undefined;
    },
    async set(name, after) {
      await client.eval(SET, [`${prefix}:${name}`], [after ?? '']);
    },
  };
}
