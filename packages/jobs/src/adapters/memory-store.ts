import { randomUUID } from 'node:crypto';
import type { RunLease, RunLeases } from '../ports/run-lease.ts';
import {
  MAX_CHILDREN,
  type NewChild,
  type Slot,
  type SlotStatus,
} from '../model/children.ts';
import type {
  Chunk,
  ChunkClaim,
  ChunkStatus,
  RenewReport,
  SettleOutcome,
} from '../model/chunk.ts';
import {
  ClaimLostError,
  JobDefinitionError,
  RunNotFoundError,
} from '../model/errors.ts';
import {
  type Done,
  type Failed,
  type Item,
  type ItemRef,
  type ItemResult,
  type ItemStatus,
  resultScope,
} from '../model/item.ts';
import { byCodeUnit } from '../model/order.ts';
import {
  ACTIVE_RUN,
  type Budget,
  budgetStop,
  canTransition,
  MAX_DEPTH,
  type NewRun,
  type Run,
  type RunError,
  type RunProgress,
  type RunStatus,
  type RunSubject,
  type RunTransition,
  type Spend,
  TERMINAL_RUN,
  zeroSpend,
} from '../model/run.ts';
import {
  type Speculation,
  type StepState,
  type StepStatus,
  type WaitKind,
  zeroCounts,
} from '../model/step-state.ts';
import type { ItemRange, JobStore, Reservation } from '../ports/job-store.ts';

/**
 * Every state change is one op, applied by one pure step. The memory store applies ops as they happen; a durable
 * store built on it (a file store for scripts) also appends each to its log and replays the log on open, so the two
 * can't disagree about a transition. Ops hold plain JSON (dates as ISO strings).
 */
type ChunkRef = { runId: string; step: string; index: number };
type WireBudget = Omit<Budget, 'deadline'> & { deadline?: string };
type WireRun = Omit<NewRun, 'budget'> & {
  budget: WireBudget;
  /** Created held behind the open run on its key (`collision: 'queue'`). */
  queued?: true;
  /** A child's link to its parent's slot; absent for a run nobody started. */
  parent?: { runId: string; step: string; key: string; depth: number };
};
type WireOutcome =
  | { kind: 'completed' }
  | { kind: 'retry'; at: string; error: RunError }
  | { kind: 'failed'; error: RunError }
  | { kind: 'yield' };

export type Op =
  | { op: 'create'; id: string; at: string; run: WireRun }
  | {
      op: 'status';
      runId: string;
      to: RunStatus;
      reason: Run['pauseReason'];
      error: RunError | null;
      budget: WireBudget | null;
      at: string;
    }
  | { op: 'reserve'; runId: string; step: string; index: number; usd: number }
  | {
      op: 'unreserve';
      runId: string;
      step: string;
      index: number;
      usd: number;
    }
  | {
      op: 'step-start';
      runId: string;
      name: string;
      index: number;
      kind: 'step' | 'map';
      at: string;
    }
  | {
      op: 'step-record';
      runId: string;
      name: string;
      status: 'completed' | 'skipped';
      output: unknown;
      speculation: Speculation | null;
      at: string;
    }
  | {
      op: 'step-fail';
      runId: string;
      name: string;
      error: RunError;
      at: string;
    }
  | { op: 'step-stop'; runId: string; name: string; used: number; at: string }
  | {
      op: 'park';
      runId: string;
      name: string;
      index: number;
      kind: StepState['kind'];
      waitKind: WaitKind;
      waitName: string;
      wakeAt: string | null;
      returnAttempt: boolean;
      at: string;
    }
  | { op: 'unpark'; runId: string; name: string }
  | {
      op: 'slots';
      runId: string;
      step: string;
      index: number;
      slots: { key: string; childRunId: string }[];
      at: string;
    }
  | {
      op: 'slot';
      runId: string;
      step: string;
      key: string;
      status: SlotStatus;
      errorType: string | null;
      /** A retry: the slot's new child, one more attempt. */
      childRunId?: string;
    }
  | {
      op: 'signal';
      runId: string;
      name: string;
      output: unknown;
      by: string | null;
      at: string;
    }
  | { op: 'wake'; steps: { runId: string; name: string }[]; at: string }
  | {
      op: 'page';
      runId: string;
      step: string;
      refs: ItemRef[];
      keys: string[];
      next: string | null;
      planned: boolean;
      at: string;
    }
  | {
      op: 'claim';
      owner: string;
      chunks: (ChunkRef & { token: string })[];
      expiresAt: string;
      at: string;
    }
  | { op: 'renew'; owner: string; chunks: ChunkRef[]; expiresAt: string }
  | {
      op: 'record';
      runId: string;
      step: string;
      index: number;
      done: string[];
      cached: string[];
      failed: Failed[];
      /** The estimate the call reserved, released with its one call; null for a write that reserved nothing. */
      reservedUsd: number | null;
    }
  /** A call's spend on its run and chunk, unfenced. */
  | { op: 'spend'; runId: string; step: string; index: number; spend: Spend }
  | {
      op: 'settle';
      runId: string;
      step: string;
      index: number;
      outcome: WireOutcome;
      at: string;
    }
  | { op: 'sweep'; chunks: ChunkRef[]; at: string };

type OpOf<K extends Op['op']> = Extract<Op, { op: K }>;

/** An ended child's slot error: none when it completed, `Canceled`, else its error's type. */
const slotErrorOf = (child: Run): string | null => {
  if (child.status === 'completed') return null;
  if (child.status === 'canceled') return 'Canceled';
  return child.error?.type ?? 'Error';
};

/** The step count a child slot's status adds to; a pending slot adds to none. */
const slotCount = (status: ItemStatus): 'done' | 'failed' | 'skipped' | null =>
  status === 'done' || status === 'failed' || status === 'skipped'
    ? status
    : null;

export type WireResult = Omit<ItemResult<unknown>, 'createdAt'> & {
  createdAt: string;
  /** A refresh run's answer, written while its claim held: it replaces a stored one. */
  replace?: true;
};

interface StepRecord {
  state: Omit<StepState, 'chunks'>;
  output: unknown;
}

const stepKey = (runId: string, step: string) => `${runId}\u0000${step}`;
const resultKey = (tenantId: string, scope: string, key: string) =>
  `${tenantId}\u0000${scope}\u0000${key}`;
const zeroChunks = (): Record<ChunkStatus, number> => ({
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
});

const toWireBudget = (b: Budget): WireBudget => ({
  ...b,
  deadline: b.deadline?.toISOString(),
});
const fromWireBudget = (b: WireBudget): Budget => {
  const { deadline, ...rest } = b;
  return deadline ? { ...rest, deadline: new Date(deadline) } : rest;
};

export interface MemoryStoreOptions {
  /** The store's clock: claim expiry, the sweep, timestamps, deadlines. */
  now?: () => Date;
  /**
   * false acts out a store that keeps no values: it throws when handed an input, a step output or an item result,
   * so a test proves every value went to its recorder. Default true, as every durable store.
   */
  keepsValues?: boolean;
}

