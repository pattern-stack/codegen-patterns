import { JobDefinitionError } from '../model/errors.ts';
import { byCodeUnit } from '../model/order.ts';

/**
 * A step's limiter: `'llm-calls'` (one bucket for every run) or `{ name: 'decisions', per: 'tenant' }`
 * (one bucket per tenant, `decisions:<tenantId>`). The name finds the limiter's config.
 */
export type LimiterRef = string | { name: string; per: 'tenant' };

/** One limiter or several: a call takes every one of them. */
export type LimiterRefs = LimiterRef | readonly LimiterRef[];

/** A limiter as the engine holds it: its name and its scope. */
export interface StepLimiter {
  name: string;
  /** `global`: one bucket for every run; `tenant`: one per tenant. */
  per: 'global' | 'tenant';
}

const isList = (r: LimiterRefs): r is readonly LimiterRef[] => Array.isArray(r);

/**
 * The refs as the engine takes them: sorted by name, so every call takes its limiters in one order and two calls never
 * wait on each other's slots. A name named twice is a definition error.
 */
export function stepLimitersOf(refs: LimiterRefs | undefined): StepLimiter[] {
  if (refs === undefined) return [];
  const list: readonly LimiterRef[] = isList(refs) ? refs : [refs];
  const out = list.map((r): StepLimiter => {
    const name = typeof r === 'string' ? r : r.name;
    if (!name) throw new JobDefinitionError('a limiter has a name');
    return { name, per: typeof r === 'string' ? 'global' : 'tenant' };
  });
  out.sort((a, b) => byCodeUnit(a.name, b.name));
  for (let i = 1; i < out.length; i++)
    if ((out[i] as StepLimiter).name === (out[i - 1] as StepLimiter).name)
      throw new JobDefinitionError(
        `a step names the limiter ${(out[i] as StepLimiter).name} twice`,
      );
  return out;
}

/** The bucket a limiter draws on for one run: its name, or its name and the run's tenant. */
export const limiterKey = (l: StepLimiter, tenantId: string): string =>
  l.per === 'tenant' ? `${l.name}:${tenantId}` : l.name;
