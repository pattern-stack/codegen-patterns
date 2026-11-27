import { assertChildKeys, type ChildBudget } from '../define/children.ts';
import type { AnyJob, StepEntry } from '../define/define-job.ts';
import type { Registry } from '../define/registry.ts';
import type { ErasedChildrenStep, ErasedContext } from '../define/step.ts';
import type { NewChild, Slot } from '../model/children.ts';
import {
  errorRecordOf,
  JobDefinitionError,
  NonRetryableError,
  RunPlanningError,
} from '../model/errors.ts';
import type { Budget, Run } from '../model/run.ts';
import type { StepState } from '../model/step-state.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { Executor } from '../ports/executor.ts';
import type { JobStore } from '../ports/job-store.ts';
import { outputReader } from './context.ts';
import type { AdvanceDeps } from './deps.ts';
import { eventBase } from './emitter.ts';
import { submitSoon } from './submit-soon.ts';
import { assertStorable } from './values.ts';

/** A children step whose `onFailure: 'fail'` met a failed child: the step, and so the run, fails. */
export class ChildrenFailedError extends NonRetryableError {
  constructor(step: string, failed: number) {
    super(`${step}: ${failed} child run${failed === 1 ? '' : 's'} failed`);
    this.name = 'ChildrenFailedError';
  }
}

export type ChildrenOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'rests'; status: Run['status'] };

/** What the slots call for: wait, complete, or fail. */
function decide(
  slots: readonly Slot[],
  onFailure: ErasedChildrenStep['onFailure'],
): 'wait' | 'complete' | 'fail' {
  const pending = slots.some((s) => s.status === 'pending');
  const failed = slots.some((s) => s.status === 'failed');
  if (pending) return 'wait';
  if (!failed) return 'complete';
  if (onFailure === 'hold') return 'wait';
  return onFailure === 'fail' ? 'fail' : 'complete';
}

/**
 * Each child's budget: its own over the parent's, else an even share of what the parent has left (`maxUsd`,
 * `maxCalls`, over the slots with no budget of their own); `maxItems` and the deadline are copied (d19).
 */
async function budgetsOf(
  store: JobStore,
  run: Run,
  specs: readonly { budget?: ChildBudget }[],
): Promise<Budget[]> {
  const spent = await store.treeSpend(run.id);
  const shared = specs.filter((s) => !s.budget).length || 1;
  const share = (cap: number | undefined, used: number) =>
    cap === undefined ? undefined : Math.max(0, cap - used) / shared;
  const even: Budget = {
    maxItems: run.budget.maxItems,
    maxUsd: share(run.budget.maxUsd, spent.costUsd),
    maxCalls:
      run.budget.maxCalls === undefined
        ? undefined
        : Math.floor(share(run.budget.maxCalls, spent.calls) ?? 0),
    deadline: run.budget.deadline,
  };
  return specs.map((s) => {
    const b: Budget = { ...even, ...(s.budget ?? {}) };
    if (b.maxUsd === undefined) delete b.maxUsd;
    if (b.maxCalls === undefined) delete b.maxCalls;
    if (b.deadline === undefined) delete b.deadline;
    return b;
  });
}

/** The children a step declares, checked: keys, count, and each input parsed and admitted by the child job. */
async function newChildrenOf(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedChildrenStep },
  ctx: ErasedContext,
): Promise<NewChild[]> {
  const { job } = entry.erased;
  const where = `${run.jobKey}/${entry.name}`;
  if (!deps.registry.has(job.key))
    throw new JobDefinitionError(`${where}: ${job.key} is not registered`);
  const registered = deps.registry.get(job.key);
  const specs = await entry.erased.each(ctx);
  assertChildKeys(where, specs);
  const budgets = await budgetsOf(deps.store, run, specs);
  const out: NewChild[] = [];
  for (const [i, spec] of specs.entries()) {
    const parsed = registered.input.safeParse(spec.input);
    if (!parsed.success)
      throw new RunPlanningError(
        `${where}: child ${spec.key}'s input refused (${parsed.error.issues
          .map((x) => `${x.path.join('.') || '(root)'}: ${x.code}`)
          .join('; ')})`,
      );
    await registered.admit?.(parsed.data, {
      tenantId: run.tenantId,
      dryRun: run.dryRun,
      outputOf: outputReader(deps.store, run.tenantId),
    });
    assertStorable(parsed.data, `${where}: child ${spec.key}'s input`);
    out.push({
      key: spec.key,
      jobKey: registered.key,
      jobVersion: registered.version,
      input: parsed.data,
      budget: budgets[i] as Budget,
    });
  }
  return out;
}

/**
 * The advance at a children step. Unless it is waiting, it starts its children (one store write, one per key for
 * good: a step run again starts nothing new) and submits the ones it started. Then it reads the slots (each pending
 * slot whose child ended takes its outcome) and decides: done, failed under `fail`, or wait. It parks, then reads the
 * slots once more: a child that ended before the park is seen by that read, one that ends after it pokes the waiting
 * step, so no ending is lost.
 */
