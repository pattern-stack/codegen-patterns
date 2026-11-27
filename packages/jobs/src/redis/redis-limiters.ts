import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITER } from '../adapters/local-limiter.ts';
import {
  DEFAULT_LEASE_MS,
  type Limiter,
  type LimiterConfig,
  type Limiters,
  type Permit,
} from '../ports/limiter.ts';

/**
 * The one Redis call the limiters make, structurally, so the package imports no Redis library: the app hands in its
 * own client (Valkey through ioredis: `{ eval: (s, keys, args) => redis.eval(s, keys.length, ...keys, ...args) }`).
 */
export interface RedisScripting {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown>;
}

export interface RedisLimitersOptions {
  /** The config of a name `config` doesn't list. Default `DEFAULT_LIMITER`. */
  fallback?: LimiterConfig;
  /** Key prefix. Default `jobs:limiter`. */
  prefix?: string;
  /** Milliseconds now; every holder's clock must agree to within a call. Default `Date.now`. */
  clock?: () => number;
}

const MINUTE = 60_000;
/** A 429 with no Retry-After still waits this long. */
const DEFAULT_THROTTLE_MS = 1_000;
/** OK calls it takes to win back one in-flight slot after a throttle. */
const RECOVER_EVERY = 20;

/**
 * Takes a slot when one is free and the window has room: drops expired leases and window entries first. Returns 0 on
 * success, else a positive hint (ms) of how long the wait is. KEYS: leases (zset, scored by expiry), window (zset,
 * scored by start), tokens (hash, window member → tokens), blocked (a 429's until). ARGV: now, leaseMs, cap, calls per
 * minute (0: none), tokens per minute (0: none), tokens, lease id.
 */
const ACQUIRE = `
local now = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local cpm = tonumber(ARGV[4])
local tpm = tonumber(ARGV[5])
local tokens = tonumber(ARGV[6])
local id = ARGV[7]
local blocked = tonumber(redis.call('GET', KEYS[4]) or '0')
if blocked > now then return blocked - now end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= cap then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return math.max(1, tonumber(first[2]) - now)
end
local cutoff = now - ${MINUTE}
local old = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', cutoff)
if #old > 0 then
  redis.call('HDEL', KEYS[3], unpack(old))
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
end
if cpm > 0 then
  local n = redis.call('ZCARD', KEYS[2])
  if n >= cpm then
    local e = redis.call('ZRANGE', KEYS[2], n - cpm, n - cpm, 'WITHSCORES')
    return math.max(1, tonumber(e[2]) + ${MINUTE} - now)
  end
end
if tpm > 0 then
  local need = math.min(tokens, tpm)
  local members = redis.call('ZRANGE', KEYS[2], 0, -1, 'WITHSCORES')
  local used = 0
  local spent = {}
  for i = 1, #members, 2 do
    local v = tonumber(redis.call('HGET', KEYS[3], members[i]) or '0')
    spent[#spent + 1] = { v, tonumber(members[i + 1]) }
    used = used + v
  end
  if used + need > tpm then
    local at = now
    for _, e in ipairs(spent) do
      if used + need <= tpm then break end
      used = used - e[1]
      at = e[2] + ${MINUTE}
    end
    return math.max(1, at - now)
  end
end
redis.call('ZADD', KEYS[1], now + leaseMs, id)
redis.call('ZADD', KEYS[2], now, id)
redis.call('HSET', KEYS[3], id, tokens)
redis.call('PEXPIRE', KEYS[1], leaseMs + ${MINUTE})
redis.call('PEXPIRE', KEYS[2], ${2 * MINUTE})
redis.call('PEXPIRE', KEYS[3], ${2 * MINUTE})
return 0
`;

/**
 * Frees a lease (a no-op once it expired: an expired slot is never freed twice), corrects its window entry's tokens,
 * and on a 429 moves every holder's `blocked` forward. ARGV: lease id, tokens (-1: unchanged), blocked until (0: no
 * 429), the block key's TTL.
 */
