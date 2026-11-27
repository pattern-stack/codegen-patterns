import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  InputRefusedError,
  type JobAuthorityLevel,
  type JobLimits,
  RunPlanningError,
  type RunStatus,
  RunVersionConflictError,
} from '../index.ts';

/**
 * The jobs API's errors. Each payload carries `code` and its extra fields, which `AllExceptionsFilter` renders
 * under `details`. None echoes a run id the caller did not already hold as theirs, and
 * none carries stored or provider text.
 */

/** An unknown job key, or an internal job's: the same answer for both. */
export class JobNotFoundError extends NotFoundException {
  constructor() {
    super({ message: 'No public job has this key', code: 'job_not_found' });
  }
}

/** An unknown run, another tenant's, an internal job's, or one the caller may not read: the same answer. */
export class JobRunNotFoundError extends NotFoundException {
  constructor() {
    super({ message: 'No run with this id was found', code: 'run_not_found' });
  }
}

/**
 * The operator's start (Superuser → Jobs) refused by the engine: its input fails the job's schema, or the run can't
 * be planned. The message names the input's paths and zod issue codes, the superuser's own input, so it is disclosed
 * (`safeToDisclose`, read structurally by the tRPC error boundary) instead of collapsing to "Bad request".
 */
export class JobOperatorInputRefusedError extends BadRequestException {
  readonly safeToDisclose = true;

  constructor(reason: string) {
    super({
      message: `The job refused this input: ${reason}`,
      code: 'input_invalid',
    });
    this.name = 'JobOperatorInputRefusedError';
  }
}

/**
 * A signal's value its wait step's schema refuses: each failing path and zod code, never the value. It is the sender's
 * own input, so the message is disclosed (`safeToDisclose`).
 */
export class JobSignalValueError extends BadRequestException {
  readonly safeToDisclose = true;

  constructor(
    reason: string,
    issues: readonly { path: string; code: string }[],
  ) {
    super({
      message: `${reason} (${issues.map((i) => `${i.path}: ${i.code}`).join('; ')})`,
      code: 'signal_value_invalid',
      issues,
    });
    this.name = 'JobSignalValueError';
  }
}

/** A visible job the caller lacks the level for. */
export class JobAuthorityError extends ForbiddenException {
  constructor(needs: JobAuthorityLevel) {
    super({
      message: `This needs ${needs} authority over the job`,
      code: 'authority',
      needs,
    });
  }
}

/** An input that fails the job's public schema: paths and zod codes only, never values. */
export class JobInputInvalidError extends BadRequestException {
  constructor(issues: { path: string; code: string }[]) {
    super({
      message: "The input does not match the job's input schema",
      code: 'input_invalid',
      issues,
    });
  }
}

/** A budget asking for more than the job's limits. */
export class JobBudgetOverLimitError extends BadRequestException {
  constructor(limits: JobLimits) {
    super({
      message: "Each budget field must be at most the job's limit",
      code: 'budget_over_limit',
      limits,
    });
  }
}

/** A schema-valid input the job's `admit` refuses for this tenant: the job's own code and message. */
export class JobInputRefusedError extends UnprocessableEntityException {
  constructor(code: string, message: string) {
    super({ message, code });
  }
}

/** An open run on the dedupe key made by another version of the job. The run is the caller's tenant's own. */
export class JobRunVersionConflictError extends ConflictException {
  constructor(runId: string) {
    super({
      message:
        'An open run with this dedupe key was made by another version of the job; cancel it or let it finish',
      code: 'version_conflict',
      runId,
    });
  }
}

/** A cancel of a run that already completed or failed. */
export class JobRunEndedError extends ConflictException {
  constructor(status: RunStatus) {
    super({ message: `The run already ${status}`, code: 'run_ended', status });
  }
}

/** Too many waits held open for one tenant in this process. */
export class TooManyRunWaitsError extends HttpException {
  static readonly RETRY_AFTER_SECONDS = 5;
  constructor() {
    super(
      {
        message: 'Too many waits are open for this tenant; retry shortly',
        code: 'too_many_waits',
        // AllExceptionsFilter sends it as Retry-After too.
        retryAfterSeconds: TooManyRunWaitsError.RETRY_AFTER_SECONDS,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * A cursor passed back with other filters than the read that returned it. The same wire as the app's filter-bound
 * cursors' `StaleCursorError` (409, `stale_cursor`, the same message): the package keeps its own so it imports nothing
 * from the app (P6).
 */
export class JobCursorStaleError extends ConflictException {
  static readonly CODE = 'stale_cursor';
  static readonly MESSAGE =
    "This cursor belongs to another read (the read's filters changed, or what they resolve to did); start again from the first page";

  constructor() {
    super({
      message: JobCursorStaleError.MESSAGE,
      code: JobCursorStaleError.CODE,
    });
  }
}

/** An id a job's input names (`jobRef`) that does not resolve in the run's tenant: the field's path, never the id. */
export class JobRefNotFoundError extends BadRequestException {
  constructor(path: string, kind: string) {
    super({
      message: `The input's ${path} names no ${kind} of this tenant`,
      code: 'ref_not_found',
      path,
    });
  }
}

/**
 * A start's engine refusal as each view answers it. The two views keep their wire (`version_conflict` on REST,
 * `run_version_conflict` on `jobsOps`; an admit refusal 422 on REST, 400 on `jobsOps`): aligning them is a wire change
 * for a later PR, and this is the one place both live. Anything else is returned unchanged, to be thrown as it is.
 */
export function startRefusalOf(
  err: unknown,
  view: 'public' | 'operator',
): unknown {
  if (view === 'public') {
    if (err instanceof InputRefusedError)
      return new JobInputRefusedError(err.code, err.message);
    if (err instanceof RunVersionConflictError)
      return new JobRunVersionConflictError(err.runId);
    if (err instanceof RunPlanningError) return new JobInputInvalidError([]);
    return err;
  }
  if (err instanceof InputRefusedError)
    return new BadRequestException({ message: err.message, code: err.code });
  // The engine's reason names the input's paths and zod issue codes (it carries no cause). It is the superuser's own
  // input, so it is echoed.
  if (err instanceof RunPlanningError)
    return new JobOperatorInputRefusedError(err.message);
  if (err instanceof RunVersionConflictError)
    return new ConflictException({
      message:
        'An open run made by another version of this job holds the dedupe key',
      code: 'run_version_conflict',
    });
  return err;
}
