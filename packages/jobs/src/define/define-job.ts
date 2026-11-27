import type { z } from 'zod';
import { JobDefinitionError } from '../model/errors.ts';
import type { CacheMode, Collision, RunSubject } from '../model/run.ts';
import type { StepRecorder } from '../ports/step-recorder.ts';
import {
  type AdmitRequest,
  authorityAtLeast,
  type JobAudience,
  type JobAuthority,
  type JobLimits,
} from './facts.ts';
import { checkCacheScopes } from './map-step.ts';
import {
  type ErasedStep,
  type NoneFor,
  RESERVED_STEP_NAMES,
  type ReservedStepName,
  type StepContext,
  type StepDef,
} from './step.ts';
import { definitionVersion, whereRecorded } from './version.ts';

/** The outputs before the first step: none. */
export type NoOutputs = Record<never, never>;

/** One step of a job, in order, as the engine holds it. */
export interface StepEntry {
  name: string;
  index: number;
  erased: ErasedStep;
}

/**
 * The steps of a job, added in order. Each `add` widens the context the next step reads: a step sees the input and
 * every earlier step's output by name, typed, and never a later one.
 */
export interface StepChain<I, O, Last> {
  add<K extends string, Out>(
    name: K &
      (K extends keyof O | ReservedStepName ? never : K),
    def: StepDef<StepContext<I, O>, Out>,
  ): StepChain<I, O & { [P in K]: Out }, Out>;
  readonly entries: readonly StepEntry[];
  /** Carries the types only. */
  readonly __types?: { outputs: O; last: Last };
}

function chain<I, O, Last>(
  entries: readonly StepEntry[],
): StepChain<I, O, Last> {
  return {
    entries,
    add(name, def) {
      if ((RESERVED_STEP_NAMES as readonly string[]).includes(name))
        throw new JobDefinitionError(`a step may not be named ${name}`);
      if (entries.some((e) => e.name === name))
        throw new JobDefinitionError(`two steps are named ${name}`);
      return chain([
        ...entries,
        { name, index: entries.length, erased: def.erased },
      ]);
    },
  };
}

export interface JobOptions<I, O, Outs> {
  /** Its stable name: 'document.reindex'. */
  key: string;
  /**
   * The job's behaviour version, a positive integer (default 1). Bump it when a change to a step's code means an open
   * run must not resume under the new code: a run made by another version is never resumed. The definition's hash
   * (`JobDefinition.version`) covers its structure and facts on its own, never its code text.
   */
  version?: number;
  input: z.ZodType<I>;
  /** The last step's output, validated when the run completes. */
  output: z.ZodType<O>;
  /** The steps, in order: `(s) => s.add('band', step(…)).add('judge', mapStep(…))…`. The last one's output is the job's. */
  steps: (s: StepChain<I, NoOutputs, never>) => StepChain<I, Outs, O>;
  /**
   * Where a run's input lives (the job kind's own table). Without one, the store keeps it, which only a store that
   * keeps values does; `'none'` for a void input.
   */
  inputRecorder?: StepRecorder<I> | NoneFor<I>;
  /** Who reaches it: 'internal' (the default) is reached by no caller-facing surface; 'public' is listed by the API. */
  audience?: JobAudience;
  /** The level each use needs (defaults: read 'member', start 'admin', dryRun = start). The app's service applies it. */
  authority?: Partial<JobAuthority>;
  /** The most one run may use. Required for a public job. */
  limits?: JobLimits;
  /**
   * A check of a parsed input against the tenant (it exists there, it is live), run by `startRun` before any
   * run is created. Throws `InputRefusedError`.
   */
  admit?: (input: I, request: AdmitRequest) => Promise<void>;
  /**
   * What a run is about, from its parsed input: `(input) => ({ kind: 'document', id: input.documentId })`.
   * Computed by `startRun` and stored on the run, so a page can list "this subject's runs"; never taken from a caller.
   * A free-text kind (≤ 64) and id (≤ 255), both non-empty; null for a run about nothing in particular.
   */
  subject?: (input: I) => RunSubject | null;
  /**
   * The cache mode a run takes from its input when the request names none (Extraction's `mode: 'force'` is a
   * refresh): the request's `cache`, then this, then `read-write`. A function of the input only, so a run's mode is
   * decided once, at start, and stored on the run (`Run.cache`).
   */
  cacheFor?: (input: I) => CacheMode;
  /**
   * What a start does when its dedupe key already has an open run, when the request names nothing (`join`, `queue`
   * or `replace`; `RunRequest.collision`). Default `join`.
   */
  collision?: Collision;
  /** Duplicate starts within a window after a run on the key ended (`RunRequest.dedupeWindowMs`). Default 0. */
  dedupeWindowMs?: number;
}

/** The facts as every job holds them, resolved. */
interface JobFacts {
  readonly audience: JobAudience;
  readonly authority: JobAuthority;
  readonly limits: JobLimits | undefined;
  readonly admit:
    | ((input: unknown, request: AdmitRequest) => Promise<void>)
    | undefined;
  readonly subject: ((input: unknown) => RunSubject | null) | undefined;
  readonly cacheFor: ((input: unknown) => CacheMode) | undefined;
  readonly collision: Collision;
  readonly dedupeWindowMs: number;
}

