import { NonRetryableError } from '../model/errors.ts';

/**
 * Temporal's retry-policy shape, so a Temporal executor takes it as is. The delay before
 * attempt n + 1 is `initialIntervalMs × backoffCoefficient^(n − 1)`, capped at `maximumIntervalMs`. A coefficient of
 * 1 is a fixed delay.
 */
export interface RetryPolicy {
  initialIntervalMs: number;
  /** ≥ 1. Default 2. */
  backoffCoefficient: number;
  /** Default 100 × the initial interval (Temporal's default). */
  maximumIntervalMs?: number;
  /** Attempts in all, the first included. 0 is unlimited (Temporal's convention). */
  maximumAttempts: number;
  /** Error types (`.name`, or a `.code`) that never retry, on top of every `NonRetryableError`. */
  nonRetryableErrorTypes?: readonly string[];
}

/** Three attempts, 1 s then 2 s; a definition's own mistakes never retry. */
export const DEFAULT_RETRY: RetryPolicy = {
  initialIntervalMs: 1_000,
  backoffCoefficient: 2,
  maximumIntervalMs: 100_000,
  maximumAttempts: 3,
  nonRetryableErrorTypes: ['JobDefinitionError'],
};

/** The delay after `attempts` attempts (≥ 1), never above the maximum interval. */
export function computeBackoff(policy: RetryPolicy, attempts: number): number {
  const initial = Math.max(policy.initialIntervalMs, 0);
  const max = Math.max(policy.maximumIntervalMs ?? initial * 100, initial);
  const coefficient = Math.max(policy.backoffCoefficient, 1);
  const exponent = Math.max(attempts - 1, 0);
  const raw = initial * coefficient ** exponent;
  return Number.isFinite(raw) ? Math.min(raw, max) : max;
}

/** Whether an error must never be retried under a policy: a `NonRetryableError`, or a listed type. */
export function isNonRetryable(
  err: unknown,
  policy: RetryPolicy | undefined,
): boolean {
  if (err instanceof NonRetryableError) return true;
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    name?: unknown;
    code?: unknown;
  };
  const listed = policy?.nonRetryableErrorTypes ?? [];
  return listed.some((n) => n === e.name || n === e.code);
}

/** Whether attempts remain after `attemptsBefore + 1` attempts. */
export const attemptsLeft = (
  policy: RetryPolicy,
  attemptsSoFar: number,
): boolean =>
  policy.maximumAttempts <= 0 || attemptsSoFar < policy.maximumAttempts;

/**
 * Retry while attempts remain and the error may be retried. `attemptsBefore` counts the attempts before this one.
 * No policy means no retry.
 */
export function classifyError(
  err: unknown,
  policy: RetryPolicy | undefined,
  attemptsBefore: number,
): 'retry' | 'fail' {
  if (!policy) return 'fail';
  if (isNonRetryable(err, policy)) return 'fail';
  return attemptsLeft(policy, attemptsBefore + 1) ? 'retry' : 'fail';
}
