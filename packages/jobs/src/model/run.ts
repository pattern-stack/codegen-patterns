import type { ChunkStatus } from './chunk.ts';
import type { StepState } from './step-state.ts';

/** What started a run. 'event' is a start by the event bridge (codegen's ADR-023), from a domain event's trigger. */
export type RunTrigger = 'manual' | 'eval' | 'agent' | 'schedule' | 'event';
/**
 * How a run treats the result cache. `read-write` (the default) reuses a stored answer for a key and stores new ones,
 * the first write winning. `refresh` re-asks every item and overwrites the stored answer with its own while its claim
 * holds, so it reads back what it paid for; a late answer (a lost claim, an ended run) never overwrites.
 */
export type CacheMode = 'read-write' | 'refresh';
/** What a start does when its dedupe key already has an open run (`RunRequest.collision`). */
export type Collision = 'join' | 'queue' | 'replace';
export type RunStatus =
  /**
   * Held behind the open run on its dedupe key (a start with `collision: 'queue'`): not open, so not in the
   * one-open-run index and never advanced; the store makes the oldest one `pending` when the run ahead of it ends.
   */
  | 'queued'
  | 'pending'
  | 'running'
  /** Parked: nothing of it is in flight; its step waits on something outside the run: a gate, a signal or its child runs. */
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';
/** `parent`: its parent run was paused, and the pause cascaded down to this child run. */
export type PauseReason = 'budget' | 'deadline' | 'operator' | 'parent';

export const ACTIVE_RUN: readonly RunStatus[] = [
  'pending',
  'running',
  'waiting',
  'paused',
];
export const TERMINAL_RUN: readonly RunStatus[] = [
  'completed',
  'failed',
  'canceled',
];

export interface Budget {
  /** Required: the per-run cap on items each map step plans (Review Priority 14). */
  maxItems: number;
  maxUsd?: number;
  maxCalls?: number;
  deadline?: Date;
}

export interface Spend {
  calls: number;
  inputTokens: number;
  costUsd: number;
}

export const zeroSpend = (): Spend => ({
  calls: 0,
  inputTokens: 0,
  costUsd: 0,
});

export interface RunError {
  type: string;
  message: string;
}

/** What a run is asked to do: data that survives a restart. A job is code; a request is data. */
export interface RunRequest<I> {
  jobKey: string;
  input: I;
  tenantId: string;
  trigger: RunTrigger;
  requestedBy: string | null;
  budget: Budget;
  /** At most one open run per tenant, job and key: what a start finding one open does is `collision`. */
  dedupeKey?: string;
  /**
   * A start whose dedupe key already has an open run: `join` returns it (the default); `queue` makes a new run held
   * `queued` behind it, started when the runs ahead of it on the key end, oldest first; `replace` cancels it (its
   * children too), then starts afresh. Without a dedupe key, every start is a new run.
   */
  collision?: Collision;
  /**
   * Duplicate starts within a window: a start within `dedupeWindowMs` after a run on the same key ended returns
   * that run, as if it were open. Default 0, none. Never the bridge's exactly-once: that is its transaction's.
   */
  dedupeWindowMs?: number;
  /** `refresh` re-asks every item and overwrites the cache with its answers. Default: the job's `cacheFor`, else read-write. */
  cache?: CacheMode;
  /** The engine's: items per chunk. Default 1000. */
  chunkSize?: number;
  /** The engine's: chunks in flight per executor process; default from the limiter. */
  chunkConcurrency?: number;
  /** A run that may read and decide but publish nothing; its steps see it as `dryRun`. Default false. */
  dryRun?: boolean;
}

/**
 * What a run is about (a document, an account): a free-text kind and the subject's id. Named by the job from
 * its input at start (`defineJob({ subject })`), never by a caller. No registry of kinds yet.
 */
export interface RunSubject {
  kind: string;
  id: string;
}

/** The bounds of a subject's kind and id. */
export const RUN_SUBJECT_KIND_MAX = 64;
export const RUN_SUBJECT_ID_MAX = 255;

/** A request as the store creates it: the engine adds the definition's version and the run's subject. */
export interface NewRun extends RunRequest<unknown> {
  jobVersion: string;
  subject?: RunSubject | null;
}

export interface Run {
  id: string;
  jobKey: string;
  /** The definition's hash when the run was created: a run is read against the definition it ran. */
  jobVersion: string;
  tenantId: string;
  dryRun: boolean;
  status: RunStatus;
  pauseReason: PauseReason | null;
  trigger: RunTrigger;
  requestedBy: string | null;
  chunkSize: number;
  chunkConcurrency: number | null;
  budget: Budget;
  cache: CacheMode;
  dedupeKey: string | null;
  /** What the run is about, as its job named it from its input; null for a job that names none. */
  subject: RunSubject | null;
  spend: Spend;
  /** Reserved and not yet spent. */
  reservedUsd: number;
  error: RunError | null;
  /** The run whose children step started this one; null for a run nobody started. */
  parentRunId: string | null;
  /** The parent's step that started it. */
  parentStep: string | null;
  /** Its slot's key in that step. */
  childKey: string | null;
  /** 0 for a run nobody started; its parent's + 1 otherwise, at most `MAX_DEPTH`. */
  depth: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Runs nest at most this deep: a run nobody started is 0. */
export const MAX_DEPTH = 3;

/**
 * The status changes a run takes. Any other is refused (`changed: false`). Starting and resuming name the status they
 * come from, so a pause that lands between reading a run and starting it is never silently undone.
 */
export type RunTransition =
  /** Started: only from pending. */
  | { to: 'running'; from: 'pending' }
  /** Resumed: only from paused, optionally under a new budget. */
  | { to: 'running'; from: 'paused'; budget?: Budget }
  /** A waiting run's wait settled: only from waiting. */
  | { to: 'running'; from: 'waiting' }
  /** A step parked: only from running. */
  | { to: 'waiting' }
  | { to: 'paused'; reason: PauseReason }
  | { to: 'canceled' }
  | { to: 'completed' }
  | { to: 'failed'; error: RunError };

const ALLOWED: Record<
  Exclude<RunTransition['to'], 'running'>,
  readonly RunStatus[]
> = {
  paused: ['pending', 'running', 'waiting'],
  waiting: ['running'],
  canceled: [...ACTIVE_RUN, 'queued'],
  completed: ['running'],
  failed: [...ACTIVE_RUN, 'queued'],
};

/** Whether a run in `from` may take `t`: the one rule every store applies. */
export const canTransition = (from: RunStatus, t: RunTransition): boolean =>
  t.to === 'running' ? from === t.from : ALLOWED[t.to].includes(from);

/**
 * Why a run's budget stops it now, if it does: a deadline passed, or the next reservation would spend past
 * `maxUsd` or `maxCalls`. `reserved` is what is reserved and not yet spent. The one rule every store's `reserve` and
 * the engine's check between steps apply.
 */
export function budgetStop(
  budget: Budget,
  spend: Spend,
  reserved: { usd: number; calls: number },
  next: { usd: number; calls: number },
  now: Date,
): PauseReason | null {
  if (budget.deadline && now >= budget.deadline) return 'deadline';
  if (
    budget.maxUsd !== undefined &&
    spend.costUsd + reserved.usd + next.usd > budget.maxUsd
  )
    return 'budget';
  if (
    budget.maxCalls !== undefined &&
    next.calls > 0 &&
    spend.calls + reserved.calls + next.calls > budget.maxCalls
  )
    return 'budget';
  return null;
}

export interface RunProgress {
  run: Run;
  steps: StepState[];
  chunks: Record<ChunkStatus, number>;
}
