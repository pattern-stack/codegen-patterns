import { JobDefinitionError } from '../model/errors.ts';
import type { AnyJob, JobDefinition } from './define-job.ts';
import type { ErasedChildrenStep, ErasedContext, StepDef } from './step.ts';

/** A child's own budget, over the even share of what its parent has left (d19). */
export interface ChildBudget {
  maxUsd?: number;
  maxCalls?: number;
  maxItems?: number;
}

/** One child a children step declares: its slot's key (a meaning and an id, never content), input and budget. */
export interface ChildSpec<CI> {
  key: string;
  input: CI;
  /** Its own budget; without one, an even share of what the parent has left. */
  budget?: ChildBudget;
}

/** A children step's output, read back from its slots and the children's own outputs. */
export interface ChildResults<O> {
  results: { key: string; runId: string; output: O }[];
  failed: { key: string; runId: string; errorType: string }[];
  skipped: { key: string; runId: string }[];
}

/**
 * What a failed child does to the step: `hold` (the default) waits for an operator's retry or skip; `continue` puts
 * it in the output's `failed`; `fail` fails the step once every slot has settled.
 */
export type ChildFailure = 'hold' | 'continue' | 'fail';

export interface ChildrenStepDefinition<C, Out> extends StepDef<C, Out> {
  readonly kind: 'children';
}

export interface ChildrenOptions<C, CI, CO, COuts> {
  /** The child job: its input and output type the step. It must be in the same registry. */
  job: JobDefinition<CI, CO, COuts>;
  /** A function of the context only, so the same context gives the same keys. At most 100. */
  each: (
    ctx: C,
  ) =>
    | readonly ChildSpec<NoInfer<CI>>[]
    | Promise<readonly ChildSpec<NoInfer<CI>>[]>;
  onFailure?: ChildFailure;
}

const erase = (
  job: AnyJob,
  each: ErasedChildrenStep['each'],
  onFailure: ChildFailure,
  single: boolean,
): ErasedChildrenStep => ({
  kind: 'children',
  job,
  each,
  onFailure,
  single,
  gates: [],
  limiters: [],
  retry: undefined,
  effect: 'idempotent',
});

/**
 * Starts child runs and waits for them: every child the step declares starts in one store write, one per key for
 * good, and the step waits (`waiting`, nothing in flight) until each slot has settled. Its output is read back from
 * the slots and the children's outputs, never stored twice.
 */
export function children<C, CI, CO, COuts>(
  options: ChildrenOptions<C, CI, CO, COuts>,
): ChildrenStepDefinition<C, ChildResults<CO>> {
  const { job, each } = options;
  return {
    kind: 'children',
    erased: erase(
      job as unknown as AnyJob,
      async (ctx: ErasedContext) => [...(await each(ctx as C))],
      options.onFailure ?? 'hold',
      false,
    ),
  };
}

/**
 * One child, whose output is the step's. A failed child holds the step for a retry; there is no skip, since with no
 * output there is nothing to go on with (cancel the parent instead).
 */
export function child<C, CI, CO, COuts>(options: {
  job: JobDefinition<CI, CO, COuts>;
  input: (ctx: C) => NoInfer<CI> | Promise<NoInfer<CI>>;
  budget?: ChildBudget;
}): ChildrenStepDefinition<C, CO> {
  const { job, input, budget } = options;
  return {
    kind: 'children',
    erased: erase(
      job as unknown as AnyJob,
      async (ctx: ErasedContext) => [
        { key: SINGLE_CHILD_KEY, input: await input(ctx as C), budget },
      ],
      'hold',
      true,
    ),
  };
}

/** The one slot of a `child` step. */
export const SINGLE_CHILD_KEY = 'child';

/** A child key: a meaning and an id, never content, the time or an attempt. */
export function assertChildKeys(
  where: string,
  specs: readonly { key: string }[],
): void {
  const seen = new Set<string>();
  for (const { key } of specs) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 255)
      throw new JobDefinitionError(
        `${where}: a child key is 1 to 255 characters`,
      );
    if (seen.has(key))
      throw new JobDefinitionError(`${where}: two children are keyed ${key}`);
    seen.add(key);
  }
}
