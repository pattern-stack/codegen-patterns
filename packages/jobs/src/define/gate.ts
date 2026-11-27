import { JobDefinitionError } from '../model/errors.ts';
import type { ErasedContext, StepContext } from './step.ts';

/** What a gate's `isOpen` reads: the step's context, so a gate can be about the tenant or the run's own input. */
export type GateContext = StepContext<unknown, object>;

/** A gate's poll: after `initialMs`, then as long as the step has waited so far, at most `maxMs`. */
export interface GatePoll {
  /** Default 60 s. */
  initialMs?: number;
  /** Default 15 min. */
  maxMs?: number;
}

export interface GateOptions<C> {
  /** A code constant (`ai-processing`, `backfill-done`): it reaches the step's row, events and logs, never content. */
  name: string;
  /** Whether the step may run now. Read before the step starts, at the start of each chunk, and on each poll. */
  isOpen: (ctx: C) => boolean | Promise<boolean>;
  poll?: GatePoll;
  /** How long a step may wait on it before it fails (`GateTimedOutError`). Default: no limit. */
  maxWaitMs?: number;
}

/** A gate as the engine holds it, its types closed over. */
export interface ErasedGate {
  name: string;
  isOpen(ctx: ErasedContext): Promise<boolean>;
  initialPollMs: number;
  maxPollMs: number;
  maxWaitMs: number | undefined;
}

/**
 * A named condition outside the run (the tenant's AI switch, a version's backfill finished), declared once
 * and shared by the jobs that read it. `C` is what `isOpen` reads; a gate fits any step whose context has it.
 */
export interface Gate<C> {
  readonly name: string;
  readonly erased: ErasedGate;
  /** Contravariant in `C`: a gate about the tenant fits every step. */
  readonly __reads?: (ctx: C) => void;
}

export const DEFAULT_GATE_POLL_MS = 60_000;
export const MAX_GATE_POLL_MS = 15 * 60_000;
/** A gate's or a signal's name: a code constant, never content (it reaches rows, events and logs). */
export const CODE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * A closed gate is never a failure or a skip: the step waits (`waiting`, the gate's name on its row) and carries on
 * when the gate opens, by its poll or by `openGate`.
 */
export function gate<C = GateContext>(options: GateOptions<C>): Gate<C> {
  const { name, poll, maxWaitMs } = options;
  if (!CODE_NAME.test(name))
    throw new JobDefinitionError(
      `a gate's name is a code constant (lowercase letters, digits, '.', '_', '-'), not ${JSON.stringify(name)}`,
    );
  const initialPollMs = poll?.initialMs ?? DEFAULT_GATE_POLL_MS;
  const maxPollMs = poll?.maxMs ?? MAX_GATE_POLL_MS;
  if (!(initialPollMs > 0 && maxPollMs >= initialPollMs))
    throw new JobDefinitionError(
      `gate ${name}: its poll needs 0 < initialMs ≤ maxMs`,
    );
  if (maxWaitMs !== undefined && !(maxWaitMs > 0))
    throw new JobDefinitionError(`gate ${name}: maxWaitMs must be positive`);
  return {
    name,
    erased: {
      name,
      isOpen: async (ctx) => options.isOpen(ctx as C),
      initialPollMs,
      maxPollMs,
      maxWaitMs,
    },
  };
}

/** A step's gates, erased; two gates of one name on a step are a definition error. */
export function erasedGates<C>(
  gates: readonly Gate<C>[] | undefined,
): ErasedGate[] {
  const out = (gates ?? []).map((g) => g.erased);
  const names = new Set<string>();
  for (const g of out) {
    if (names.has(g.name))
      throw new JobDefinitionError(`a step names the gate ${g.name} twice`);
    names.add(g.name);
  }
  return out;
}

/** When a closed gate is read again: it waits as long as it has waited so far, from its first poll up to its last. */
export function nextPoll(gate: ErasedGate, since: Date, now: Date): Date {
  const waited = now.getTime() - since.getTime();
  const delay = Math.min(gate.maxPollMs, Math.max(gate.initialPollMs, waited));
  return new Date(now.getTime() + delay);
}

/** The first of a step's gates that is closed now, or null when every one is open. */
export async function firstClosed(
  gates: readonly ErasedGate[],
  ctx: ErasedContext,
): Promise<ErasedGate | null> {
  for (const g of gates) if (!(await g.isOpen(ctx))) return g;
  return null;
}