/** Holds every contract rule in memory, for one process. Lost on exit: tests, evals and scripts. */
/** A step in one of these is never started again. */
const ENDED_STEP: readonly StepStatus[] = ['completed', 'skipped', 'failed'];

export class MemoryJobStore implements JobStore {
  readonly durability: JobStore['durability'] = 'none';
  readonly keepsValues: boolean;
  protected readonly now: () => Date;
  private readonly runs = new Map<string, Run>();
  private readonly steps = new Map<string, Map<string, StepRecord>>();
  private readonly chunkLists = new Map<string, Chunk[]>();
  private readonly stepItems = new Map<string, Item[]>();
  private readonly itemKeys = new Map<string, Map<string, Item>>();
  private readonly reservedCalls = new Map<string, number>();
  /** Outstanding reservations by chunk: settled by the estimate, dropped when the chunk settles or is swept. */
  private readonly reservations = new Map<
    string,
    { usd: number; calls: number }
  >();
  private readonly stored = new Map<string, ItemResult<unknown>>();
  /** Each run's kept input, beside its bookkeeping. */
  private readonly inputs = new Map<string, unknown>();
  /** Each run's advance lease (`RunLeases`): this process's executors share it; never persisted. */
  private readonly leases = new Map<string, RunLease>();

  readonly runLeases: RunLeases = {
    leaseRun: async (runId, owner, ttlMs) => {
      if (!this.runs.has(runId)) return null;
      const now = this.now();
      const held = this.leases.get(runId);
      if (held && held.owner !== owner && held.expiresAt > now) return null;
      const lease = {
        runId,
        owner,
        token: randomUUID(),
        expiresAt: new Date(now.getTime() + ttlMs),
      };
      this.leases.set(runId, lease);
      return { ...lease };
    },
    renewRunLeases: async (leases, ttlMs) => {
      const now = this.now();
      const lost: RunLease[] = [];
      for (const l of leases) {
        const held = this.leases.get(l.runId);
        if (held && held.owner === l.owner && held.token === l.token && held.expiresAt > now)
          held.expiresAt = new Date(now.getTime() + ttlMs);
        else lost.push(l);
      }
      return { lost };
    },
    releaseRunLease: async (lease) => {
      const held = this.leases.get(lease.runId);
      if (held && held.owner === lease.owner && held.token === lease.token)
        this.leases.delete(lease.runId);
    },
  };

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.keepsValues = options.keepsValues ?? true;
  }

  /** A store that keeps no values is never handed one. */
  private refuseValue(what: string, value: unknown): void {
    if (!this.keepsValues && value !== undefined)
      throw new Error(`this store keeps no values, and was handed ${what}`);
  }

  /** A durable store writes the op before it is applied. */
  protected persist(_op: Op): void {
    // Memory keeps nothing past the process: there is no log to write.
  }
  protected persistResult(_result: WireResult): void {
    // As persist: a durable store appends the result to its log.
  }

  private commit(op: Op): void {
    this.persist(op);
    this.apply(op);
  }

  private run(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  private stepRecord(runId: string, name: string): StepRecord {
    const record = this.steps.get(runId)?.get(name);
    if (!record) throw new Error(`no step ${name} started on run ${runId}`);
    return record;
  }

  private chunk(ref: ChunkRef): Chunk {
    const chunk = this.chunkLists.get(stepKey(ref.runId, ref.step))?.[
      ref.index
    ];
    if (!chunk)
      throw new Error(`no chunk ${ref.runId}/${ref.step}#${ref.index}`);
    return chunk;
  }

  private holds(claim: ChunkClaim): boolean {
    const chunk = this.chunkLists.get(stepKey(claim.runId, claim.step))?.[
      claim.index
    ];
    return (
      !!chunk &&
      chunk.status === 'running' &&
      chunk.claim?.owner === claim.owner &&
      chunk.claim.token === claim.token &&
      !TERMINAL_RUN.includes(this.run(claim.runId).status)
    );
  }

  private stepView(runId: string, record: StepRecord): StepState {
    const chunks = zeroChunks();
    for (const c of this.chunkLists.get(stepKey(runId, record.state.name)) ??
      [])
      chunks[c.status]++;
    return structuredClone({ ...record.state, chunks });
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async createRun(req: NewRun): Promise<{ run: Run; created: boolean }> {
    let queued = false;
    if (req.dedupeKey) {
      const onKey = (run: Run) =>
        run.tenantId === req.tenantId &&
        run.jobKey === req.jobKey &&
        run.dryRun === (req.dryRun ?? false) &&
        run.dedupeKey === req.dedupeKey;
      const open = [...this.runs.values()].find(
        (run) => onKey(run) && ACTIVE_RUN.includes(run.status),
      );
      if (open && req.collision === 'queue') queued = true;
      else if (open) return { run: structuredClone(open), created: false };
      const window = req.dedupeWindowMs ?? 0;
      if (!open && window > 0) {
        const since = this.now().getTime() - window;
        const recent = [...this.runs.values()]
          .filter(
            (run) =>
              onKey(run) &&
              TERMINAL_RUN.includes(run.status) &&
              (run.completedAt?.getTime() ?? -Infinity) >= since,
          )
          .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
        if (recent) return { run: structuredClone(recent), created: false };
      }
    }
    const chunkSize = req.chunkSize ?? 1000;
    if (!(Number.isInteger(chunkSize) && chunkSize >= 1))
      throw new Error('chunkSize must be a positive integer');
    if (!(Number.isInteger(req.budget.maxItems) && req.budget.maxItems >= 0))
      throw new Error('budget.maxItems is required: a whole number');
    this.refuseValue('a run input', req.input);
    const id = randomUUID();
    this.commit({
      op: 'create',
      id,
      at: this.now().toISOString(),
      run: {
        ...req,
        chunkSize,
        budget: toWireBudget(req.budget),
        ...(queued ? { queued: true } : {}),
      },
    });
    return { run: structuredClone(this.run(id)), created: true };
  }

  async getRun(runId: string): Promise<Run> {
    return structuredClone(this.run(runId));
  }

  async openRunIds(limit: number, after?: string): Promise<string[]> {
    const order = (a: Run, b: Run) =>
      a.createdAt.getTime() - b.createdAt.getTime() || byCodeUnit(a.id, b.id);
    const cursor = after === undefined ? undefined : this.runs.get(after);
    if (after !== undefined && !cursor) return [];
    return [...this.runs.values()]
      .filter((r) => r.status === 'pending' || r.status === 'running')
      .filter((r) => !cursor || order(r, cursor) > 0)
      .sort(order)
      .slice(0, Math.max(0, limit))
      .map((r) => r.id);
  }

  async listRuns(filter: {
    tenantId: string;
    jobKey?: string;
    status?: RunStatus;
    subject?: RunSubject;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<Run[]> {
    const { before, subject } = filter;
    // Newest first by createdAt, then id, so a cursor of (createdAt, id) continues exactly where a page ended.
    const newer = (a: Run, b: { createdAt: Date; id: string }) =>
      a.createdAt.getTime() - b.createdAt.getTime() || byCodeUnit(a.id, b.id);
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.tenantId === filter.tenantId &&
          (!filter.jobKey || r.jobKey === filter.jobKey) &&
          (!filter.status || r.status === filter.status) &&
          (!subject ||
            (r.subject?.kind === subject.kind &&
              r.subject.id === subject.id)) &&
          (!before || newer(r, before) < 0),
      )
      .sort((a, b) => newer(b, a))
      .slice(0, Math.max(0, filter.limit))
      .map((r) => structuredClone(r));
  }

  async transition(
    runId: string,
    t: RunTransition,
  ): Promise<{ changed: boolean; run: Run; cascaded: Run[] }> {
    const run = this.run(runId);
    if (!canTransition(run.status, t))
      return { changed: false, run: structuredClone(run), cascaded: [] };
    const at = this.now().toISOString();
    this.commit({
      op: 'status',
      runId,
      to: t.to,
      reason: t.to === 'paused' ? t.reason : null,
      error: t.to === 'failed' ? t.error : null,
      budget:
        t.to === 'running' && t.from === 'paused' && t.budget
          ? toWireBudget(t.budget)
          : null,
      at,
    });
    const cascaded: Run[] = [];
    const cascade = (
      want: (r: Run) => boolean,
      to: RunStatus,
      reason: Run['pauseReason'],
    ) => {
      for (const d of this.descendants(runId))
        if (want(d)) {
          this.commit({
            op: 'status',
            runId: d.id,
            to,
            reason,
            error: null,
            budget: null,
            at,
          });
          cascaded.push(structuredClone(this.run(d.id)));
        }
    };
    if (TERMINAL_RUN.includes(t.to)) {
      cascade((d) => ACTIVE_RUN.includes(d.status), 'canceled', null);
      this.pokeParent(run);
    } else if (t.to === 'paused')
      cascade(
        (d) => ['pending', 'running', 'waiting'].includes(d.status),
        'paused',
        'parent',
      );
    else if (t.to === 'running' && t.from === 'paused')
      cascade(
        (d) => d.status === 'paused' && d.pauseReason === 'parent',
        'running',
        null,
      );
    return { changed: true, run: structuredClone(this.run(runId)), cascaded };
  }

  /** Every run below `runId`, nearest first. */
  private descendants(runId: string): Run[] {
    const out: Run[] = [];
    let level = [runId];
    while (level.length) {
      const next = [...this.runs.values()].filter(
        (r) => r.parentRunId !== null && level.includes(r.parentRunId),
      );
      out.push(...next);
      level = next.map((r) => r.id);
    }
    return out;
  }

  /** A child ended: its parent's step, if waiting on it, is due now. */
  private pokeParent(child: Run): void {
    if (!child.parentRunId || !child.parentStep) return;
    const step = this.steps.get(child.parentRunId)?.get(child.parentStep);
    if (step?.state.status === 'waiting')
      this.commit({
        op: 'wake',
        steps: [{ runId: child.parentRunId, name: child.parentStep }],
        at: this.now().toISOString(),
      });
  }

  async reserve(claim: ChunkClaim, estimateUsd: number): Promise<Reservation> {
    const { runId } = claim;
    const run = this.run(runId);
    if (run.status !== 'running') return 'refused';
    // A stale claim reserves nothing: its chunk is another claim's now.
    if (!this.holds(claim)) return 'refused';
    const reason = budgetStop(
      run.budget,
      run.spend,
      { usd: run.reservedUsd, calls: this.reservedCalls.get(runId) ?? 0 },
      { usd: estimateUsd, calls: 1 },
      this.now(),
    );
    if (reason) {
      const { changed } = await this.transition(runId, {
        to: 'paused',
        reason,
      });
      return changed ? 'paused' : 'refused';
    }
    this.commit({
      op: 'reserve',
      runId,
      step: claim.step,
      index: claim.index,
      usd: estimateUsd,
    });
    return 'ok';
  }

  async releaseReservation(
    claim: ChunkClaim,
    estimateUsd: number,
  ): Promise<void> {
    this.run(claim.runId);
    // A stale claim's reservations went with its chunk's sweep: nothing of its own is left to return.
    if (!this.holds(claim)) return;
    this.commit({
      op: 'unreserve',
      runId: claim.runId,
      step: claim.step,
      index: claim.index,
      usd: estimateUsd,
    });
  }

  async progress(runId: string): Promise<RunProgress> {
    const run = this.run(runId);
    const chunks = zeroChunks();
    for (const [key, list] of this.chunkLists)
      if (key.startsWith(`${runId}\u0000`))
        for (const c of list) chunks[c.status]++;
    return {
      run: structuredClone(run),
      steps: await this.stepStates(runId),
      chunks,
    };
  }

  // ── steps ─────────────────────────────────────────────────────────────────

  async stepStates(runId: string): Promise<StepState[]> {
    this.run(runId);
    return [...(this.steps.get(runId)?.values() ?? [])]
      .map((r) => this.stepView(runId, r))
      .sort((a, b) => a.index - b.index);
  }

  async startStep(
    runId: string,
    step: { name: string; index: number; kind: 'step' | 'map' },
    expect: { attempts: number },
  ): Promise<StepState | null> {
    this.run(runId);
    const existing = this.steps.get(runId)?.get(step.name)?.state;
    if (
      (existing?.attempts ?? 0) !== expect.attempts ||
      (existing && ENDED_STEP.includes(existing.status))
    )
      return null;
    this.commit({
      op: 'step-start',
      runId,
      ...step,
      at: this.now().toISOString(),
    });
    return this.stepView(runId, this.stepRecord(runId, step.name));
  }

  async recordStep(
    runId: string,
    name: string,
    record: {
      status: 'completed' | 'skipped';
      output?: unknown;
      speculation?: Speculation;
    },
  ): Promise<void> {
    this.stepRecord(runId, name);
    this.refuseValue('a step output', record.output);
    this.commit({
      op: 'step-record',
      runId,
      name,
      status: record.status,
      output: record.output,
      speculation: record.speculation ?? null,
      at: this.now().toISOString(),
    });
  }

  async failStep(runId: string, name: string, error: RunError): Promise<void> {
    this.stepRecord(runId, name);
    this.commit({
      op: 'step-fail',
      runId,
      name,
      error,
      at: this.now().toISOString(),
    });
  }

  async runInput(runId: string): Promise<unknown> {
    this.run(runId);
    return structuredClone(this.inputs.get(runId));
  }

  async stepOutput(runId: string, name: string): Promise<unknown> {
    const record = this.steps.get(runId)?.get(name);
    return record ? structuredClone(record.output) : undefined;
  }

  async park(
    runId: string,
    step: { name: string; index: number; kind: StepState['kind'] },
    wait: {
      kind: WaitKind;
      name: string;
      wakeAt: Date | null;
      returnAttempt?: boolean;
    },
  ): Promise<boolean> {
    const run = this.run(runId);
    if (run.status !== 'running' && run.status !== 'waiting') return false;
    const existing = this.steps.get(runId)?.get(step.name);
    if (
      existing &&
      !['pending', 'running', 'waiting'].includes(existing.state.status)
    )
      return false;
    this.commit({
      op: 'park',
      runId,
      ...step,
      waitKind: wait.kind,
      waitName: wait.name,
      wakeAt: wait.wakeAt?.toISOString() ?? null,
      returnAttempt: wait.returnAttempt ?? false,
      at: this.now().toISOString(),
    });
    return true;
  }

  async unpark(runId: string, name: string): Promise<boolean> {
    this.run(runId);
    if (this.steps.get(runId)?.get(name)?.state.status !== 'waiting')
      return false;
    this.commit({ op: 'unpark', runId, name });
    return true;
  }

  async startChildren(
    parent: { runId: string; step: string; index: number },
    children: readonly NewChild[],
  ): Promise<{ slots: Slot[]; started: Slot[] }> {
    const run = this.run(parent.runId);
    if (run.depth + 1 > MAX_DEPTH)
      throw new JobDefinitionError(
        `${run.jobKey}/${parent.step}: runs nest at most ${MAX_DEPTH} deep`,
      );
    if (children.length > MAX_CHILDREN)
      throw new JobDefinitionError(
        `${run.jobKey}/${parent.step}: a step starts at most ${MAX_CHILDREN} children`,
      );
    const have = new Set(
      (this.stepItems.get(stepKey(parent.runId, parent.step)) ?? []).map(
        (i) => i.key,
      ),
    );
    const fresh: { key: string; childRunId: string }[] = [];
    for (const child of children) {
      if (have.has(child.key)) continue;
      have.add(child.key);
      this.refuseValue('a child run input', child.input);
      fresh.push({
        key: child.key,
        childRunId: this.createChild(run, parent.step, child),
      });
    }
    this.commit({
      op: 'slots',
      runId: parent.runId,
      step: parent.step,
      index: parent.index,
      slots: fresh,
      at: this.now().toISOString(),
    });
    const slots = this.slotsOf(parent.runId, parent.step);
    const started = new Set(fresh.map((f) => f.key));
    return { slots, started: slots.filter((x) => started.has(x.key)) };
  }

  /** A child run in a slot: pending, inheriting from its parent. */
  private createChild(parent: Run, step: string, child: NewChild): string {
    const id = randomUUID();
    this.commit({
      op: 'create',
      id,
      at: this.now().toISOString(),
      run: {
        jobKey: child.jobKey,
        jobVersion: child.jobVersion,
        input: child.input,
        tenantId: parent.tenantId,
        trigger: parent.trigger,
        requestedBy: parent.requestedBy,
        dryRun: parent.dryRun,
        cache: parent.cache,
        budget: toWireBudget(child.budget),
        parent: {
          runId: parent.id,
          step,
          key: child.key,
          depth: parent.depth + 1,
        },
      },
    });
    return id;
  }

  private slotsOf(runId: string, step: string): Slot[] {
    return (this.stepItems.get(stepKey(runId, step)) ?? []).map((i) => ({
      key: i.key,
      childRunId: i.ref,
      ordinal: i.ordinal,
      status: i.status === 'done' || i.status === 'cached' ? 'done' : i.status,
      attempts: i.attempts,
      errorType: i.errorType,
    }));
  }

  async settleSlots(
    runId: string,
    step: string,
  ): Promise<{ slots: Slot[]; ended: Slot[] }> {
    this.run(runId);
    const ended: string[] = [];
    for (const slot of this.slotsOf(runId, step)) {
      if (slot.status !== 'pending') continue;
      const child = this.runs.get(slot.childRunId);
      if (!child || !TERMINAL_RUN.includes(child.status)) continue;
      this.commit({
        op: 'slot',
        runId,
        step,
        key: slot.key,
        status: child.status === 'completed' ? 'done' : 'failed',
        errorType: slotErrorOf(child),
      });
      ended.push(slot.key);
    }
    const slots = this.slotsOf(runId, step);
    return { slots, ended: slots.filter((x) => ended.includes(x.key)) };
  }

  async retryChild(
    runId: string,
    step: string,
    key: string,
    child: NewChild,
  ): Promise<Slot | null> {
    const run = this.run(runId);
    const slot = this.slotsOf(runId, step).find((x) => x.key === key);
    if (slot?.status !== 'failed') return null;
    this.refuseValue('a child run input', child.input);
    const childRunId = this.createChild(run, step, child);
    this.commit({
      op: 'slot',
      runId,
      step,
      key,
      status: 'pending',
      errorType: null,
      childRunId,
    });
    return this.slotsOf(runId, step).find((x) => x.key === key) ?? null;
  }

  async skipChild(
    runId: string,
    step: string,
    key: string,
  ): Promise<Slot | null> {
    this.run(runId);
    const slot = this.slotsOf(runId, step).find((x) => x.key === key);
    if (slot?.status !== 'failed') return null;
    this.commit({
      op: 'slot',
      runId,
      step,
      key,
      status: 'skipped',
      errorType: slot.errorType,
    });
    if (this.steps.get(runId)?.get(step)?.state.status === 'waiting')
      this.commit({
        op: 'wake',
        steps: [{ runId, name: step }],
        at: this.now().toISOString(),
      });
    return this.slotsOf(runId, step).find((x) => x.key === key) ?? null;
  }

  async treeSpend(runId: string): Promise<Spend> {
    const total = zeroSpend();
    for (const r of [this.run(runId), ...this.descendants(runId)]) {
      total.calls += r.spend.calls;
      total.inputTokens += r.spend.inputTokens;
      total.costUsd += r.spend.costUsd;
    }
    return total;
  }

  async settleWait(
    runId: string,
    name: string,
    settle: { signal: string; output: unknown; by: string | null },
  ): Promise<boolean> {
    this.run(runId);
    const state = this.steps.get(runId)?.get(name)?.state;
    if (
      state?.status !== 'waiting' ||
      state.wait?.kind !== 'signal' ||
      state.wait.name !== settle.signal
    )
      return false;
    this.refuseValue('a signal value', settle.output);
    this.commit({
      op: 'signal',
      runId,
      name,
      output: settle.output,
      by: settle.by,
      at: this.now().toISOString(),
    });
    return true;
  }

  async dueRunIds(now: Date, limit: number, after?: string): Promise<string[]> {
    const order = (a: Run, b: Run) =>
      a.createdAt.getTime() - b.createdAt.getTime() || byCodeUnit(a.id, b.id);
    const cursor = after === undefined ? undefined : this.runs.get(after);
    if (after !== undefined && !cursor) return [];
    const due = (run: Run) =>
      [...(this.steps.get(run.id)?.values() ?? [])].some(
        (r) =>
          r.state.status === 'waiting' &&
          r.state.wait?.wakeAt != null &&
          r.state.wait.wakeAt <= now,
      );
    return [...this.runs.values()]
      .filter((r) => r.status === 'waiting' && due(r))
      .filter((r) => !cursor || order(r, cursor) > 0)
      .sort(order)
      .slice(0, Math.max(0, limit))
      .map((r) => r.id);
  }

  async wakeGate(tenantId: string, name: string): Promise<string[]> {
    const steps: { runId: string; name: string }[] = [];
    for (const run of this.runs.values()) {
      if (run.tenantId !== tenantId) continue;
      for (const r of this.steps.get(run.id)?.values() ?? [])
        if (
          r.state.status === 'waiting' &&
          r.state.wait?.kind === 'gate' &&
          r.state.wait.name === name
        )
          steps.push({ runId: run.id, name: r.state.name });
    }
    if (steps.length)
      this.commit({ op: 'wake', steps, at: this.now().toISOString() });
    return [
      ...new Set(
        steps
          .map((x) => x.runId)
          .filter((id) => this.run(id).status === 'waiting'),
      ),
    ];
  }

  async stopStep(runId: string, name: string, used: number): Promise<void> {
    this.stepRecord(runId, name);
    this.commit({
      op: 'step-stop',
      runId,
      name,
      used,
      at: this.now().toISOString(),
    });
  }

  // ── items ─────────────────────────────────────────────────────────────────

  async planItems(
    runId: string,
    step: string,
    page: { refs: ItemRef[]; keys: string[]; next: string | null },
  ): Promise<void> {
    const run = this.run(runId);
    const record = this.stepRecord(runId, step);
    if (page.refs.length !== page.keys.length)
      throw new Error('a page needs one key per ref');
    if (record.state.planned || !ACTIVE_RUN.includes(run.status)) return;
    const total = record.state.counts.total;
    const room = Math.max(0, run.budget.maxItems - total);
    const known = this.itemKeys.get(stepKey(runId, step)) ?? new Map();
    const refs: ItemRef[] = [];
    const keys: string[] = [];
    const seen = new Map<string, ItemRef>();
    page.refs.forEach((ref, i) => {
      const key = page.keys[i] as string;
      // One key, two refs: an author's bug that would drop a ref from the output. Refuse it.
      const other = known.get(key)?.ref ?? seen.get(key);
      if (other !== undefined && other !== ref)
        throw new JobDefinitionError(
          `${run.jobKey}/${step}: key ${key} is shared by two items`,
        );
      if (refs.length >= room || other !== undefined) return;
      seen.set(key, ref);
      refs.push(ref);
      keys.push(key);
    });
    const planned =
      page.next === null || total + refs.length >= run.budget.maxItems;
    this.commit({
      op: 'page',
      runId,
      step,
      refs,
      keys,
      next: page.next,
      planned,
      at: this.now().toISOString(),
    });
  }

  async items(
    runId: string,
    step: string,
    range: ItemRange = {},
  ): Promise<Item[]> {
    this.run(runId);
    // Items sit in ordinal order, ordinals 0…n−1: a range is a slice.
    const all = this.stepItems.get(stepKey(runId, step)) ?? [];
    const from = Math.max(0, range.from ?? 0);
    const to =
      range.limit === undefined ? all.length : from + Math.max(0, range.limit);
    return structuredClone(all.slice(from, to));
  }

  async pendingItems(claim: ChunkClaim): Promise<Item[]> {
    return structuredClone(
      (this.stepItems.get(stepKey(claim.runId, claim.step)) ?? []).filter(
        (i) => i.chunkIndex === claim.index && i.status === 'pending',
      ),
    );
  }

  async itemResults<R>(
    scope: string,
    tenantId: string,
    keys: string[],
  ): Promise<Map<string, ItemResult<R>>> {
    if (!this.keepsValues)
      throw new Error(
        'this store keeps no values: read results from the recorder',
      );
    const out = new Map<string, ItemResult<R>>();
    for (const key of keys) {
      const hit = this.stored.get(resultKey(tenantId, scope, key));
      if (hit) out.set(key, structuredClone(hit) as ItemResult<R>);
    }
    return out;
  }

  // ── chunks ────────────────────────────────────────────────────────────────

  async claimChunk(
    owner: string,
    ttlMs: number,
    chunk?: { runId: string; step: string; index: number },
  ): Promise<ChunkClaim | null> {
    if (!chunk) return (await this.claimChunks(owner, 1, ttlMs))[0] ?? null;
    const now = this.now();
    const c = this.chunkLists.get(stepKey(chunk.runId, chunk.step))?.[
      chunk.index
    ];
    if (
      c?.status !== 'pending' ||
      c.runAt > now ||
      this.runs.get(chunk.runId)?.status !== 'running'
    )
      return null;
    return this.claimAll(owner, ttlMs, [c])[0] ?? null;
  }

  /** Claims chunks, each under a fresh token. */
  private claimAll(
    owner: string,
    ttlMs: number,
    picked: readonly Chunk[],
  ): ChunkClaim[] {
    if (!picked.length) return [];
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const chunks = picked.map((c) => ({
      runId: c.runId,
      step: c.step,
      index: c.index,
      token: randomUUID(),
    }));
    this.commit({
      op: 'claim',
      owner,
      chunks,
      expiresAt: expiresAt.toISOString(),
      at: now.toISOString(),
    });
    return chunks.map((c) => ({
      ...c,
      owner,
      expiresAt,
      attempts: this.chunk(c).attempts,
    }));
  }

  async chunks(runId: string): Promise<Chunk[]> {
    this.run(runId);
    const order = new Map(
      [...(this.steps.get(runId)?.values() ?? [])].map((r) => [
        r.state.name,
        r.state.index,
      ]),
    );
    return [...this.chunkLists.entries()]
      .filter(([key]) => key.startsWith(`${runId}\u0000`))
      .flatMap(([, list]) => list)
      .sort(
        (a, b) =>
          (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0) ||
          a.index - b.index,
      )
      .map((c) => structuredClone(c));
  }

  async pendingChunks(runId: string, limit: number): Promise<Chunk[]> {
    return (await this.chunks(runId))
      .filter((c) => c.status === 'pending')
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, Math.max(0, Math.floor(limit)));
  }

  async claimChunks(
    owner: string,
    limit: number,
    ttlMs: number,
    jobKeys?: readonly string[],
  ): Promise<ChunkClaim[]> {
    if (limit <= 0) return [];
    const now = this.now();
    const picked = [...this.chunkLists.values()]
      .flat()
      .filter((c) => {
        const run = this.run(c.runId);
        return (
          c.status === 'pending' &&
          c.runAt <= now &&
          run.status === 'running' &&
          (jobKeys === undefined || jobKeys.includes(run.jobKey))
        );
      })
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, limit);
    return this.claimAll(owner, ttlMs, picked);
  }

  async renewClaim(
    owner: string,
    claims: ChunkClaim[],
    ttlMs: number,
  ): Promise<RenewReport> {
    // Each claim by its token: a stale claim of the same owner is lost, not renewed.
    const kept = claims.filter((l) => l.owner === owner && this.holds(l));
    const lost = claims.filter((l) => !kept.includes(l));
    const expiresAt = new Date(this.now().getTime() + ttlMs);
    if (kept.length)
      this.commit({
        op: 'renew',
        owner,
        chunks: kept.map((l) => ({
          runId: l.runId,
          step: l.step,
          index: l.index,
        })),
        expiresAt: expiresAt.toISOString(),
      });
    for (const l of kept) l.expiresAt = expiresAt;
    const runs: Record<string, RunStatus> = {};
    for (const l of claims) runs[l.runId] = this.run(l.runId).status;
    return { lost, runs };
  }

  async writeResults<R>(
    claim: ChunkClaim,
    batch: {
      done?: Done<R>[];
      cached?: string[];
      failed?: Failed[];
      scope?: string;
    },
    spend: Spend,
    reservation?: { reservedUsd: number },
  ): Promise<void> {
    const run = this.run(claim.runId);
    const scope = batch.scope ?? resultScope(run.jobKey, claim.step);
    const at = this.now().toISOString();
    // Results land even from a lost claim: the first write wins, so a late write can't change a result. A refresh run
    // replaces a stored answer with its own, only while its claim holds.
    const replace = run.cache === 'refresh' && this.holds(claim);
    for (const d of batch.done ?? []) {
      this.refuseValue('an item result', d.result);
      if (d.result === undefined) continue;
      if (
        !replace &&
        this.stored.has(resultKey(run.tenantId, scope, d.key))
      )
        continue;
      const wire: WireResult = {
        tenantId: run.tenantId,
        scope,
        key: d.key,
        ref: d.ref,
        result: d.result,
        runId: run.id,
        createdAt: at,
        ...(replace ? { replace: true as const } : {}),
      };
      this.persistResult(wire);
      this.applyResult(wire);
    }
    // Spend lands unfenced too: what a call cost is a fact about money, never about the claim.
    this.recordSpend(claim, spend);
    if (!this.holds(claim)) throw new ClaimLostError(claim);
    this.commit({
      op: 'record',
      runId: claim.runId,
      step: claim.step,
      index: claim.index,
      done: (batch.done ?? []).map((d) => d.key),
      cached: batch.cached ?? [],
      failed: batch.failed ?? [],
      reservedUsd: reservation?.reservedUsd ?? null,
    });
  }

  async addSpend(claim: ChunkClaim, spend: Spend): Promise<void> {
    this.recordSpend(claim, spend);
  }

  private recordSpend(claim: ChunkClaim, spend: Spend): void {
    this.run(claim.runId);
    if (!spend.calls && !spend.inputTokens && !spend.costUsd) return;
    this.commit({
      op: 'spend',
      runId: claim.runId,
      step: claim.step,
      index: claim.index,
      spend,
    });
  }

  async releaseChunk(claim: ChunkClaim, outcome: SettleOutcome): Promise<void> {
    if (!this.holds(claim)) throw new ClaimLostError(claim);
    this.commit({
      op: 'settle',
      runId: claim.runId,
      step: claim.step,
      index: claim.index,
      outcome:
        outcome.kind === 'retry'
          ? { ...outcome, at: outcome.at.toISOString() }
          : outcome,
      at: this.now().toISOString(),
    });
  }

  async sweepExpired(): Promise<number> {
    const now = this.now();
    const expired = [...this.chunkLists.values()]
      .flat()
      .filter(
        (c) => c.status === 'running' && c.claim && c.claim.expiresAt <= now,
      );
    if (expired.length)
      this.commit({
        op: 'sweep',
        chunks: expired.map((c) => ({
          runId: c.runId,
          step: c.step,
          index: c.index,
        })),
        at: now.toISOString(),
      });
    return expired.length;
  }

  // ── the pure steps ────────────────────────────────────────────────────────

  protected applyResult(wire: WireResult): void {
    const key = resultKey(wire.tenantId, wire.scope, wire.key);
    if (this.stored.has(key) && !wire.replace) return;
    const { replace: _, ...result } = wire;
    this.stored.set(key, { ...result, createdAt: new Date(wire.createdAt) });
  }

  private cancelOpenChunks(chunks: readonly Chunk[]): void {
    for (const c of chunks)
      if (c.status === 'pending' || c.status === 'running') {
        c.status = 'canceled';
        c.claim = null;
        this.dropReservations(c);
      }
  }

  /**
   * Moves one chunk's outstanding reservation by `usd` and `calls` (never below zero), then recomputes its run's
   * totals from its chunks', so no rounding drifts in.
   */
  private adjustReservation(ref: ChunkRef, usd: number, calls: number): void {
    const prefix = `${stepKey(ref.runId, ref.step)}\u0000`;
    const key = `${prefix}${ref.index}`;
    const held = this.reservations.get(key) ?? { usd: 0, calls: 0 };
    const next = {
      usd: held.usd + usd > 1e-12 ? held.usd + usd : 0,
      calls: Math.max(0, held.calls + calls),
    };
    if (next.usd === 0 && next.calls === 0) this.reservations.delete(key);
    else this.reservations.set(key, next);
    let totalUsd = 0;
    let totalCalls = 0;
    for (const [k, r] of this.reservations)
      if (k.startsWith(`${ref.runId}\u0000`)) {
        totalUsd += r.usd;
        totalCalls += r.calls;
      }
    this.run(ref.runId).reservedUsd = totalUsd;
    this.reservedCalls.set(ref.runId, totalCalls);
  }

  /** A chunk that settles, is swept or is canceled holds no reservation any more. */
  private dropReservations(ref: ChunkRef): void {
    const key = `${stepKey(ref.runId, ref.step)}\u0000${ref.index}`;
    const held = this.reservations.get(key);
    if (held) this.adjustReservation(ref, -held.usd, -held.calls);
  }

  protected apply(op: Op): void {
    switch (op.op) {
      case 'create':
        this.applyCreate(op);
        break;
      case 'status':
        this.applyStatus(op);
        break;
      case 'reserve':
        this.adjustReservation(op, op.usd, 1);
        break;
      case 'unreserve':
        this.adjustReservation(op, -op.usd, -1);
        break;
      case 'step-start':
        this.applyStepStart(op);
        break;
      case 'step-record':
        this.applyStepRecord(op);
        break;
      case 'step-fail':
        this.applyStepFail(op);
        break;
      case 'step-stop':
        this.applyStepStop(op);
        break;
      case 'park':
        this.applyPark(op);
        break;
      case 'unpark':
        this.applyUnpark(op);
        break;
      case 'signal':
        this.applySignal(op);
        break;
      case 'slots':
        this.applySlots(op);
        break;
      case 'slot':
        this.applySlot(op);
        break;
      case 'wake':
        this.applyWake(op);
        break;
      case 'page':
        this.applyPage(op);
        break;
      case 'claim':
        this.applyClaim(op);
        break;
      case 'renew':
        this.applyRenew(op);
        break;
      case 'record':
        this.applyRecord(op);
        break;
      case 'spend':
        this.applySpend(op);
        break;
      case 'settle':
        this.applySettle(op);
        break;
      case 'sweep':
        this.applySweep(op);
        break;
      default:
        // A durable store replays a log, and an op this code doesn't know (a log written by other code) changes nothing.
        break;
    }
  }

  // ── ops, one handler each ────────────────────────────────────────────────

  private applyCreate(op: OpOf<'create'>): void {
    const { run: req } = op;
    this.runs.set(op.id, {
      id: op.id,
      jobKey: req.jobKey,
      jobVersion: req.jobVersion,
      tenantId: req.tenantId,
      dryRun: req.dryRun ?? false,
      status: req.queued ? 'queued' : 'pending',
      pauseReason: null,
      trigger: req.trigger,
      requestedBy: req.requestedBy,
      chunkSize: req.chunkSize ?? 1000,
      chunkConcurrency: req.chunkConcurrency ?? null,
      budget: fromWireBudget(req.budget),
      cache: req.cache ?? 'read-write',
      dedupeKey: req.dedupeKey ?? null,
      subject: req.subject ? { ...req.subject } : null,
      spend: zeroSpend(),
      reservedUsd: 0,
      error: null,
      parentRunId: req.parent?.runId ?? null,
      parentStep: req.parent?.step ?? null,
      childKey: req.parent?.key ?? null,
      depth: req.parent?.depth ?? 0,
      createdAt: new Date(op.at),
      startedAt: null,
      completedAt: null,
    });
    if (req.input !== undefined)
      this.inputs.set(op.id, structuredClone(req.input));
    this.steps.set(op.id, new Map());
  }

  private applyStatus(op: OpOf<'status'>): void {
    const run = this.run(op.runId);
    const at = new Date(op.at);
    run.status = op.to;
    run.pauseReason = op.reason;
    if (op.budget) run.budget = fromWireBudget(op.budget);
    if (op.error) run.error = op.error;
    if (op.to === 'running' && !run.startedAt) run.startedAt = at;
    if (!TERMINAL_RUN.includes(op.to)) return;
    run.completedAt = at;
    for (const [key, list] of this.chunkLists)
      if (key.startsWith(`${op.runId}\u0000`)) this.cancelOpenChunks(list);
    this.promoteQueued(run);
  }

  /** The run ahead on a dedupe key ended: the oldest run queued behind it is pending now, when none is open. */
  private promoteQueued(ended: Run): void {
    if (!ended.dedupeKey) return;
    const onKey = (r: Run) =>
      r.tenantId === ended.tenantId &&
      r.jobKey === ended.jobKey &&
      r.dryRun === ended.dryRun &&
      r.dedupeKey === ended.dedupeKey;
    const runs = [...this.runs.values()].filter(onKey);
    if (runs.some((r) => ACTIVE_RUN.includes(r.status))) return;
    const next = runs
      .filter((r) => r.status === 'queued')
      // Map order is creation order, so a tie in one millisecond keeps it.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (next) next.status = 'pending';
  }

  /** The run's step rows, made on first use. */
  private stepsOf(runId: string): Map<string, StepRecord> {
    const steps = this.steps.get(runId) ?? new Map<string, StepRecord>();
    this.steps.set(runId, steps);
    return steps;
  }

  /** A step's first row; one with items also gets its empty chunk and item lists. */
  private addStep(
    runId: string,
    state: Pick<
      StepState,
      | 'name'
      | 'index'
      | 'kind'
      | 'status'
      | 'attempts'
      | 'planned'
      | 'startedAt'
    >,
    withItems: boolean,
  ): StepRecord {
    const record: StepRecord = {
      state: {
        runId,
        ...state,
        counts: zeroCounts(),
        sourceCursor: null,
        speculation: null,
        wait: null,
        settledBy: null,
        error: null,
        completedAt: null,
      },
      output: undefined,
    };
    this.stepsOf(runId).set(state.name, record);
    if (withItems) {
      const key = stepKey(runId, state.name);
      this.chunkLists.set(key, []);
      this.stepItems.set(key, []);
      this.itemKeys.set(key, new Map());
    }
    return record;
  }

  private applyStepStart(op: OpOf<'step-start'>): void {
    const existing = this.stepsOf(op.runId).get(op.name);
    if (!existing) {
      this.addStep(
        op.runId,
        {
          name: op.name,
          index: op.index,
          kind: op.kind,
          status: 'running',
          attempts: 1,
          planned: false,
          startedAt: new Date(op.at),
        },
        op.kind === 'map',
      );
      return;
    }
    existing.state.status = 'running';
    existing.state.attempts++;
    existing.state.error = null;
  }

  private applyStepRecord(op: OpOf<'step-record'>): void {
    const record = this.stepRecord(op.runId, op.name);
    record.state.status = op.status;
    record.state.speculation = op.speculation;
    record.state.completedAt = new Date(op.at);
    record.output = structuredClone(op.output);
  }

  private applyStepFail(op: OpOf<'step-fail'>): void {
    const record = this.stepRecord(op.runId, op.name);
    record.state.status = 'failed';
    record.state.error = op.error;
    record.state.completedAt = new Date(op.at);
  }

  private applyStepStop(op: OpOf<'step-stop'>): void {
    const record = this.stepRecord(op.runId, op.name);
    const key = stepKey(op.runId, op.name);
    // Nothing past a stop is ever planned.
    record.state.planned = true;
    for (const item of this.stepItems.get(key) ?? [])
      if (item.ordinal >= op.used && item.status === 'pending') {
        item.status = 'skipped';
        record.state.counts.skipped++;
      }
    this.cancelOpenChunks(this.chunkLists.get(key) ?? []);
  }

  private applyPark(op: OpOf<'park'>): void {
    const run = this.run(op.runId);
    const at = new Date(op.at);
    // A step parked before it ever ran gets its row, with no attempt spent.
    const record =
      this.stepsOf(op.runId).get(op.name) ??
      this.addStep(
        op.runId,
        {
          name: op.name,
          index: op.index,
          kind: op.kind,
          status: 'waiting',
          attempts: 0,
          planned: false,
          startedAt: null,
        },
        op.kind === 'map',
      );
    const prior = record.state.wait;
    const same =
      record.state.status === 'waiting' &&
      prior?.kind === op.waitKind &&
      prior.name === op.waitName;
    record.state.status = 'waiting';
    if (op.returnAttempt)
      record.state.attempts = Math.max(0, record.state.attempts - 1);
    record.state.wait = {
      kind: op.waitKind,
      name: op.waitName,
      since: same && prior ? prior.since : at,
      wakeAt: op.wakeAt === null ? null : new Date(op.wakeAt),
    };
    if (run.status === 'running') run.status = 'waiting';
  }

  /** A woken or settled wait no longer has a wake time, and its waiting run runs again. */
  private endWait(runId: string, record: StepRecord): void {
    if (record.state.wait) record.state.wait.wakeAt = null;
    const run = this.run(runId);
    if (run.status === 'waiting') run.status = 'running';
  }

  private applyUnpark(op: OpOf<'unpark'>): void {
    const record = this.stepRecord(op.runId, op.name);
    record.state.status = 'running';
    this.endWait(op.runId, record);
  }

  private applySignal(op: OpOf<'signal'>): void {
    const record = this.stepRecord(op.runId, op.name);
    record.state.status = 'completed';
    record.state.settledBy = op.by;
    record.state.completedAt = new Date(op.at);
    record.output = structuredClone(op.output);
    this.endWait(op.runId, record);
  }

  private applySlots(op: OpOf<'slots'>): void {
    const key = stepKey(op.runId, op.step);
    const record =
      this.stepsOf(op.runId).get(op.step) ??
      this.addStep(
        op.runId,
        {
          name: op.step,
          index: op.index,
          kind: 'children',
          status: 'running',
          attempts: 1,
          planned: true,
          startedAt: new Date(op.at),
        },
        true,
      );
    const items = this.stepItems.get(key) ?? [];
    const keys = this.itemKeys.get(key) ?? new Map<string, Item>();
    for (const slot of op.slots) {
      if (keys.has(slot.key)) continue;
      const item: Item = {
        runId: op.runId,
        step: op.step,
        ordinal: items.length,
        chunkIndex: null,
        key: slot.key,
        ref: slot.childRunId,
        status: 'pending',
        attempts: 1,
        errorType: null,
      };
      items.push(item);
      keys.set(slot.key, item);
      record.state.counts.total++;
    }
  }

  private applySlot(op: OpOf<'slot'>): void {
    const record = this.stepRecord(op.runId, op.step);
    const item = this.itemKeys.get(stepKey(op.runId, op.step))?.get(op.key);
    if (!item) return;
    const counts = record.state.counts;
    const was = slotCount(item.status);
    if (was) counts[was]--;
    item.status = op.status;
    item.errorType = op.errorType;
    const now = slotCount(op.status);
    if (now) counts[now]++;
    if (op.childRunId) {
      item.ref = op.childRunId;
      item.attempts++;
    }
  }

  private applyWake(op: OpOf<'wake'>): void {
    for (const ref of op.steps) {
      const wait = this.stepRecord(ref.runId, ref.name).state.wait;
      if (wait) wait.wakeAt = new Date(op.at);
    }
  }

  private applyPage(op: OpOf<'page'>): void {
    const run = this.run(op.runId);
    const record = this.stepRecord(op.runId, op.step);
    const key = stepKey(op.runId, op.step);
    const items = this.stepItems.get(key) ?? [];
    const keys = this.itemKeys.get(key) ?? new Map<string, Item>();
    op.refs.forEach((ref, i) => {
      const itemKey = op.keys[i] as string;
      if (keys.has(itemKey)) return;
      const ordinal = items.length;
      const item: Item = {
        runId: op.runId,
        step: op.step,
        ordinal,
        chunkIndex: Math.floor(ordinal / run.chunkSize),
        key: itemKey,
        ref,
        status: 'pending',
        attempts: 0,
        errorType: null,
      };
      items.push(item);
      keys.set(itemKey, item);
    });
    record.state.counts.total = items.length;
    record.state.sourceCursor = op.next;
    record.state.planned = op.planned;
    this.fillChunks(op, run.chunkSize, items);
  }

  /** A chunk exists once enough items fill it, or once planning ends. */
  private fillChunks(
    op: OpOf<'page'>,
    chunkSize: number,
    items: readonly Item[],
  ): void {
    const chunks = this.chunkLists.get(stepKey(op.runId, op.step)) ?? [];
    const want = op.planned
      ? Math.ceil(items.length / chunkSize)
      : Math.floor(items.length / chunkSize);
    for (let index = chunks.length; index < want; index++) {
      const total = items.filter((x) => x.chunkIndex === index).length;
      chunks.push({
        runId: op.runId,
        step: op.step,
        index,
        status: 'pending',
        attempts: 0,
        runAt: new Date(op.at),
        claim: null,
        counts: { ...zeroCounts(), total },
        spend: zeroSpend(),
        lastError: null,
      });
    }
  }

  private applyClaim(op: OpOf<'claim'>): void {
    for (const ref of op.chunks) {
      const c = this.chunk(ref);
      c.status = 'running';
      c.claim = {
        owner: op.owner,
        token: ref.token,
        expiresAt: new Date(op.expiresAt),
      };
      c.attempts++;
    }
  }

  private applyRenew(op: OpOf<'renew'>): void {
    for (const ref of op.chunks) {
      const c = this.chunk(ref);
      if (c.claim) c.claim.expiresAt = new Date(op.expiresAt);
    }
  }

  private applyRecord(op: OpOf<'record'>): void {
    const step = this.stepRecord(op.runId, op.step).state;
    const c = this.chunk(op);
    const keys =
      this.itemKeys.get(stepKey(op.runId, op.step)) ?? new Map<string, Item>();
    const mark = (
      key: string,
      status: 'done' | 'cached' | 'failed',
      errorType: string | null,
    ) => {
      const item = keys.get(key);
      if (item?.status !== 'pending') return;
      item.status = status;
      item.errorType = errorType;
      if (status !== 'cached') item.attempts++;
      step.counts[status]++;
      c.counts[status]++;
    };
    for (const k of op.done) mark(k, 'done', null);
    for (const k of op.cached) mark(k, 'cached', null);
    for (const f of op.failed) mark(f.key, 'failed', f.errorType);
    // A call's write releases the estimate it reserved, never the actual spend.
    if (op.reservedUsd !== null)
      this.adjustReservation(op, -op.reservedUsd, -1);
  }

  private applySpend(op: OpOf<'spend'>): void {
    const run = this.run(op.runId);
    const c = this.chunk(op);
    for (const s of [run.spend, c.spend]) {
      s.calls += op.spend.calls;
      s.inputTokens += op.spend.inputTokens;
      s.costUsd += op.spend.costUsd;
    }
  }

  private applySettle(op: OpOf<'settle'>): void {
    const c = this.chunk(op);
    c.claim = null;
    this.dropReservations(op);
    const o = op.outcome;
    switch (o.kind) {
      case 'completed':
        c.status = 'completed';
        return;
      case 'yield':
        c.status = 'pending';
        c.attempts = Math.max(0, c.attempts - 1);
        c.runAt = new Date(op.at);
        return;
      case 'retry':
        c.status = 'pending';
        c.runAt = new Date(o.at);
        c.lastError = o.error;
        return;
      default:
        c.status = 'failed';
        c.lastError = o.error;
        this.failPendingItems(op, c, o.error);
    }
  }

  /** A failed chunk fails every item it still owed. */
  private failPendingItems(ref: ChunkRef, c: Chunk, error: RunError): void {
    const step = this.stepRecord(ref.runId, ref.step).state;
    for (const item of this.stepItems.get(stepKey(ref.runId, ref.step)) ?? [])
      if (item.chunkIndex === ref.index && item.status === 'pending') {
        item.status = 'failed';
        item.errorType = error.type;
        step.counts.failed++;
        c.counts.failed++;
      }
  }

  private applySweep(op: OpOf<'sweep'>): void {
    for (const ref of op.chunks) {
      const c = this.chunk(ref);
      c.status = 'pending';
      c.claim = null;
      this.dropReservations(c);
      c.runAt = new Date(op.at);
    }
  }
}
