/**
 * Error classifier unit tests (JOB-3).
 *
 * Covers the retryable vs. non-retryable decision path used by
 * `JobWorker.processRun`'s catch branch. `nonRetryableErrors` matches on
 * both `.name` and `.code`.
 */
import { describe, it, expect } from 'bun:test';
import { classifyError } from '../../../../runtime/subsystems/jobs/job-worker';
import type { RetryPolicy } from '../../../../runtime/subsystems/jobs/job-handler.base';

const policy: RetryPolicy = {
  attempts: 3,
  backoff: 'fixed',
  baseMs: 100,
  nonRetryableErrors: ['ValidationError', 'PERMISSION_DENIED'],
};

describe('classifyError', () => {
  it('returns fail when no policy is provided', () => {
    expect(classifyError(new Error('x'), undefined, 0)).toBe('fail');
  });

  it('retries a generic error while attempts remain', () => {
    const err = new Error('transient');
    expect(classifyError(err, policy, 0)).toBe('retry');
    expect(classifyError(err, policy, 1)).toBe('retry');
  });

  it('fails when attempts reach the policy cap', () => {
    const err = new Error('transient');
    expect(classifyError(err, policy, 2)).toBe('fail');
    expect(classifyError(err, policy, 5)).toBe('fail');
  });

  it('fails immediately for a blacklisted error.name', () => {
    class ValidationError extends Error {
      override name = 'ValidationError';
    }
    expect(classifyError(new ValidationError('bad input'), policy, 0)).toBe('fail');
  });

  it('fails immediately for a blacklisted error.code', () => {
    const err = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    expect(classifyError(err, policy, 0)).toBe('fail');
  });

  it('retries errors whose name/code are not in the list', () => {
    const err = Object.assign(new Error('boom'), { code: 'UNKNOWN_NETWORK' });
    expect(classifyError(err, policy, 0)).toBe('retry');
  });
});
