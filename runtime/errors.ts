/**
 * Plain application errors (PW-0). Framework-free: nothing here imports Nest.
 *
 * Generated use cases under `target.wiring: plain` throw these instead of Nest's
 * `NotFoundException` / `BadRequestException`; the HTTP layer, whichever it is,
 * maps them to a response. The Nest target keeps Nest's exceptions, byte for byte.
 *
 * Each error carries its status and renders the body Nest's exception of the same
 * status would send, key for key and in Nest's key order (`{ message, error,
 * statusCode }` for a bare message; `{ statusCode, error, code, ...details,
 * message }` with a code, as the generated code builds it), so a non-Nest HTTP layer that sends `errorBody(err)` answers
 * exactly as the Nest twin does (the REST parity gate, H-1).
 */

/** The HTTP reason phrase for each status an application error can carry, as Nest prints it. */
const REASONS = {
  400: 'Bad Request',
  404: 'Not Found',
} as const;

export type AppErrorStatus = keyof typeof REASONS;

/** The keys `errorBody` owns; a detail can't shadow them. */
const RESERVED_BODY_KEYS = ['statusCode', 'error', 'code', 'message'] as const;

/** Extra fields in the response body, between `code` and `message` (e.g. the `path` of a refused include). */
export type AppErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface AppErrorOptions {
  /** A stable wire code, e.g. `sort_not_combinable`. Omitted from the body when absent. */
  readonly code?: string;
  readonly details?: AppErrorDetails;
  readonly cause?: unknown;
}

/** An error the caller caused, with the status an HTTP layer answers it with. */
export abstract class AppError extends Error {
  abstract readonly status: AppErrorStatus;
  readonly code: string | undefined;
  readonly details: AppErrorDetails | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    for (const key of RESERVED_BODY_KEYS) {
      if (options.details && key in options.details) {
        throw new TypeError(`${new.target.name}: '${key}' is part of every error body and can't be a detail`);
      }
    }
    this.code = options.code;
    this.details = options.details;
  }
}

/** The thing asked for doesn't exist (or isn't visible to the requester). */
export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  readonly status = 404 as const;
}

/** The request is malformed or names something it can't combine. */
export class BadRequestError extends AppError {
  override readonly name = 'BadRequestError';
  readonly status = 400 as const;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** The response body for an application error: the body Nest's exception of the same status sends. */
export interface AppErrorBody {
  readonly statusCode: AppErrorStatus;
  readonly error: string;
  readonly code?: string;
  readonly message: string;
  readonly [detail: string]: string | number | boolean | null | undefined;
}

export function errorBody(err: AppError): AppErrorBody {
  const error = REASONS[err.status];
  // Nest builds a message-only exception's body as `{ message, error, statusCode }`; the generated code passes
  // an object (`{ statusCode, error, code, …, message }`) whenever it has a code, and Nest sends that as given.
  if (err.code === undefined && err.details === undefined) {
    return { message: err.message, error, statusCode: err.status };
  }
  return {
    statusCode: err.status,
    error,
    ...(err.code === undefined ? {} : { code: err.code }),
    ...err.details,
    message: err.message,
  };
}