const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
local t = tonumber(ARGV[2])
if t >= 0 and redis.call('ZSCORE', KEYS[2], ARGV[1]) then
  redis.call('HSET', KEYS[3], ARGV[1], t)
end
local untilMs = tonumber(ARGV[3])
if untilMs > 0 then
  local current = tonumber(redis.call('GET', KEYS[4]) or '0')
  if untilMs > current then redis.call('SET', KEYS[4], untilMs, 'PX', ARGV[4]) end
end
return 0
`;

/** 50–250 ms. */
const jitter = () => 50 + Math.floor(Math.random() * 200);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function redisLimiter(
  client: RedisScripting,
  keyPrefix: string,
  config: LimiterConfig,
  clock: () => number,
): Limiter {
  if (!(config.inFlight >= 1))
    throw new Error('a limiter needs at least 1 call in flight');
  const keys = ['leases', 'window', 'tokens', 'blocked'].map(
    (k) => `${keyPrefix}:${k}`,
  );
  const leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS;
  // The halving after a 429 is this process's own; the block itself is every holder's.
  let cap = config.inFlight;
  let okSinceThrottle = 0;

  const permit = (id: string): Permit => {
    let released = false;
    return {
      release(outcome = {}) {
        if (released) return Promise.resolve();
        released = true;
        let blockedUntil = 0;
        if (outcome.throttled) {
          cap = Math.max(1, Math.floor(cap / 2));
          okSinceThrottle = 0;
          blockedUntil =
            clock() + (outcome.retryAfterMs ?? DEFAULT_THROTTLE_MS);
        } else if (
          cap < config.inFlight &&
          ++okSinceThrottle >= RECOVER_EVERY
        ) {
          cap++;
          okSinceThrottle = 0;
        }
        const ttl = Math.max(blockedUntil - clock(), 0) + MINUTE;
        // A release that cannot reach Redis leaves its lease to expire: the slot frees itself within leaseMs.
        return client
          .eval(RELEASE, keys, [id, outcome.tokens ?? -1, blockedUntil, ttl])
          .then(
            () => undefined,
            () => undefined,
          );
      },
    };
  };

  return {
    async acquire(cost, signal) {
      signal?.throwIfAborted();
      const id = randomUUID();
      for (;;) {
        const wait = Number(
          await client.eval(ACQUIRE, keys, [
            clock(),
            leaseMs,
            cap,
            config.callsPerMinute ?? 0,
            config.tokensPerMinute ?? 0,
            Math.max(0, Math.ceil(cost.tokens)),
            id,
          ]),
        );
        if (wait === 0) return permit(id);
        await sleep(jitter(), signal);
      }
    },
  };
}

/**
 * Every limiter on one Redis (the app's Valkey), held across processes: two workers naming one bucket share its cap.
 * Each bucket is a sorted set of leases scored by expiry (a crashed holder's slot frees itself after `leaseMs`), a
 * sliding window for calls and tokens per minute, and a shared `blocked` key a 429 sets so every holder backs off. A
 * wait polls with jitter (50–250 ms). The config is found by name, the bucket by key.
 */
export function redisLimiters(
  client: RedisScripting,
  config: Readonly<Record<string, LimiterConfig>> = {},
  options: RedisLimitersOptions = {},
): Limiters {
  const prefix = options.prefix ?? 'jobs:limiter';
  const clock = options.clock ?? Date.now;
  const buckets = new Map<string, Limiter>();
  return {
    get(name, key) {
      const existing = buckets.get(key);
      if (existing) return existing;
      // The braces keep a bucket's keys in one cluster slot, which a script needs.
      const made = redisLimiter(
        client,
        `${prefix}:{${key}}`,
        config[name] ?? options.fallback ?? DEFAULT_LIMITER,
        clock,
      );
      buckets.set(key, made);
      return made;
    },
  };
}
