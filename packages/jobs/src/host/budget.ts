import type { AnyJob } from '../define/define-job.ts';
import type { JobLimits } from '../define/facts.ts';
import type { Budget } from '../model/run.ts';

/** A budget as a caller asks for it: each field optional, the deadline as a duration from now. */
export interface AskedBudget {
  maxItems?: number;
  maxUsd?: number;
  maxCalls?: number;
  maxDurationMs?: number;
}

/** A budget the rule refuses: `budget_over_limit` (with the job's limits) or `budget_required`. */
export class JobBudgetError extends Error {
  constructor(
    readonly code: 'budget_over_limit' | 'budget_required',
    message: string,
    readonly limits?: JobLimits,
  ) {
    super(message);
    this.name = 'JobBudgetError';
  }
}

/**
 * The one budget rule, framework-free: an omitted field is the job's limit, and the deadline runs from `now`. With
 * `ceiling` (the public view) every asked field must be at most the job's limit (`budget_over_limit`); without it (the
 * operator and the system) nothing caps it. A job with no limits needs `maxItems` (`budget_required`). The Nest layer's
 * `budgetFor` maps the error to its 400s.
 */
export function resolveBudget(
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
      throw new JobBudgetError('budget_over_limit', "Each budget field must be at most the job's limit", l);
  }
  const maxItems = ask.maxItems ?? limits.maxItems;
  if (maxItems === undefined)
    throw new JobBudgetError('budget_required', 'This job declares no limits: name budget.maxItems');
  const maxDurationMs = ask.maxDurationMs ?? limits.maxDurationMs;
  return {
    maxItems,
    maxUsd: ask.maxUsd ?? limits.maxUsd,
    maxCalls: ask.maxCalls ?? limits.maxCalls,
    deadline: maxDurationMs === undefined ? undefined : new Date(options.now.getTime() + maxDurationMs),
  };
}