/** A job: code, registered once per process, never data. */
export interface JobDefinition<I = unknown, O = unknown, Outs = unknown>
  extends JobFacts {
  readonly key: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly steps: readonly StepEntry[];
  /** `definitionVersion` of this definition (its structure, facts and behaviour version), stored on each run. */
  readonly version: string;
  readonly inputRecorder: StepRecorder<unknown> | 'none' | undefined;
  /** Carries the step outputs' types only. */
  readonly __outputs?: Outs;
}

/** Any job, as a registry or an executor holds it: what the engine needs, no types. */
export interface AnyJob extends JobFacts {
  readonly key: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly steps: readonly StepEntry[];
  readonly version: string;
  /** Where a run's input lives: a recorder, nowhere ('none'), or the store (undefined). */
  readonly inputRecorder: StepRecorder<unknown> | 'none' | undefined;
}

/**
 * Declares a job: its key, its typed input and output, and its steps in order. A definition object, not a
 * decorator: each step reads the earlier outputs by name, typed, and the whole thing is a plain value.
 */
export function defineJob<I, O, Outs>(
  options: JobOptions<I, O, Outs>,
): JobDefinition<I, O, Outs> {
  if (!options.key) throw new JobDefinitionError('a job needs a key');
  const behaviour = options.version ?? 1;
  if (!(Number.isInteger(behaviour) && behaviour >= 1))
    throw new JobDefinitionError(
      `${options.key}: version must be a positive integer`,
    );
  const steps = options.steps(chain<I, NoOutputs, never>([])).entries;
  const { inputRecorder } = options;
  if (!steps.length)
    throw new JobDefinitionError(`${options.key}: a job needs a step`);
  const facts = factsOf(options, steps);
  checkCacheScopes(options.key, steps);
  return {
    ...facts,
    key: options.key,
    input: options.input,
    output: options.output,
    steps,
    version: definitionVersion({
      key: options.key,
      input: options.input,
      output: options.output,
      steps,
      behaviour,
      inputRecorded: whereRecorded(inputRecorder),
    }),
    inputRecorder:
      inputRecorder === undefined || inputRecorder === 'none'
        ? inputRecorder
        : {
            save: (runId, input) => inputRecorder.save(runId, input as I),
            load: (runId) => inputRecorder.load(runId),
          },
  };
}

const LIMIT_NAMES = [
  'maxItems',
  'maxUsd',
  'maxCalls',
  'maxDurationMs',
] as const;
/** The limits that count something: whole numbers, as the store and the wire hold them. */
const INTEGER_LIMITS: ReadonlySet<string> = new Set([
  'maxItems',
  'maxCalls',
  'maxDurationMs',
]);

const dedupeWindowOf = (key: string, ms: number | undefined): number => {
  if (ms === undefined) return 0;
  if (!Number.isInteger(ms) || ms < 0)
    throw new JobDefinitionError(`${key}: dedupeWindowMs must be a whole number of milliseconds, 0 or more`);
  return ms;
};

/** The facts, resolved and checked: a definition error at definition time, never at a caller's start. */
function factsOf<I, O, Outs>(
  options: JobOptions<I, O, Outs>,
  steps: readonly StepEntry[],
): JobFacts {
  const { key, limits, admit, subject, cacheFor } = options;
  const audience = options.audience ?? 'internal';
  const start = options.authority?.start ?? 'admin';
  const authority: JobAuthority = {
    read: options.authority?.read ?? 'member',
    dryRun: options.authority?.dryRun ?? start,
    start,
  };
  if (audience === 'public' && !limits)
    throw new JobDefinitionError(`${key}: a public job declares its limits`);
  if (limits)
    for (const name of LIMIT_NAMES) {
      const value = limits[name];
      if (!Number.isFinite(value) || value <= 0)
        throw new JobDefinitionError(
          `${key}: limits.${name} must be a positive finite number`,
        );
      if (INTEGER_LIMITS.has(name) && !Number.isInteger(value))
        throw new JobDefinitionError(
          `${key}: limits.${name} must be a whole number`,
        );
    }
  if (!authorityAtLeast(authority.dryRun, authority.read))
    throw new JobDefinitionError(
      `${key}: authority.read is above authority.dryRun; whoever may start a run may read it`,
    );
  if (!authorityAtLeast(authority.start, authority.dryRun))
    throw new JobDefinitionError(
      `${key}: authority.dryRun is above authority.start`,
    );
  const sideEffect = steps.find((s) => s.erased.effect === 'side-effect');
  // Only a real run publishes: its dry run may sit at its declared level, and its side-effecting steps write nothing
  // under `ctx.dryRun` (a review rule the engine can't see).
  if (sideEffect && !authorityAtLeast(authority.start, 'admin'))
    throw new JobDefinitionError(
      `${key}: step ${sideEffect.name} has a side effect, so starting a real run needs 'admin'`,
    );
  return {
    audience,
    authority,
    limits: limits ? { ...limits } : undefined,
    admit: admit ? (input, request) => admit(input as I, request) : undefined,
    subject: subject ? (input) => subject(input as I) : undefined,
    cacheFor: cacheFor ? (input) => cacheFor(input as I) : undefined,
    collision: options.collision ?? 'join',
    dedupeWindowMs: dedupeWindowOf(key, options.dedupeWindowMs),
  };
}
