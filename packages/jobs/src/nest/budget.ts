import { BadRequestException } from '@nestjs/common';
import type { AnyJob, Budget } from '../index.ts';
import { type AskedBudget, JobBudgetError, resolveBudget } from '../host/budget.ts';
import { JobBudgetOverLimitError } from './jobs.errors.ts';

/**
 * The one budget rule (`resolveBudget`, framework-free) with its refusals as the Nest host's 400s: an asked field over
 * the job's limit is `budget_over_limit`, a job with no limits and no `maxItems` is `budget_required`.
 */
export function budgetFor(
  job: AnyJob,
  asked: AskedBudget | undefined,
  options: { now: Date; ceiling: boolean },
): Budget {
  try {
    return resolveBudget(job, asked, options);
  } catch (err) {
    if (!(err instanceof JobBudgetError)) throw err;
    if (err.code === 'budget_over_limit' && err.limits) throw new JobBudgetOverLimitError(err.limits);
    throw new BadRequestException({ message: err.message, code: err.code });
  }
}
