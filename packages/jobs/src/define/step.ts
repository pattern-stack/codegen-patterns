import type { z } from 'zod';
import type { ItemRef, Keyed } from '../model/item.ts';
import type { StepKind } from '../model/step-state.ts';
import type { Spend } from '../model/run.ts';
import type { RetryPolicy } from '../policy/retry.ts';
import type { StopPredicate } from '../policy/stop.ts';
import type { ResultRecorder } from '../ports/result-recorder.ts';
import type { StepRecorder } from '../ports/step-recorder.ts';
import type { ChildBudget, ChildFailure } from './children.ts';
import type { AnyJob } from './define-job.ts';
import type { JobAuthorityLevel, OutputOf } from './facts.ts';
import { type ErasedGate, erasedGates, type Gate } from './gate.ts';
import type { ItemPresenter, StepPresenter } from './item-view.ts';
import {
  type LimiterRefs,
  type StepLimiter,
  stepLimitersOf,
} from './limits.ts';
import { signalWait } from './signal-wait.ts';

/**
 * idempotent: running it again is safe (judging). side-effect: it changes the world (publishing), so it needs a durable
 * store. Neither is exactly once: a step whose worker dies after its effect and before its record runs again, so a
 * side-effect step makes its effect idempotent itself, keyed by `ctx.runId` and the step (an upsert, a provider's
 * idempotency key, or a check of what it already wrote).
 */
export type Effect = 'idempotent' | 'side-effect';

/** What every step reads: the run's input and ids, and each earlier step's output by its name. */
export type StepContext<I, O> = {
  readonly input: I;
  readonly tenantId: string;
  readonly runId: string;
  /** The run may read and decide but publishes nothing. */
  readonly dryRun: boolean;
  readonly signal: AbortSignal;
  /** Another run's output, typed by its job (`OutputOf`): only a completed run of the reader's tenant. */
  readonly outputOf: OutputOf;
} & Readonly<O>;

/** Names a step may not take: the context's own fields. */
export const RESERVED_STEP_NAMES: readonly string[] = [
  'input',
  'tenantId',
  'runId',
  'dryRun',
  'signal',
  'outputOf',
];

/**
 * The explicit opt-out from recording a value: only a void value may take it. A value is never dropped silently; one
 * that is not void lives in its recorder, or in the store when the store keeps values.
 */
export type NoneFor<T> = [T] extends [undefined]
  ? 'none'
  : [T] extends [VoidResult]
    ? 'none'
    : never;

/** What a function with no return value returns. */
type VoidResult = ReturnType<() => void>;

/** The context as the engine builds it, before a step's types are applied. */
export type ErasedContext = StepContext<unknown, Record<string, unknown>>;

/** Pages of item refs from `cursor` (null = the start), at most `limit` each; the store keeps the cursor. */
export interface ItemSource {
  page(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ refs: ItemRef[]; next: string | null }>;
}

export interface BatchResult<R> {
  /** One per item of the batch, in its order. An item named in `failed` has its entry ignored (any value). */
  results: readonly R[];
  /** Default one call, nothing else. Recorded whatever happens to the items, `failed` ones included. */
  spend?: Partial<Spend>;
  /**
   * Items this call failed for good without throwing, by their index in the batch, each with a bounded error type
   * (an identifier, never content). They fail alone, as a `NonRetryableError` split down to them would, but the
   * call's spend and the other items' results are kept. Each index once, within the batch.
   */
  failed?: readonly { index: number; errorType: string }[];
}

/** A map step's output: its results in planned order, up to its early stop, and the items that failed for good. */
export interface MapStepOutput<R> {
  results: { key: string; ref: ItemRef; result: R }[];
  failed: { key: string; ref: ItemRef; errorType: string }[];
}