export async function advanceChildrenStep(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedChildrenStep },
  ctx: ErasedContext,
  state: StepState | undefined,
): Promise<ChildrenOutcome> {
  const { store, clock, events } = deps;
  const step = entry.name;
  const attempt = state?.attempts ?? 1;
  const base = () => ({ ...eventBase(run, clock), step, attempt });
  if (state?.status !== 'waiting') {
    let wanted: NewChild[];
    try {
      wanted = await newChildrenOf(deps, run, entry, ctx);
    } catch (error) {
      if (state) await store.failStep(run.id, step, errorRecordOf(error));
      return { kind: 'failed', error };
    }
    if (!state)
      await events.emit({
        ...eventBase(run, clock),
        step,
        attempt: 1,
        type: 'step.started',
      });
    const { started } = await store.startChildren(
      { runId: run.id, step, index: entry.index },
      wanted,
    );
    for (const slot of started) {
      await events.emit({
        ...base(),
        type: 'child.started',
        childKey: slot.key,
        childRunId: slot.childRunId,
      });
      await submitSoon(deps, slot.childRunId);
    }
  }
  for (let read = 0; read < 2; read++) {
    const { slots, ended } = await store.settleSlots(run.id, step);
    for (const slot of ended)
      await events.emit({
        ...base(),
        type: 'child.ended',
        childKey: slot.key,
        childRunId: slot.childRunId,
        errorType: slot.errorType,
      });
    const next = decide(slots, entry.erased.onFailure);
    if (next === 'complete') {
      await store.unpark(run.id, step);
      await store.recordStep(run.id, step, { status: 'completed' });
      const after = (await store.stepStates(run.id)).find(
        (s) => s.name === step,
      );
      await events.emit({
        ...base(),
        type: 'step.completed',
        counts: after?.counts ?? {
          total: 0,
          done: 0,
          cached: 0,
          failed: 0,
          skipped: 0,
        },
        speculation: null,
      });
      return { kind: 'completed' };
    }
    if (next === 'fail') {
      const failed = slots.filter((s) => s.status === 'failed').length;
      const error = new ChildrenFailedError(step, failed);
      await store.unpark(run.id, step);
      await store.failStep(run.id, step, errorRecordOf(error));
      await events.emit({
        ...base(),
        type: 'step.failed',
        errorType: error.name,
      });
      return { kind: 'failed', error };
    }
    if (read > 0) break;
    const parked = await store.park(
      run.id,
      { name: step, index: entry.index, kind: 'children' },
      { kind: 'children', name: entry.erased.job.key, wakeAt: null },
    );
    if (!parked)
      return { kind: 'rests', status: (await store.getRun(run.id)).status };
    if (state?.status !== 'waiting')
      await events.emit({
        ...base(),
        type: 'step.waiting',
        waitKind: 'children',
        waitName: entry.erased.job.key,
        wakeAt: null,
      });
  }
  return { kind: 'rests', status: (await store.getRun(run.id)).status };
}

interface OperatorDeps {
  store: JobStore;
  registry: Registry;
  clock: Clock;
  events: EventSink;
  executor?: Pick<Executor, 'submit'>;
}

/** The children step a request names, or `JobDefinitionError`. */
function childrenStepOf(
  job: AnyJob,
  step: string,
): StepEntry & { erased: ErasedChildrenStep } {
  const entry = job.steps.find((s) => s.name === step);
  if (entry?.erased.kind !== 'children')
    throw new JobDefinitionError(`${job.key} has no children step ${step}`);
  return entry as StepEntry & { erased: ErasedChildrenStep };
}

/**
 * An operator's retry of a failed child: a new child run in the slot (the same key and input), with the failed
 * attempt's budget unless another is given, submitted. Null when the slot isn't failed.
 */
export async function retryChild(
  deps: OperatorDeps,
  request: { runId: string; step: string; key: string; budget?: Budget },
): Promise<Slot | null> {
  const { store, registry } = deps;
  const run = await store.getRun(request.runId);
  const entry = childrenStepOf(registry.get(run.jobKey), request.step);
  const slot = (await store.items(run.id, request.step)).find(
    (i) => i.key === request.key,
  );
  if (slot?.status !== 'failed') return null;
  const failed = await store.getRun(slot.ref);
  const job = registry.get(entry.erased.job.key);
  const retried = await store.retryChild(run.id, request.step, request.key, {
    key: request.key,
    jobKey: job.key,
    jobVersion: job.version,
    input: await store.runInput(failed.id),
    budget: request.budget ?? failed.budget,
  });
  if (retried) {
    await deps.events.emit({
      ...eventBase(run, deps.clock),
      step: request.step,
      attempt: retried.attempts,
      type: 'child.started',
      childKey: retried.key,
      childRunId: retried.childRunId,
    });
    await submitSoon(deps.executor, retried.childRunId);
  }
  return retried;
}

/**
 * An operator's skip of a failed child: the slot is skipped and the parent's waiting step is due, so it re-reads its
 * slots. A `child` step has no skip (with no output there is nothing to go on with). Null when the slot isn't failed.
 */
export async function skipChild(
  deps: OperatorDeps,
  request: { runId: string; step: string; key: string },
): Promise<Slot | null> {
  const { store, registry } = deps;
  const run = await store.getRun(request.runId);
  const entry = childrenStepOf(registry.get(run.jobKey), request.step);
  if (entry.erased.single)
    throw new JobDefinitionError(
      `${run.jobKey}/${request.step} has one child: retry it, or cancel the run`,
    );
  const skipped = await store.skipChild(run.id, request.step, request.key);
  if (skipped) await submitSoon(deps.executor, run.id);
  return skipped;
}
