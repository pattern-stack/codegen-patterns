import type { NewChild, Slot } from '../model/children.ts';
import type {
  Chunk,
  ChunkClaim,
  RenewReport,
  SettleOutcome,
} from '../model/chunk.ts';
import type { Done, Failed, Item, ItemRef, ItemResult } from '../model/item.ts';
import type {
  NewRun,
  Run,
  RunError,
  RunProgress,
  RunStatus,
  RunSubject,
  RunTransition,
  Spend,
} from '../model/run.ts';
import type { RunLeases } from './run-lease.ts';
import type { Speculation, StepState, WaitKind } from '../model/step-state.ts';

/** How a reservation went: granted; refused and this call paused the run; or refused, the run not running. */
/** Part of a step's items by ordinal: from `from` (default 0), at most `limit` (default all). */
export interface ItemRange {
  from?: number;
  limit?: number;
}

export type Reservation = 'ok' | 'paused' | 'refused';

/**
 * The port every store adapter implements, and `storeContract` (`@pattern-stack/jobs/testing`) holds each to: the first
 * write of a result wins; a lost claim is fenced; counts move with items; a crash loses only what was in flight. Ids
 * come from the store, never the engine.
 */
export interface JobStore {
  // ── runs ──────────────────────────────────────────────────────────────────
  /**
   * A new run (`created: true`), or the open one with the same tenant, job, dry or real, and dedupe key
   * (`created: false`).
   */
  createRun(run: NewRun): Promise<{ run: Run; created: boolean }>;
  /** Not tenant-scoped: a surface must check `run.tenantId` before returning anything. */
  getRun(runId: string): Promise<Run>;
  /**
   * Pending and running runs (not paused, not waiting), oldest first (by `createdAt`, then `id`): the sweeper's backstop
   * re-submits them. `after` continues past that run in the same order, so a sweep can rotate through more open runs
   * than one page holds; past a run the store doesn't have, none.
   */
  openRunIds(limit: number, after?: string): Promise<string[]>;
  /**
   * One tenant's runs, newest first (by `createdAt`, then `id`), at most `limit`. `before` continues a listing
   * from its last run. `subject` keeps the runs about it (`Run.subject`, kind and id both equal).
   */
  listRuns(filter: {
    tenantId: string;
    jobKey?: string;
    status?: RunStatus;
    subject?: RunSubject;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<Run[]>;
  /**
   * Applies a status change; `changed: false` when the run was not in a state that takes it. Down the tree, in the
   * same transaction, the parent's row locked first: a terminal status cancels every open descendant, and pokes its
   * parent's waiting step (`wakeAt` now); a pause pauses every open descendant with reason `parent`; a resume resumes
   * only the descendants paused with reason `parent`. `cascaded` is the descendants it changed.
   */
  transition(
    runId: string,
    t: RunTransition,
  ): Promise<{ changed: boolean; run: Run; cascaded: Run[] }>;
  /**
   * Reserves one call's estimated spend against the run's budget, held by the claimed chunk; refused (and the run
   * paused) once the budget is spent or past its deadline. A reservation is settled by the estimate it reserved:
   * `writeResults` with `reservedUsd`, or `releaseReservation` for a call that failed. A chunk's outstanding
   * reservations are dropped when it settles or is swept, so a crash can't strand one.
   */
  reserve(claim: ChunkClaim, estimateUsd: number): Promise<Reservation>;
  /** Returns a failed call's reservation (its estimate and its call). */
  releaseReservation(claim: ChunkClaim, estimateUsd: number): Promise<void>;
  /** Not tenant-scoped: a surface must check `run.tenantId` before returning anything. */
  progress(runId: string): Promise<RunProgress>;

  // ── steps ─────────────────────────────────────────────────────────────────
  /**
   * In order. A step not yet started has no state. Not tenant-scoped: a surface must check
   * `run.tenantId` before returning anything.
   */
  stepStates(runId: string): Promise<StepState[]>;
  /**
   * Starts (or restarts) a step: running, one more attempt, as a CAS on its attempts. It starts only while the step is
   * at `expect.attempts` (0 for a step with no row, or one parked before it started) and not completed, skipped or
   * failed; otherwise it changes nothing and returns null, so of two advancers racing on one attempt only one runs it.
   */
  startStep(
    runId: string,
    step: { name: string; index: number; kind: 'step' | 'map' },
    expect: { attempts: number },
  ): Promise<StepState | null>;
  /** Completes a step (or skips it): its small output (only on a store that keeps values), or a map step's speculation. */
  recordStep(
    runId: string,
    name: string,
    record: {
      status: 'completed' | 'skipped';
      output?: unknown;
      speculation?: Speculation;
    },
  ): Promise<void>;
  failStep(runId: string, name: string, error: RunError): Promise<void>;
  /** The run's input as the store kept it; undefined when it kept none (a recorder holds it, or it is void). */
  runInput(runId: string): Promise<unknown>;
  /** A completed step's recorded output; undefined when it recorded none. */
  stepOutput(runId: string, name: string): Promise<unknown>;
  /**
   * Parks a step on its wait, through a CAS: only while its run is `running` or `waiting` and the step is not yet
   * started, `running` or already `waiting`. The step goes `waiting` with its wait (kind, name, `wakeAt`; its
   * `since` kept when it was already waiting on the same thing), and a running run goes `waiting`. A step that has
   * no row yet gets one with no attempt spent; `returnAttempt` gives back the attempt a plain step spent before it
   * found its gate closed (never below zero), as a chunk's yield does. False when the CAS failed (the run was paused,
   * canceled or ended, or the step settled).
   */
  park(
    runId: string,
    step: { name: string; index: number; kind: StepState['kind'] },
    wait: {
      kind: WaitKind;
      name: string;
      wakeAt: Date | null;
      returnAttempt?: boolean;
    },
  ): Promise<boolean>;
  /**
   * A waiting step carries on: `waiting` → `running`, its `wakeAt` cleared (its wait's kind and name stay, as what it
   * waited for), and a `waiting` run goes `running`. False when the step wasn't waiting.
   */
  unpark(runId: string, step: string): Promise<boolean>;
  /**
   * Waiting runs whose waiting step is due (`wakeAt` ≤ `now`), oldest first (by `createdAt`, then `id`); `after`
   * continues past that run, as `openRunIds`. The sweep resubmits them; it never changes a parked run's status.
   */
  dueRunIds(now: Date, limit: number, after?: string): Promise<string[]>;
  /**
   * A signal settles its step, in one write: a CAS on the step `waiting` for that signal (kind `signal`, its name);
   * the value recorded as the step's output; the step `completed` with `settledBy`, its `wakeAt` cleared; a `waiting`
   * run back to `running` (a paused one stays paused: the resume carries on). The first signal wins: false when the
   * step wasn't waiting for it.
   */
  settleWait(
    runId: string,
    step: string,
    settle: { signal: string; output: unknown; by: string | null },
  ): Promise<boolean>;
  /**
   * A gate's push: every step of the tenant waiting on the gate `name` is due now (`wakeAt` = now). Returns the
   * waiting runs it woke, for the caller to submit; never another tenant's.
   */
  wakeGate(tenantId: string, name: string): Promise<string[]>;
  /**
   * A children step's slots and their children, in one transaction under the parent's lock: the step's row (kind
   * `children`) if it has none, a slot per new key (an item of the step: no chunk), and a pending child run for each
   * slot it inserted, inheriting the parent's tenant, `dryRun`, requester, trigger and cache mode, its input
   * kept, at the parent's depth + 1 (refused past `MAX_DEPTH`). A key that has a slot starts nothing: a step run
   * again gets its slots back. Returns every slot of the step and the children it started.
   */
  startChildren(
    parent: { runId: string; step: string; index: number },
    children: readonly NewChild[],
  ): Promise<{ slots: Slot[]; started: Slot[] }>;
  /**
   * Each pending slot whose child has ended takes its outcome: done (completed) or failed (failed or canceled, the
   * child's error type or `Canceled`), moving the step's counts. Returns every slot and those it settled now.
   */
  settleSlots(
    runId: string,
    step: string,
  ): Promise<{ slots: Slot[]; ended: Slot[] }>;
  /**
   * An operator's retry: a failed slot only. A new child run (the same key, its own budget) takes the slot, one more
   * attempt, pending again. Null when the slot isn't failed.
   */
  retryChild(
    runId: string,
    step: string,
    key: string,
    child: NewChild,
  ): Promise<Slot | null>;
  /** An operator's skip: a failed slot only, now skipped, and the parent's waiting step poked. Null otherwise. */
  skipChild(runId: string, step: string, key: string): Promise<Slot | null>;
  /** The run's spend and every descendant's, every attempt included, each once. */
  treeSpend(runId: string): Promise<Spend>;
  /**
   * A map step's early stop: the items from ordinal `used` on are skipped and its unsettled chunks canceled, so a
   * worker still on one loses its claim. The step is planned from then on: a page planned after the stop adds nothing.
   */
  stopStep(runId: string, name: string, used: number): Promise<void>;

  // ── items ─────────────────────────────────────────────────────────────────
  /** One planned page of a map step: its items, the chunks it fills, and the cursor, in one write. */
  planItems(
    runId: string,
    step: string,
    page: { refs: ItemRef[]; keys: string[]; next: string | null },
  ): Promise<void>;
  /**
   * A map step's items in planned order: every one, or from ordinal `from` on, at most `limit` of them (a read the
   * early stop makes as its settled prefix grows, so it never re-reads what it has).
   */
  items(runId: string, step: string, range?: ItemRange): Promise<Item[]>;
  /** The claimed chunk's items still pending. */
  pendingItems(claim: ChunkClaim): Promise<Item[]>;
  /** The cache read: stored results by key, within one tenant and scope. Only on a store that keeps values. */
  itemResults<R>(
    scope: string,
    tenantId: string,
    keys: string[],
  ): Promise<Map<string, ItemResult<R>>>;

  // ── chunks ────────────────────────────────────────────────────────────────
  /**
   * Claims one chunk, spending an attempt. Named: that chunk if it is pending, eligible (its `runAt` passed) and its
   * run running, else null, never another chunk (a dispatcher's job id is that chunk's). Unnamed: the next eligible
   * one, or null.
   */
  claimChunk(
    owner: string,
    ttlMs: number,
    chunk?: { runId: string; step: string; index: number },
  ): Promise<ChunkClaim | null>;
  /**
   * Every chunk of a run, by step index then chunk index. Not tenant-scoped: a surface must check
   * `run.tenantId` before returning anything.
   */
  chunks(runId: string): Promise<Chunk[]>;
  /**
   * A run's pending chunks, due first (by `runAt`, then step index and chunk index), at most `limit`: what a
   * dispatcher enqueues, read a window at a time so an advance never reads the whole run.
   */
  pendingChunks(runId: string, limit: number): Promise<Chunk[]>;
  /**
   * Claims up to `limit` eligible chunks of running runs, spending an attempt each. With `jobKeys`, only chunks of
   * runs of those jobs: an executor claims only what its registry can run, so a shared store's other jobs are never
   * taken (and failed) by it.
   */
  claimChunks(
    owner: string,
    limit: number,
    ttlMs: number,
    jobKeys?: readonly string[],
  ): Promise<ChunkClaim[]>;
  /** Renews claims, each by its token. Reports the claims lost and each run's status, so a worker sees a cancel or a pause. */
  renewClaim(
    owner: string,
    claims: ChunkClaim[],
    ttlMs: number,
  ): Promise<RenewReport>;
  /**
   * Writes one call's outcome in three parts. Its results land unfenced (first write wins). Its spend lands unfenced
   * on the run and the chunk: spend is a fact about money, never about the claim, so a call that settles after a
   * cancel or a lost claim still records what it cost. Its marks, counts and reservation release are fenced by the
   * claim's token: a worker whose claim was lost (or whose run ended) gets a `ClaimLostError` after its results and
   * spend landed, and its items keep their status. A call's write names the estimate it reserved (`reservedUsd`),
   * which is released, not the actual spend. Its results are kept under `scope` (the step's `cacheScope`), else under
   * the step's own, `resultScope(run.jobKey, claim.step)`.
   */
  writeResults<R>(
    claim: ChunkClaim,
    batch: {
      done?: Done<R>[];
      cached?: string[];
      failed?: Failed[];
      scope?: string;
    },
    spend: Spend,
    reservation?: { reservedUsd: number },
  ): Promise<void>;
  /**
   * Records a call's spend on the run and the claimed chunk, unfenced: a call that paid and then threw
   * (`withSpend`), whatever became of its claim or its run. Each call's spend is recorded exactly once, by its
   * write or by this. Throws `RunNotFoundError` for an unknown run.
   */
  addSpend(claim: ChunkClaim, spend: Spend): Promise<void>;
  /** Settles a claimed chunk. Fenced, as `writeResults`. */
  releaseChunk(claim: ChunkClaim, outcome: SettleOutcome): Promise<void>;
  /** Claims expired by the store's own clock go back to pending. */
  sweepExpired(): Promise<number>;

  /**
   * Whether the store keeps values itself, as plain JSON: a run's input, a step's output, an item's result, kept
   * beside the run's bookkeeping and never in it. Every durable store does. One that doesn't is never handed a value:
   * every value of a job it runs lives in a recorder, and `startRun` refuses a job with a value that has none.
   */
  readonly keepsValues: boolean;
  /**
   * Whether a crash can lose acknowledged writes. On a store that isn't durable, `startRun` refuses a job with a
   * side-effecting step before the run is created.
   */
  readonly durability: 'none' | 'durable' | 'lossy';
  /**
   * The lease on advancing a run (`run-lease.ts`), for a store several in-process executors share. Optional: without
   * it, run one in-process executor per store.
   */
  readonly runLeases?: RunLeases;
}