/** A plain step as the engine holds it, its types closed over. */
export interface ErasedPlainStep {
  kind: 'step';
  run(ctx: ErasedContext): Promise<unknown>;
  /** Read before the step runs: a closed one parks it. */
  gates: ErasedGate[];
  /** Where its output lives: a recorder, nowhere ('none', a void output), or the store (undefined). */
  recorder: StepRecorder<unknown> | 'none' | undefined;
  /** Held for the step's whole run, taken in this order (sorted by name); empty for none. */
  limiters: StepLimiter[];
  retry: RetryPolicy | undefined;
  effect: Effect;
  /** How the step reads on a run page; presentation only, never in the version. */
  present: StepPresenter<unknown> | undefined;
}

/** A map step as the engine holds it, its types closed over. */
export interface ErasedMapStep {
  kind: 'map';
  /** Read before the step starts and at the start of each chunk: a closed one parks it. */
  gates: ErasedGate[];
  source(ctx: ErasedContext): Promise<ItemSource>;
  key(ref: ItemRef, ctx: ErasedContext): string;
  hydrate(refs: readonly ItemRef[], ctx: ErasedContext): Promise<unknown[]>;
  run(
    batch: readonly Keyed<unknown>[],
    ctx: ErasedContext,
  ): Promise<BatchResult<unknown>>;
  /** Validates one result before it is stored. */
  parse(result: unknown): unknown;
  /** The result schema `parse` applies, for the version hash. */
  resultSchema: z.ZodType | undefined;
  /** Where its results live: a recorder, nowhere ('none', void results), or the store (undefined). */
  results: ResultRecorder<unknown> | 'none' | undefined;
  /** The store's cache this step shares with others (`cacheScope`); undefined: its own, `<jobKey>/<step>`. */
  cacheScope: string | undefined;
  stopWhen: StopPredicate<unknown> | undefined;
  cost(batch: readonly Keyed<unknown>[]): { tokens: number; usd: number };
  batchMax: number;
  /** Every call takes each of these, in this order (sorted by name); at least one. */
  limiters: StepLimiter[];
  retry: RetryPolicy | undefined;
  effect: Effect;
  /** How each item reads on a run page; presentation only, never in the version. */
  present: ItemPresenter<unknown> | undefined;
}

/**
 * A step that waits for a signal (a person's approval): it has no work of its own, parks its run until `signalRun`
 * delivers a value its schema and `accept` take, and outputs that value. Never gated or limited.
 */
export interface ErasedWaitStep {
  kind: 'wait';
  /** The signal's name: a code constant. */
  signal: string;
  description: string | undefined;
  value: z.ZodType;
  accept: ((value: unknown, ctx: ErasedContext) => Promise<void>) | undefined;
  /** Who may send it; undefined: the level that started the run (`authority.start`, or `dryRun` for a dry run). */
  authority: JobAuthorityLevel | undefined;
  timeout:
    | { afterMs: number; fallback: 'fail' | { value: unknown } }
    | undefined;
  gates: [];
  limiters: [];
  retry: undefined;
  effect: 'idempotent';
}

/** A step that starts child runs, one per key, and waits for them; its output is read back from its slots. */
export interface ErasedChildrenStep {
  kind: 'children';
  job: AnyJob;
  each(
    ctx: ErasedContext,
  ): Promise<{ key: string; input: unknown; budget?: ChildBudget }[]>;
  onFailure: ChildFailure;
  /** `child`: one slot, whose child's output is the step's. */
  single: boolean;
  gates: [];
  limiters: [];
  retry: undefined;
  effect: 'idempotent';
}

export type ErasedStep =
  | ErasedPlainStep
  | ErasedMapStep
  | ErasedWaitStep
  | ErasedChildrenStep;

/**
 * What `step()` and `mapStep()` give: a step reading context `C` and producing `Out`. `__types` only carries the
 * types; `erased` is what the engine runs.
 */
export interface StepDef<C, Out> {
  readonly kind: StepKind;
  readonly erased: ErasedStep;
  readonly __types?: (ctx: C) => Out;
}

export interface StepDefinition<C, Out> extends StepDef<C, Out> {
  readonly kind: 'step';
}

