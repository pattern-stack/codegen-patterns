/**
 * The generated commands' runtime (H-1, `docs/specs/H-1.md`). Framework-free.
 *
 * A generated command runs one use case. What the use case throws for a caller's mistake becomes a refusal here, by
 * one table, so every way in (HTTP, MCP tools, a CLI) refuses the same things the same way: a missing row, an include
 * the route doesn't allow, a malformed request the use case itself refuses, a write the database refuses on a
 * constraint. A refusal's `data` is the body the Nest target answers it with, byte for byte, from that error's own
 * owner (`errorBody`, `constraintViolationBody`); an HTTP view sends it with the status of its reason. Anything else is
 * a crash, and throws.
 *
 * One exception: a malformed `id` here is `invalid-input` (the input's `z.guid()`), where the Nest route answers
 * `ParseUUIDPipe`'s body. An HTTP view checks `:id` the way `ParseUUIDPipe` does before it binds the input (H-1b), so
 * over HTTP the body is still Nest's.
 *
 * `ctx.idempotencyKey` is not read yet: H-1d stores a `side-effect` command's outcome per key.
 */
import type { Command, CommandContext, Outcome, Refusal } from '@pattern-stack/wiring/commands';
import { constraintViolationBody, constraintViolationOf, type ConstraintViolationCode } from './db-constraint-errors';
import { AppError, BadRequestError, errorBody, NotFoundError, type AppErrorStatus } from './errors';
import { IncludeNotAllowedError } from './http/includes';
import { validationErrorBody, type ValidationIssueInput } from './validation-error';

/** Every reason a generated command refuses with, and what the caller can do instead. */
export const REFUSALS = {
  'invalid-input': 'fix the fields the issues name and try again',
  'bad-request': 'change the request as the message says',
  'include-not-allowed': "ask only for the includes this command's allowlist names (api.includes in the entity YAML)",
  'not-found': 'check the id; list to find the row',
  'unique-violation': 'use a value no other row has, or update the row that has it',
  'foreign-key-violation': 'reference a row that exists',
  'still-referenced': 'delete or re-point the rows that reference it first',
} as const;

export type RefusalReason = keyof typeof REFUSALS;

const CONSTRAINT_REASONS: Readonly<Record<ConstraintViolationCode, RefusalReason>> = {
  unique_violation: 'unique-violation',
  foreign_key_violation: 'foreign-key-violation',
  still_referenced: 'still-referenced',
};

/** Each application error's reason, by its status: a status `runtime/errors.ts` adds doesn't compile until it's here. */
const APP_ERROR_REASONS: Readonly<Record<AppErrorStatus, RefusalReason>> = {
  400: 'bad-request',
  404: 'not-found',
};

/** `data` is a response body: an interface (no index signature), so it is taken as an object and carried as one. */
function refusal(reason: RefusalReason, detail: string, data: object): Refusal {
  return { reason, detail, instead: REFUSALS[reason], data: data as Readonly<Record<string, unknown>> };
}

/** The refusal a thrown error is, or null when it is a crash. */
export function refusalOf(err: unknown): Refusal | null {
  if (err instanceof IncludeNotAllowedError) {
    // The body the Nest controller builds for it: `{ statusCode, error, code, path, message }`.
    const asBadRequest = new BadRequestError(err.message, { code: err.code, details: { path: err.path } });
    return refusal('include-not-allowed', err.message, errorBody(asBadRequest));
  }
  if (err instanceof AppError) return refusal(APP_ERROR_REASONS[err.status], err.message, errorBody(err));
  const violation = constraintViolationOf(err);
  if (violation) return refusal(CONSTRAINT_REASONS[violation.code], violation.message, constraintViolationBody(violation));
  return null;
}

/** Runs `fn`: its result, or the refusal what it threw is. A crash rethrows. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (err: unknown) {
    const refused = refusalOf(err);
    if (refused) return { ok: false, refusal: refused };
    throw err;
  }
}

/** The refusal for an input its schema refused. */
export function invalidInput(issues: readonly ValidationIssueInput[]): Refusal {
  return refusal('invalid-input', 'Validation failed', validationErrorBody(issues));
}

/** A use case's "no such row" (`null`), as the Nest controller throws it: `<Entity> <id> not found`. */
export function orNotFound<T>(row: T | null | undefined, message: string): T {
  if (row === null || row === undefined) throw new NotFoundError(message);
  return row;
}

/**
 * Call a command from outside: parse the raw input with its schema (a failure is `invalid-input`), then run it. Every
 * way in calls this, never `run` on unparsed input.
 */
export async function invokeCommand<Apis, I, T, Ctx extends CommandContext>(
  command: Command<Apis, I, T, Ctx>,
  apis: Apis,
  raw: unknown,
  ctx: Ctx,
): Promise<Outcome<T>> {
  const parsed = command.input.safeParse(raw);
  if (!parsed.success) return { ok: false, refusal: invalidInput(parsed.error.issues) };
  return command.run(apis, parsed.data, ctx);
}
