import type { ChunkClaim } from './chunk.ts';

/**
 * A failure that must never be retried: the same input will always cause it. In a map step's batch it isolates the
 * item that causes it (the batch splits in halves until that item is alone, and it alone fails); anywhere else it
 * fails the step or the chunk at once. Temporal's `ApplicationFailure.nonRetryable` is the same idea.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

/** A mistake in a job's definition or a request against it (a hydrate that returns the wrong count). Never retried. */
export class JobDefinitionError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'JobDefinitionError';
  }
}

/**
 * An open run's definition version is gone: no process it reached still has it, past the drain window a version bump
 * gives (`versionGraceMs`). Its next advance fails it with this, rather than leaving it open forever. Never retried.
 */
export class JobVersionGoneError extends NonRetryableError {
  constructor(
    readonly runId: string,
    readonly runVersion: string,
    readonly version: string,
  ) {
    super(
      `run ${runId} was made by version ${runVersion}, which is no longer deployed (now ${version}); start it again`,
    );
    this.name = 'JobVersionGoneError';
  }
}

/** A run id no run has. Thrown by every store's single-run reads (`getRun`, `progress`). */
export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`no run ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

/** A dedupe hit on an open run made by another definition version: a run is read against the definition it ran. */
export class RunVersionConflictError extends JobDefinitionError {
  constructor(
    readonly runId: string,
    readonly runVersion: string,
    readonly version: string,
  ) {
    super(
      `open run ${runId} was made by version ${runVersion}, not ${version}; cancel it or let it finish`,
    );
    this.name = 'RunVersionConflictError';
  }
}

/**
 * An input the job refuses for this tenant (its `admit`). `code` is a bounded identifier the API answers with;
 * the message is the job's own and names nothing outside it.
 */
export class InputRefusedError extends NonRetryableError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InputRefusedError';
  }
}

/** A run that cannot be planned: an input the job refuses, or a step that throws outside its items. The run fails. */
export class RunPlanningError extends NonRetryableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunPlanningError';
  }
}

/** A chunk write from a worker that no longer holds the chunk's claim: it was swept, or its run or step stopped. */
export class ClaimLostError extends Error {
  constructor(claim: ChunkClaim) {
    super(
      `claim on ${claim.runId}/${claim.step}#${claim.index} lost by ${claim.owner}`,
    );
    this.name = 'ClaimLostError';
  }
}

/**
 * A provider said slow down (a 429). Never a failed attempt: the step's limiter halves its calls in flight and waits
 * out `retryAfterMs` for every caller, and the same call is asked again (`throttleOf`).
 */
export class ThrottledError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, options?: { retryAfterMs?: number }) {
    super(message);
    this.name = 'ThrottledError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** How long to wait out a 429 whose Retry-After nobody gave. */
export const DEFAULT_THROTTLE_MS = 1_000;

/**
 * Whether an error is a throttle, and its Retry-After: a `ThrottledError`, or a provider's own error carrying HTTP
 * status 429 (`status` or `statusCode`, with `retryAfterMs` when it has one). Null for anything else.
 */
export function throttleOf(err: unknown): { retryAfterMs?: number } | null {
  if (err instanceof ThrottledError)
    return err.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: err.retryAfterMs };
  if (typeof err !== 'object' || err === null) return null;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    retryAfterMs?: unknown;
  };
  if (e.status !== 429 && e.statusCode !== 429) return null;
  return typeof e.retryAfterMs === 'number' && e.retryAfterMs >= 0
    ? { retryAfterMs: e.retryAfterMs }
    : {};
}

/**
 * A batch (or a step) found its gate closed partway: its items stay pending (not failed, no attempt spent), the spend
 * it carries (`withSpend`) is recorded, the chunk yields, and the step parks on the gate until it opens. Never a
 * failure or a skip. `gate` is the gate's name, a code constant.
 */
export class GateClosedError extends Error {
  readonly gate: string;
  constructor(gate: string) {
    super(`the gate ${gate} is closed`);
    this.name = 'GateClosedError';
    this.gate = gate;
  }
}

/** A step waited on a closed gate past its `maxWaitMs`: the step fails. */
export class GateTimedOutError extends NonRetryableError {
  constructor(gate: string, waitedMs: number) {
    super(`the gate ${gate} stayed closed for ${waitedMs} ms`);
    this.name = 'GateTimedOutError';
  }
}

/** A step waited for a signal past its timeout, whose `then` is `'fail'`: the step fails. */
export class WaitTimedOutError extends NonRetryableError {
  constructor(signal: string, waitedMs: number) {
    super(`no ${signal} signal came within ${waitedMs} ms`);
    this.name = 'WaitTimedOutError';
  }
}

/** Why a signal was refused: the step isn't waiting for it (or another settled it first), or its value is invalid. */
export type SignalRefusal = 'wait_not_open' | 'signal_value_invalid';

/**
 * A signal the engine refused. `issues` (for `signal_value_invalid`) carries each failing path and its zod code, never
 * the value.
 */
export class SignalRefusedError extends NonRetryableError {
  constructor(
    readonly code: SignalRefusal,
    message: string,
    readonly issues: readonly { path: string; code: string }[] = [],
  ) {
    super(message);
    this.name = 'SignalRefusedError';
  }
}

/** An error's type for a record: its name, never its message's detail. */
export const errorTypeOf = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err;
