import { describe, expect, test } from 'bun:test';
import { JobDefinitionError, NonRetryableError } from '../model/errors.ts';
import {
  classifyError,
  computeBackoff,
  DEFAULT_RETRY,
  type RetryPolicy,
} from '../policy/retry.ts';
import { firstStop, type ItemOutcome, speculationOf } from '../policy/stop.ts';

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  initialIntervalMs: 100,
  backoffCoefficient: 2,
  maximumAttempts: 5,
  ...over,
});

describe('computeBackoff (Temporal’s shape)', () => {
  test('grows by the coefficient and stops at the maximum interval', () => {
    const p = policy({ maximumIntervalMs: 500 });
    expect([1, 2, 3, 4, 5].map((n) => computeBackoff(p, n))).toEqual([
      100, 200, 400, 500, 500,
    ]);
  });

  test('a coefficient of 1 is a fixed delay; the default maximum is 100 × the initial interval', () => {
    expect(computeBackoff(policy({ backoffCoefficient: 1 }), 7)).toBe(100);
    expect(computeBackoff(policy(), 60)).toBe(10_000);
    expect(computeBackoff(policy(), 5_000)).toBe(10_000);
  });

  test('the default policy: 1 s, then 2 s', () => {
    expect(computeBackoff(DEFAULT_RETRY, 1)).toBe(1_000);
    expect(computeBackoff(DEFAULT_RETRY, 2)).toBe(2_000);
  });
});

describe('classifyError', () => {
  test('retries while attempts remain; maximumAttempts 0 is unlimited', () => {
    expect(classifyError(new Error('x'), policy(), 0)).toBe('retry');
    expect(classifyError(new Error('x'), policy(), 3)).toBe('retry');
    expect(classifyError(new Error('x'), policy(), 4)).toBe('fail');
    expect(
      classifyError(new Error('x'), policy({ maximumAttempts: 0 }), 1_000),
    ).toBe('retry');
    expect(classifyError(new Error('x'), undefined, 0)).toBe('fail');
  });

  test('a NonRetryableError never retries, nor a listed type by name or code', () => {
    expect(classifyError(new NonRetryableError('no'), policy(), 0)).toBe(
      'fail',
    );
    expect(classifyError(new JobDefinitionError('no'), policy(), 0)).toBe(
      'fail',
    );
    const listed = policy({ nonRetryableErrorTypes: ['BadInput', 'E_BAD'] });
    const named = Object.assign(new Error('x'), { name: 'BadInput' });
    const coded = Object.assign(new Error('x'), { code: 'E_BAD' });
    expect(classifyError(named, listed, 0)).toBe('fail');
    expect(classifyError(coded, listed, 0)).toBe('fail');
    expect(classifyError(new Error('x'), listed, 0)).toBe('retry');
    expect(classifyError(new JobDefinitionError('x'), DEFAULT_RETRY, 0)).toBe(
      'fail',
    );
  });
});

describe('firstStop', () => {
  const ok = (key: string, result: number): ItemOutcome<number> => ({
    key,
    ref: key,
    ok: true,
    result,
  });
  const below = (o: ItemOutcome<number>) => o.ok && o.result < 0.5;
  const twoBelow = (
    o: ItemOutcome<number>,
    i: number,
    before: readonly ItemOutcome<number>[],
  ) => below(o) && i > 0 && below(before[i - 1] as ItemOutcome<number>);

  test('the count the result keeps, the stopping item included; null when the prefix holds no stop yet', () => {
    const items = [
      ok('a', 0.9),
      ok('b', 0.2),
      ok('c', 0.8),
      ok('d', 0.1),
      ok('e', 0.3),
      ok('f', 0.9),
    ];
    expect(firstStop(items, twoBelow)).toBe(5);
    expect(firstStop(items.slice(0, 4), twoBelow)).toBeNull();
  });

  test('the predicate sees exactly the items before it', () => {
    const seen: number[] = [];
    firstStop([ok('a', 1), ok('b', 1), ok('c', 1)], (_o, i, before) => {
      seen.push(before.length);
      expect(before.length).toBe(i);
      return false;
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  test('speculation accounting', () => {
    expect(speculationOf(10, 4)).toEqual({
      speculated: 10,
      used: 4,
      overshoot: 6,
    });
    expect(speculationOf(4, 4)).toEqual({
      speculated: 4,
      used: 4,
      overshoot: 0,
    });
  });
});
