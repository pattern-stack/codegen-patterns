import type { JobDefinition } from './define-job.ts';
/**
 * What a job declares about who may reach it, beside how it runs: its audience, the authority each kind of use
 * needs, the most one run may use, and its own admission check. None of it is part of `definitionVersion`: who may
 * start a job doesn't change how a run runs, so a change to them strands no open run.
 */

/** Who may do something with a job's runs, lowest first; each level holds the ones below it. */
export const JOB_AUTHORITY_LEVELS = ['member', 'tenant-wide', 'admin'] as const;
export type JobAuthorityLevel = (typeof JOB_AUTHORITY_LEVELS)[number];

/** Whether `held` covers `needed`. */
export const authorityAtLeast = (
  held: JobAuthorityLevel,
  needed: JobAuthorityLevel,
): boolean =>
  JOB_AUTHORITY_LEVELS.indexOf(held) >= JOB_AUTHORITY_LEVELS.indexOf(needed);

/** `internal`: no caller-facing surface reaches it (the default). `public`: the API lists and starts it. */
export const JOB_AUDIENCES = ['internal', 'public'] as const;
export type JobAudience = (typeof JOB_AUDIENCES)[number];

export interface JobAuthority {
  /** Read its runs. Default 'member'. */
  read: JobAuthorityLevel;
  /** Start (and cancel) a dry run. Default: `start`. */
  dryRun: JobAuthorityLevel;
  /** Start (and cancel) a run that may publish. Default 'admin'. */
  start: JobAuthorityLevel;
}

/** The most one run may use; a caller may ask for less, never more. Required for a public job. */
export interface JobLimits {
  maxItems: number;
  maxUsd: number;
  maxCalls: number;
  /** Becomes the run's `Budget.deadline`: the start's clock time plus this. */
  maxDurationMs: number;
}

/**
 * Reads another run's output, typed by its job: a completed run of `job` in the reader's own tenant. Refuses
 * with `InputRefusedError`, checked in this order: `run_not_found` (no such run, or another tenant's: never
 * told apart), `run_wrong_job`, `run_not_completed`, `run_output_unreadable` (its output no longer parses).
 */
export type OutputOf = <I, O, Outs>(
  job: JobDefinition<I, O, Outs>,
  runId: string,
) => Promise<O>;

/** What `admit` reads beside the input. */
export interface AdmitRequest {
  tenantId: string;
  dryRun: boolean;
  /** The same reader a step has (`ctx.outputOf`), so a start can refuse a bad reference before any run exists. */
  outputOf: OutputOf;
}
