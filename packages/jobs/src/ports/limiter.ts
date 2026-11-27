/**
 * A shared quota (model × API key, or a tenant's share of one). Every call that names it draws on it, so a
 * throttle slows every caller, not only the call that hit it.
 */
export interface Limiter {
  /** Waits for a slot and for budget. `tokens` is an estimate, corrected on release. */
  acquire(cost: { tokens: number }, signal?: AbortSignal): Promise<Permit>;
}

export interface Permit {
  /**
   * throttled (429): wait out Retry-After, halve the effective in-flight cap, and recover by 1 per 20 OK calls. A
   * shared adapter's release settles once its store has it (a 429's block included); the engine doesn't wait for it.
   */
  release(outcome?: {
    tokens?: number;
    throttled?: boolean;
    retryAfterMs?: number;
  }): void | Promise<void>;
}

export interface LimiterConfig {
  inFlight: number;
  callsPerMinute?: number;
  tokensPerMinute?: number;
  /**
   * How long a slot is held before it frees itself, so a holder that crashed (or never released) cannot keep it.
   * Outlives the longest call. Default `DEFAULT_LEASE_MS` (5 minutes).
   */
  leaseMs?: number;
}

/** A slot outlives the longest call: 5 minutes. */
export const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * Every limiter of a process, found by name and bucket. `name` picks the config ('decisions'), `key` the bucket
 * ('decisions', or 'decisions:<tenantId>' for a limit per tenant). The same (name, key) is the same
 * bucket for every caller of one `Limiters`, and, for a shared adapter (`@pattern-stack/jobs/redis`), across processes.
 */
export interface Limiters {
  get(name: string, key: string): Limiter;
}
