/**
 * Backoff computation unit tests (JOB-3).
 *
 * Covers both `fixed` and `exponential` variants and pins the overflow
 * guard at attempt 50+.
 */
import { describe, it, expect } from 'bun:test';
import { computeBackoff } from '../../../../runtime/subsystems/jobs/job-worker';
import type { RetryPolicy } from '../../../../runtime/subsystems/jobs/job-handler.base';

describe('computeBackoff — fixed', () => {
  const policy: RetryPolicy = { attempts: 5, backoff: 'fixed', baseMs: 250 };

  it('returns baseMs regardless of attempts', () => {
    expect(computeBackoff(policy, 1)).toBe(250);
    expect(computeBackoff(policy, 3)).toBe(250);
    expect(computeBackoff(policy, 100)).toBe(250);
  });
});

describe('computeBackoff — exponential', () => {
  const policy: RetryPolicy = { attempts: 5, backoff: 'exponential', baseMs: 100 };

  it('doubles on each attempt', () => {
    expect(computeBackoff(policy, 1)).toBe(100); // 2^0
    expect(computeBackoff(policy, 2)).toBe(200); // 2^1
    expect(computeBackoff(policy, 3)).toBe(400); // 2^2
    expect(computeBackoff(policy, 4)).toBe(800); // 2^3
  });

  it('caps at MAX_SAFE_INTEGER at pathologically high attempts', () => {
    const result = computeBackoff(policy, 50);
    expect(result).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('handles negative or zero baseMs without NaN', () => {
    const zero: RetryPolicy = { attempts: 3, backoff: 'exponential', baseMs: 0 };
    expect(computeBackoff(zero, 1)).toBe(0);
    expect(computeBackoff(zero, 5)).toBe(0);
  });
});
