/**
 * The Hono view of the generated commands (H-1b, `docs/specs/H-1.md`). Framework-free apart from `hono` itself, and
 * runtime-neutral (Bun and Node).
 *
 * A generated route binds the request onto its command's input, runs it with `invokeCommand`, and answers with
 * `answer`: a result with the route's success status, a refusal with the status its reason has in `REFUSAL_STATUS`
 * and the body the refusal carries (the Nest target's, byte for byte). What a route checks before it binds, and what
 * the app answers outside any route, are Nest's too: a malformed `:id` (`ParseUUIDPipe`), an unknown route, a crash.
 */
import type { Context, Hono } from 'hono';
import type { Outcome } from '@pattern-stack/wiring/commands';
import { REFUSALS, type RefusalReason } from '../commands';
import { BadRequestError, errorBody } from '../errors';
import { createLogger } from '../logger';

const logger = createLogger('http');

/** The status each refusal reason answers with. One row per reason `runtime/commands.ts` refuses with. */
export const REFUSAL_STATUS: { readonly [R in RefusalReason]: 400 | 401 | 403 | 404 | 409 | 422 } = {
  'invalid-input': 400,
  'bad-request': 400,
  'include-not-allowed': 400,
  'not-found': 404,
  'unique-violation': 409,
  'still-referenced': 409,
  'foreign-key-violation': 422,
  unauthenticated: 401,
  forbidden: 403,
  conflict: 409,
};

/** A result's status: what a route answers when its command succeeds (Nest's: 201 for a create, else 200). */
export type SuccessStatus = 200 | 201;

/** The answer to a command's outcome. A refusal with a reason no row names is a crash (500), naming the rows. */
export function answer(c: Context, outcome: Outcome<unknown>, success: SuccessStatus): Response {
  if (outcome.ok) {
    // A command with no result (a delete) answers with an empty body, as a Nest handler returning void does.
    if (outcome.result === undefined) return c.body(null, success);
    return c.json(outcome.result as object, success);
  }
  const { reason, data } = outcome.refusal;
  const status = (REFUSAL_STATUS as Readonly<Record<string, 400 | 401 | 403 | 404 | 409 | 422>>)[reason];
  if (status === undefined) {
    throw new Error(`answer: refusal '${reason}' has no status; REFUSAL_STATUS names ${Object.keys(REFUSALS).join(', ')}`);
  }
  return c.json(data ?? { statusCode: status, message: outcome.refusal.detail }, status);
}

/** `ParseUUIDPipe`'s check (Nest's default, any version): 8-4-4-4-12 hex. */
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** A malformed `:id`'s answer, or null when it is well formed: the body `ParseUUIDPipe` throws. */
export function badId(c: Context, id: string): Response | null {
  if (UUID.test(id)) return null;
  return c.json(errorBody(new BadRequestError('Validation failed (uuid is expected)')), 400);
}

/**
 * The request body, as Nest's JSON body parser (Express's `body-parser.json`, strict) reads it: parsed only when the
 * content type is `application/json`, else `{}`; an empty body is `{}`; a body whose first character is not `{` or `[`,
 * or that is malformed, is a 400 with the parser's message (built the way body-parser builds it, from `JSON.parse`).
 */
export async function jsonBody(c: Context): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { ok: true, body: {} };
  const text = await c.req.text();
  if (text.length === 0) return { ok: true, body: {} };
  const refuse = (message: string) => ({ ok: false as const, response: c.json(errorBody(new BadRequestError(message)), 400) });
  const first = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/.exec(text)?.[1];
  if (first !== '{' && first !== '[') return refuse(strictViolationMessage(text, first));
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (err: unknown) {
    return refuse(err instanceof Error ? err.message : 'Malformed JSON');
  }
}

/** body-parser's message for a top level that isn't an object or array: `JSON.parse`'s, at that character. */
function strictViolationMessage(text: string, char: string | undefined): string {
  const index = char === undefined ? -1 : text.indexOf(char);
  const partial = index === -1 ? '' : text.slice(0, index) + '#'.repeat(text.length - index);
  try {
    JSON.parse(partial);
    return 'strict violation';
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'strict violation';
    return message.replace(/#+/g, (placeholder) => text.slice(index, index + placeholder.length));
  }
}

/**
 * The query, as Express's parser reads a flat query: a repeated key is an array of its values, a single one a string.
 * (Express also nests bracket keys, `a[b]=1`; the generated list and search queries have none.)
 */
export function queryOf(c: Context): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(c.req.queries())) out[key] = values.length === 1 ? values[0]! : values;
  return out;
}

/** Installs Nest's answers outside any route: an unknown route (404 `Cannot GET /x`) and a crash (500). */
export function useNestFallbacks(app: Hono): void {
  app.notFound((c) => {
    // Nest names the request's original URL, query string included.
    const url = new URL(c.req.url);
    return c.json({ message: `Cannot ${c.req.method} ${url.pathname}${url.search}`, error: 'Not Found', statusCode: 404 }, 404);
  });
  app.onError((err, c) => {
    // A crash is the server's fault: logged, and answered without its detail, as Nest's exception filter does.
    logger.error(`${c.req.method} ${c.req.path} crashed`, err);
    return c.json({ statusCode: 500, message: 'Internal server error' }, 500);
  });
}

/**
 * A command's input from a body and the fields the path and query carry. A body that is not a plain object is passed
 * as it is (with no path or query fields), so the command's schema refuses it at the root, as the Nest pipe does.
 */
export function bindInput(body: unknown, fields: Readonly<Record<string, unknown>>): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  return { ...body, ...fields };
}
