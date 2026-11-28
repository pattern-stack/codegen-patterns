import type { z } from 'zod';
import { JobDefinitionError } from '../model/errors.ts';
import { MAX_DEPTH } from '../model/run.ts';
import type { ChildFailure } from './children.ts';
import type { AnyJob } from './define-job.ts';
import {
  authorityAtLeast,
  type JobAudience,
  type JobAuthority,
  type JobAuthorityLevel,
  type JobLimits,
} from './facts.ts';
import type { StepLimiter } from './limits.ts';
import { checkCacheScopes } from './map-step.ts';
import type { ErasedStep } from './step.ts';
import { schemaOf, waitTimeoutOf } from './version.ts';

/** A wait step's signal as a form asks for it: its name, its ask, who may send it, and its value's JSON Schema. */
export interface SignalDescription {
  name: string;
  description: string | null;
  /** Its own level; null: the level that started the run. */
  authority: JobAuthorityLevel | null;
  /** The value's zod schema: a surface builds its form from it. */
  value: z.ZodType;
  timeout: { afterMs: number; fallback: 'fail' | 'value' } | null;
}

/** A job as `GET /jobs` lists it: its steps and shapes, no code. */
export interface JobDescription {
  key: string;
  version: string;
  steps: (
    | { name: string; kind: 'step'; limiters: StepLimiter[] }
    | { name: string; kind: 'map'; batchMax: number; limiters: StepLimiter[] }
    | {
        name: string;
        kind: 'wait';
        limiters: StepLimiter[];
        signal: SignalDescription;
      }
    | {
        name: string;
        kind: 'children';
        limiters: StepLimiter[];
        child: { jobKey: string; onFailure: ChildFailure; single: boolean };
      }
  )[];
  input: unknown;
  output: unknown;
  audience: JobAudience;
  authority: JobAuthority;
  limits: JobLimits | undefined;
}

export interface Registry {
  /** Throws `JobDefinitionError` for a key no job has. */
  get(key: string): AnyJob;
  has(key: string): boolean;
  list(): AnyJob[];
  describe(key: string): JobDescription;
}

/** The jobs a job's children steps start. */
const childJobsOf = (job: AnyJob): AnyJob[] =>
  job.steps.flatMap((s) =>
    s.erased.kind === 'children' ? [s.erased.job] : [],
  );

/**
 * The checks on parents a registry makes at definition time: every child job is registered here; a parent is
 * internal (no REST surface starts children, d16); its read, dry-run and start levels are each at least its
 * children's, so a parent never launders access to a child; and the graph of who starts whom has no cycle and no path
 * longer than `MAX_DEPTH`.
 */
function assertParents(byKey: ReadonlyMap<string, AnyJob>): void {
  for (const job of byKey.values())
    for (const child of childJobsOf(job)) {
      if (!byKey.has(child.key))
        throw new JobDefinitionError(
          `${job.key} starts ${child.key}, which is not registered`,
        );
      if (job.audience !== 'internal')
        throw new JobDefinitionError(
          `${job.key} starts children, so it is internal`,
        );
      for (const level of ['read', 'dryRun', 'start'] as const)
        if (!authorityAtLeast(job.authority[level], child.authority[level]))
          throw new JobDefinitionError(
            `${job.key}'s ${level} level is below ${child.key}'s`,
          );
    }
  const longest = new Map<string, number>();
  const visit = (job: AnyJob, path: readonly string[]): number => {
    if (path.includes(job.key))
      throw new JobDefinitionError(
        `the jobs start each other: ${[...path, job.key].join(' → ')}`,
      );
    const known = longest.get(job.key);
    if (known !== undefined) return known;
    let depth = 0;
    for (const child of childJobsOf(job))
      depth = Math.max(
        depth,
        1 + visit(byKey.get(child.key) ?? child, [...path, job.key]),
      );
    longest.set(job.key, depth);
    return depth;
  };
  for (const job of byKey.values())
    if (visit(job, []) > MAX_DEPTH)
      throw new JobDefinitionError(
        `${job.key} starts runs more than ${MAX_DEPTH} deep`,
      );
}

/** How `describe` shows one step: its kind, its limiters, and a children step's child or a wait step's signal. */
function describeStep(
  name: string,
  erased: ErasedStep,
): JobDescription['steps'][number] {
  switch (erased.kind) {
    case 'children':
      return {
        name,
        kind: 'children',
        limiters: [],
        child: {
          jobKey: erased.job.key,
          onFailure: erased.onFailure,
          single: erased.single,
        },
      };
    case 'wait':
      return {
        name,
        kind: 'wait',
        limiters: [],
        signal: {
          name: erased.signal,
          description: erased.description ?? null,
          authority: erased.authority ?? null,
          value: erased.value,
          timeout: waitTimeoutOf(erased),
        },
      };
    case 'map':
      return {
        name,
        kind: 'map',
        batchMax: erased.batchMax,
        limiters: erased.limiters.map((l) => ({ ...l })),
      };
    case 'step':
      return {
        name,
        kind: 'step',
        limiters: erased.limiters.map((l) => ({ ...l })),
      };
  }
}

/**
 * Every job definition of the process, by key. Two jobs with one key are a definition error, and so are two steps (of
 * any jobs) sharing a `cacheScope` with different result schemas.
 */
export function createRegistry(jobs: readonly AnyJob[]): Registry {
  const byKey = new Map<string, AnyJob>();
  const scopes = new Map<string, { at: string; schema: unknown }>();
  for (const job of jobs) {
    if (byKey.has(job.key))
      throw new JobDefinitionError(`two jobs are keyed ${job.key}`);
    byKey.set(job.key, job);
    checkCacheScopes(job.key, job.steps, scopes);
  }
  assertParents(byKey);
  const get = (key: string): AnyJob => {
    const job = byKey.get(key);
    if (!job) throw new JobDefinitionError(`no job ${key} is registered`);
    return job;
  };
  return {
    get,
    has: (key) => byKey.has(key),
    list: () => [...byKey.values()],
    describe(key) {
      const job = get(key);
      return {
        key: job.key,
        version: job.version,
        steps: job.steps.map(({ name, erased }) => describeStep(name, erased)),
        input: schemaOf(job.input),
        output: schemaOf(job.output),
        audience: job.audience,
        authority: { ...job.authority },
        limits: job.limits ? { ...job.limits } : undefined,
      };
    },
  };
}
