/**
 * Commands (H-1): one thing a caller can ask an app to do, the same for every way in (HTTP, MCP tools, a CLI). A
 * command names what it needs (`Apis`), takes one input object checked by its schema, and comes back with an
 * `Outcome`: a result, or a refusal by policy that says what to do instead. Each way in maps its own syntax (a request,
 * a tool call, flags) onto the input, and the outcome onto its answer.
 *
 * Crew's shapes (`core/kernel/command.ts`, `outcome.ts`), with two additions it doesn't need yet: a command's `effect`
 * (whether running it twice is safe, so a caller knows when to pass an idempotency key) and a refusal's `data` (the
 * structured fields a way in may print). No dependencies: the input schema is typed by what it does (`safeParse`), so a
 * Zod schema fits without this package importing Zod.
 */

/** Whether running a command twice is safe: a read changes nothing; an idempotent write lands once however often it runs. */
export const EFFECTS = ['read', 'idempotent', 'side-effect'] as const;
export type Effect = (typeof EFFECTS)[number];

/** A refusal: expected, never a crash, and it always says what to do instead. */
export interface Refusal {
  /** A short, stable slug a program can branch on: `not-found`, `invalid-input`. */
  readonly reason: string;
  /** What happened, in words. */
  readonly detail: string;
  /** What to do instead, in words. */
  readonly instead: string;
  /** Structured fields a way in may print (an HTTP body's `code`, `path`, `issues`). */
  readonly data?: Readonly<Record<string, unknown>>;
}

export type Outcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly refusal: Refusal };

const REASON = /^[a-z][a-z0-9-]*$/;

export const done = <T>(result: T): Outcome<T> => ({ ok: true, result });

export function refuse(
  reason: string,
  detail: string,
  instead: string,
  data?: Readonly<Record<string, unknown>>,
): { readonly ok: false; readonly refusal: Refusal } {
  if (!REASON.test(reason)) throw new TypeError(`refuse: reason '${reason}' is not a lowercase slug`);
  if (!detail || !instead) throw new TypeError(`refuse(${reason}): a refusal says what happened and what to do instead`);
  return { ok: false, refusal: { reason, detail, instead, ...(data ? { data } : {}) } };
}

/** One problem with an input, as a schema reports it (Zod's issues fit). */
export interface InputIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

/** What a command's input schema does: parse an unknown value, or say what's wrong with it. */
export interface InputSchema<I> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: I }
    | { readonly success: false; readonly error: { readonly issues: readonly InputIssue[] } };
}

/** What a way in passes with a call, besides the input. */
export interface CommandContext {
  /**
   * For a `side-effect` command: a key the caller makes up per intended effect (a job step passes `runId/step`). A
   * repeat call with the same key is to answer with the first call's outcome instead of running again. This package
   * only carries the key; whoever runs the command honours it (codegen's command layer does from H-1d; until then
   * nothing reads it).
   */
  readonly idempotencyKey?: string;
}

export interface Command<Apis, I = unknown, T = unknown, Ctx extends CommandContext = CommandContext> {
  /** Its words, as typed: `contact create`. */
  readonly name: string;
  /** One line: what it does. */
  readonly summary: string;
  readonly effect: Effect;
  /** The input's keys that may also come as positional arguments, in order. */
  readonly args?: readonly string[];
  /** The input, as one object. */
  readonly input: InputSchema<I>;
  /** Runs it on input the schema has parsed. A refusal is an outcome; only a crash throws. */
  run(apis: Apis, input: I, ctx: Ctx): Promise<Outcome<T>>;
}

/** A command, typed from its parts. */
export const defineCommand = <Apis, I, T, Ctx extends CommandContext = CommandContext>(
  command: Command<Apis, I, T, Ctx>,
): Command<Apis, I, T, Ctx> => command;

/**
 * The same command, run against a larger set of APIs: `select` finds the ones it needs. An entity's commands take its
 * own use cases; the app's table re-targets each onto the composed app.
 */
export function onApis<Outer, Apis, I, T, Ctx extends CommandContext>(
  command: Command<Apis, I, T, Ctx>,
  select: (outer: Outer) => Apis,
): Command<Outer, I, T, Ctx> {
  return { ...command, run: (outer, input, ctx) => command.run(select(outer), input, ctx) };
}

/**
 * `onApis` for a list of commands on the same APIs (an entity's), typed loosely: a table of many commands holds each
 * input and result as `unknown`; the list it came from keeps them exact.
 */
export function allOnApis<Outer, Apis, Ctx extends CommandContext>(
  commands: readonly Command<Apis, unknown, unknown, Ctx>[],
  select: (outer: Outer) => Apis,
): Command<Outer, unknown, unknown, Ctx>[] {
  return commands.map((command) => onApis(command, select));
}