export interface StepOptions<C, Out> {
  /** From the input and the earlier steps' outputs to this step's output: small, or a reference. */
  run: (ctx: C) => Out | Promise<Out>;
  /**
   * Where the output lives (the job kind's own tables). Without one, the store records it, which only a store that
   * keeps values does; `'none'` for a void output.
   */
  recorder?: StepRecorder<Awaited<Out>> | NoneFor<Awaited<Out>>;
  /** Default `DEFAULT_RETRY`. */
  retry?: RetryPolicy;
  effect?: Effect;
  /**
   * Conditions outside the run the step needs: read before it runs, and while it waits, on each poll. A closed one
   * parks the step (`waiting`) until it opens; never a failure or a skip.
   */
  gates?: readonly Gate<C>[];
  /**
   * Quotas the step holds a slot on for its whole run: `'bands'`, `{ name: 'bands', per: 'tenant' }`, or a
   * list. Without one, it takes none.
   */
  limiter?: LimiterRefs;
  /**
   * How the step reads on a run page (`StepView`): pure and synchronous, run when the page reads the run, never stored
   * and never in the definition version. Without one, the step shows no summary and its stored output still.
   */
  present?: StepPresenter<NoInfer<Awaited<Out>>>;
}

/** A plain step: runs once, and its output is recorded before the next step starts. */
export function step<C, Out>(
  def: StepOptions<C, Out>,
): StepDefinition<C, Awaited<Out>> {
  const { recorder, present } = def;
  const erased: ErasedPlainStep = {
    kind: 'step',
    run: async (ctx) => def.run(ctx as C),
    recorder:
      recorder === undefined || recorder === 'none'
        ? recorder
        : {
            save: (runId, output) =>
              recorder.save(runId, output as Awaited<Out>),
            load: (runId) => recorder.load(runId),
          },
    limiters: stepLimitersOf(def.limiter),
    retry: def.retry,
    effect: def.effect ?? 'idempotent',
    gates: erasedGates(def.gates),
    present:
      present &&
      ((s) => present({ ...s, output: s.output as Awaited<Out> | null })),
  };
  return { kind: 'step', erased };
}

export interface WaitStepDefinition<C, V> extends StepDef<C, V> {
  readonly kind: 'wait';
}

/** A wait for a signal: its name, the value it carries and who may send it. */
export interface SignalWaitOptions<C, V> {
  /** A code constant (`approve`): it reaches the step's row, events and logs. */
  signal: string;
  /** The value the signal carries, which becomes the step's output: plain JSON, ids only in v1. */
  value: z.ZodType<V>;
  /** What the person is asked to do, shown beside the Approve form. */
  description?: string;
  /** Checks the value against the context and throws `InputRefusedError`, the way `admit` does for a start. */
  accept?: (value: NoInfer<V>, ctx: C) => void | Promise<void>;
  /** Who may send it. Default: the level that started the run (`authority.start`, or `dryRun` for a dry run). */
  authority?: JobAuthorityLevel;
  /** None by default. Past `afterMs` the step fails (`fallback: 'fail'`) or settles with `fallback.value`. */
  timeout?: { afterMs: number; fallback: 'fail' | { value: NoInfer<V> } };
}

/**
 * The step that only waits. On a gate (`waitFor({ gate })`): no work, a void output, done once the gate is open;
 * publish's wait for its version's backfill is `waitFor({ gate: backfillDone(backfills) })`. On a signal
 * (`waitFor({ signal, value })`): the run waits until the signal is sent, and the step's output is its value.
 */
export function waitFor<C>(options: {
  gate: Gate<C>;
}): StepDefinition<C, undefined>;
export function waitFor<C, V>(
  options: SignalWaitOptions<C, V>,
): WaitStepDefinition<C, V>;
export function waitFor<C, V>(
  options: { gate: Gate<C> } | SignalWaitOptions<C, V>,
): StepDefinition<C, undefined> | WaitStepDefinition<C, V> {
  if ('gate' in options)
    return step<C, undefined>({
      run: () => undefined,
      recorder: 'none',
      gates: [options.gate],
    });
  return signalWait(options);
}
