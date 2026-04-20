/**
 * Typed errors for the job orchestration domain (ADR-022, JOB-3).
 *
 * All thrown by the Drizzle orchestrator (and mirrored by the Memory
 * backend in JOB-4). They exist as classes so consumers can `instanceof`
 * them in catch blocks and exception filters can map them to HTTP codes.
 */
import type { JobRun } from './job-orchestrator.protocol';

/**
 * `start(type, …)` was called for a job type that has no row in the `job`
 * table. At runtime this usually means the handler was not decorated or the
 * boot validator (JOB-5) has not registered it yet.
 */
export class JobTypeNotFoundError extends Error {
  readonly name = 'JobTypeNotFoundError';
  constructor(public readonly jobType: string) {
    super(`No job definition registered for type '${jobType}'.`);
  }
}

/**
 * Thrown by `start` when `collision_mode === 'reject'` and a non-terminal
 * run with the same `concurrency_key` already exists. Carries the incumbent
 * so callers can surface its id or subscribe to its completion event.
 */
export class JobCollisionError extends Error {
  readonly name = 'JobCollisionError';
  constructor(
    public readonly jobType: string,
    public readonly concurrencyKey: string,
    public readonly incumbent: JobRun,
  ) {
    super(
      `Job type '${jobType}' has an in-flight run with concurrency_key ` +
        `'${concurrencyKey}' (incumbent ${incumbent.id}); collision_mode=reject.`,
    );
  }
}

/**
 * `replay` was called on a run that is not in a replayable terminal state
 * (i.e. still `pending` / `running` / `waiting`). Replay always spawns
 * fresh execution and therefore requires the source run to be settled.
 */
export class JobNotReplayableError extends Error {
  readonly name = 'JobNotReplayableError';
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string,
  ) {
    super(
      `Run ${runId} is not replayable from status '${currentStatus}'. ` +
        `Only 'completed', 'failed', 'timed_out', and 'canceled' are eligible.`,
    );
  }
}

/**
 * A `concurrency_key_template` or `dedupe_key_template` referenced a field
 * that is not present on the input payload. Caught at `start` time so the
 * caller sees the misconfiguration synchronously rather than at claim time.
 */
export class JobTemplateFieldMissingError extends Error {
  readonly name = 'JobTemplateFieldMissingError';
  constructor(
    public readonly template: string,
    public readonly field: string,
  ) {
    super(
      `Template '${template}' references input field '${field}' which is ` +
        `missing or undefined on the payload.`,
    );
  }
}
