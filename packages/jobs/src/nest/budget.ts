import { BadRequestException } from '@nestjs/common';
import type { AnyJob, Budget, JobLimits } from '../index.ts';
import { JobBudgetOverLimitError } from './jobs.errors.ts';

/** A budget as a caller asks for it: each field optional, the deadline as a duration from now. */
export interface AskedBudget {
  maxItems?: number;
  maxUsd?: number;
  maxCalls?: number;
  maxDurationMs?: number;
}

/**
 * The one budget rule: an omitted field is the job's limit, and the deadline runs from `now`. With `ceiling` (the
 * public view) every asked field must be at most the job's limit (400 `budget_over_limit`); without it (the operator
 * and the system) nothing caps it. A job with no limits needs `maxItems` (400 `budget_required`).
 */
export function budgetFor(
  job: AnyJob,
  asked: AskedBudget | undefined,
  options: { now: Date; ceiling: boolean },
): Budget {
  const limits: Partial<JobLimits> = job.limits ?? {};
  const ask = asked ?? {};
  if (options.ceiling && job.limits) {
    const l = job.limits;
    if (
      (ask.maxItems ?? 0) > l.maxItems ||
      (ask.maxUsd ?? 0) > l.maxUsd ||
      (ask.maxCalls ?? 0) > l.maxCalls ||
      (ask.maxDurationMs ?? 0) > l.maxDurationMs
    )
      throw new JobBudgetOverLimitError(l);
  }
  const maxItems = ask.maxItems ?? limits.maxItems;
  if (maxItems === undefined)
    throw new BadRequestException({
      message: 'This job declares no limits: name budget.maxItems',
      code: 'budget_required',
    });
  const maxDurationMs = ask.maxDurationMs ?? limits.maxDurationMs;
  return {
    maxItems,
    maxUsd: ask.maxUsd ?? limits.maxUsd,
    maxCalls: ask.maxCalls ?? limits.maxCalls,
    deadline:
      maxDurationMs === undefined
        ? undefined
        : new Date(options.now.getTime() + maxDurationMs),
  };
}
