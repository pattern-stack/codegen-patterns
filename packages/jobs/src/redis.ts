/**
 * `@pattern-stack/jobs/redis`: limiters and sweep cursors held across processes, on Redis or Valkey. It has no dependency of its own: the app
 * hands in its client as `RedisScripting` (one `eval`), or an ioredis-shaped client through `evalScripting`, the way the Postgres store takes its database.
 */

export { evalScripting, type RedisEvalClient } from './redis/eval-scripting.ts';
export {
  type RedisLimitersOptions,
  type RedisScripting,
  redisLimiters,
} from './redis/redis-limiters.ts';
export { redisSweepCursors } from './redis/redis-sweep-cursors.ts';
