import {
  DEFAULT_LEASE_MS,
  DEFAULT_LIMITER,
  DEFAULT_THROTTLE_MS,
  LIMITER_WINDOW_MS as MINUTE,
  RECOVER_EVERY,
  type Limiter,
  type LimiterConfig,
  type Limiters,
  type Permit,
} from '../ports/limiter.ts';



/** Rough token count for a request: characters ÷ 4. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

interface Waiter {
  tokens: number;
  resolve: (permit: Permit) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Spent {
  at: number;
  tokens: number;
}

interface Lease {
  expiresAt: number;
  released: boolean;
}

/**
 * An in-process limiter for one bucket: an in-flight cap, calls and tokens per minute (sliding window), and backoff on
 * 429. A slot not released within its lease (`leaseMs`) frees itself. Every caller in the process that holds it draws on
 * it; across processes, `@pattern-stack/jobs/redis`.
 */
export function localLimiter(
  config: LimiterConfig = DEFAULT_LIMITER,
  clock: () => number = Date.now,
): Limiter & { readonly inFlight: number; readonly cap: number } {
  if (!(config.inFlight >= 1))
    throw new Error('a limiter needs at least 1 call in flight');
  let inFlight = 0;
  let cap = config.inFlight;
  let okSinceThrottle = 0;
  let blockedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const window: Spent[] = [];
  const queue: Waiter[] = [];
  const leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS;
  const leases = new Set<Lease>();

  /** Frees every slot whose lease ran out; the earliest expiry still held, or null. */
  const expire = (now: number): number | null => {
    let next: number | null = null;
    for (const l of leases) {
      if (l.expiresAt <= now) {
        l.released = true;
        leases.delete(l);
        inFlight--;
      } else if (next === null || l.expiresAt < next) next = l.expiresAt;
    }
    return next;
  };

  const prune = (now: number) => {
    while (window.length && (window[0] as Spent).at <= now - MINUTE)
      window.shift();
  };

  /** When the head waiter could go, or 0 for now. */
  const readyAt = (w: Waiter, now: number): number => {
    if (now < blockedUntil) return blockedUntil;
    prune(now);
    let at = 0;
    if (config.callsPerMinute && window.length >= config.callsPerMinute)
      at = Math.max(
        at,
        (window[window.length - config.callsPerMinute] as Spent).at + MINUTE,
      );
    if (config.tokensPerMinute) {
      let used = window.reduce((a, s) => a + s.tokens, 0);
      // A single call larger than the whole quota still goes, alone in its window.
      const need = Math.min(w.tokens, config.tokensPerMinute);
      for (const s of window) {
        if (used + need <= config.tokensPerMinute) break;
        used -= s.tokens;
        at = Math.max(at, s.at + MINUTE);
      }
    }
    return at;
  };

  const pump = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (;;) {
      if (!queue.length) return;
      const now = clock();
      const nextExpiry = expire(now);
      if (inFlight >= cap) {
        // Full: a lease that runs out frees a slot without a release.
        if (nextExpiry !== null)
          timer = setTimeout(pump, Math.max(1, nextExpiry - now));
        return;
      }
      const head = queue[0] as Waiter;
      const at = readyAt(head, now);
      if (at > now) {
        timer = setTimeout(pump, at - now);
        return;
      }
      queue.shift();
      if (head.onAbort) head.signal?.removeEventListener('abort', head.onAbort);
      head.resolve(grant(head.tokens, now));
    }
  };

  const grant = (tokens: number, now: number): Permit => {
    inFlight++;
    const spent: Spent = { at: now, tokens };
    window.push(spent);
    const lease: Lease = { expiresAt: now + leaseMs, released: false };
    leases.add(lease);
    let done = false;
    return {
      release(outcome = {}) {
        if (done) return;
        done = true;
        // A lease that ran out already freed its slot; what the call reports (tokens, a 429) still counts.
        if (!lease.released) {
          lease.released = true;
          leases.delete(lease);
          inFlight--;
        }
        if (outcome.tokens !== undefined) spent.tokens = outcome.tokens;
        if (outcome.throttled) {
          cap = Math.max(1, Math.floor(cap / 2));
          okSinceThrottle = 0;
          blockedUntil = Math.max(
            blockedUntil,
            clock() + (outcome.retryAfterMs ?? DEFAULT_THROTTLE_MS),
          );
        } else if (
          cap < config.inFlight &&
          ++okSinceThrottle >= RECOVER_EVERY
        ) {
          cap++;
          okSinceThrottle = 0;
        }
        pump();
      },
    };
  };

  return {
    get inFlight() {
      expire(clock());
      return inFlight;
    },
    get cap() {
      return cap;
    },
    acquire(cost, signal) {
      signal?.throwIfAborted();
      return new Promise<Permit>((resolve, reject) => {
        const waiter: Waiter = { tokens: cost.tokens, resolve, reject, signal };
        if (signal) {
          waiter.onAbort = () => {
            const i = queue.indexOf(waiter);
            if (i >= 0) queue.splice(i, 1);
            reject(signal.reason);
            pump();
          };
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        queue.push(waiter);
        pump();
      });
    },
  };
}

/**
 * Every limiter of one process, in memory: one `localLimiter` per bucket, made on first use with its name's config
 * (`DEFAULT_LIMITER` for a name `config` doesn't list). Right for in-process runs, tests and scripts, where one process
 * is the whole world; N processes get N times each quota.
 */
export function localLimiters(
  config: Readonly<Record<string, LimiterConfig>> = {},
  options: { fallback?: LimiterConfig; clock?: () => number } = {},
): Limiters {
  const buckets = new Map<string, Limiter>();
  return {
    get(name, key) {
      const existing = buckets.get(key);
      if (existing) return existing;
      const made = localLimiter(
        config[name] ?? options.fallback ?? DEFAULT_LIMITER,
        options.clock,
      );
      buckets.set(key, made);
      return made;
    },
  };
}
