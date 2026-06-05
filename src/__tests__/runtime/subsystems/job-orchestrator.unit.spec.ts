/**
 * MemoryJobOrchestrator unit tests (JOB-4).
 *
 * Exercises every Phase 1 behavioural parity contract row from `docs/specs/JOB-4.md`:
 *   1. claim / queue ordering
 *   2. collision modes (reject / replace / queue)
 *   3. step memoization
 *   4. cascade cancel (terminate / cancel / abandon)
 *   5. dedupe window
 *   6. replay modes (scratch / last_step / last_checkpoint)
 *
 * Services are constructed directly (no NestJS) — the shared `MemoryJobStore`
 * is reset in `beforeEach` so test isolation is explicit.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  JobHandlerBase,
  ParentClosePolicy,
  FN_KEY_SENTINEL,
  JobKeyFunctionUnavailableError,
  type JobContext,
  type JobHandlerMeta,
} from '../../../../runtime/subsystems/jobs/job-handler.base';
import { MemoryJobStore } from '../../../../runtime/subsystems/jobs/memory-job-store';
import { MemoryJobOrchestrator } from '../../../../runtime/subsystems/jobs/job-orchestrator.memory-backend';
import { MemoryJobStepService } from '../../../../runtime/subsystems/jobs/job-step-service.memory-backend';
import { JobCollisionError } from '../../../../runtime/subsystems/jobs/jobs-errors';

// ─── Shared test scaffolding ─────────────────────────────────────────────────

/** Minimal no-op handler — test harness for register-then-start paths. */
class NoopHandler extends JobHandlerBase<Record<string, unknown>, unknown> {
  async run(_ctx: JobContext<Record<string, unknown>>): Promise<unknown> {
    return {};
  }
}

/** Controllable handler: captures ctx.step invocations for memoization asserts. */
function makeStepHandler(calls: string[]) {
  class StepHandler extends JobHandlerBase<Record<string, unknown>, unknown> {
    async run(ctx: JobContext<Record<string, unknown>>): Promise<unknown> {
      const a = await ctx.step('a', async () => {
        calls.push('a');
        return { ran: 'a' };
      });
      const b = await ctx.step('b', async () => {
        calls.push('b');
        return { ran: 'b' };
      });
      return { a, b };
    }
  }
  return StepHandler;
}

/** Handler that fails exactly once on step 'b' — used for replay:last_step. */
function makeStepHandlerFailB(calls: string[], mutable: { failB: boolean }) {
  class FailingStepHandler extends JobHandlerBase<Record<string, unknown>, unknown> {
    async run(ctx: JobContext<Record<string, unknown>>): Promise<unknown> {
      await ctx.step('a', async () => {
        calls.push('a');
        return { ok: true };
      });
      await ctx.step('b', async () => {
        calls.push('b');
        if (mutable.failB) throw new Error('boom');
        return { ok: true };
      });
      return {};
    }
  }
  return FailingStepHandler;
}

function buildOrchestrator() {
  const store = new MemoryJobStore();
  const stepService = new MemoryJobStepService(store);
  // JOB-8: the third constructor arg is the multi-tenant flag. This test
  // suite exercises pre-multi-tenant behaviour; `false` keeps the previous
  // observable contract (tenant_id always written as null; no filter).
  const orchestrator = new MemoryJobOrchestrator(store, stepService, false);
  return { store, stepService, orchestrator };
}

// Poll repeatedly until a predicate passes or a tick budget is exhausted.
async function tickUntilTerminal(
  orchestrator: MemoryJobOrchestrator,
  pool: string,
  maxTicks = 20,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const claimed = await orchestrator.claimNext(pool);
    if (!claimed) return;
    await orchestrator.tick(claimed.id);
  }
}

// ─── Group 1 — claim / queue ordering ───────────────────────────────────────

describe('MemoryJobOrchestrator — claim / queue ordering (Group 1)', () => {
  let orchestrator: MemoryJobOrchestrator;
  let store: MemoryJobStore;

  beforeEach(() => {
    ({ orchestrator, store } = buildOrchestrator());
    orchestrator.registerHandler('t.group1', { pool: 'batch' }, NoopHandler);
    orchestrator.registerHandler('t.group1.alt', { pool: 'interactive' }, NoopHandler);
  });

  it('claimNext returns highest-priority run, tie-broken by earliest run_at', async () => {
    // Insert three pending runs then rewrite their priorities + run_at to
    // pin the ordering the test needs (start() normalises run_at to now()).
    const a = await orchestrator.start('t.group1', {});
    const b = await orchestrator.start('t.group1', {});
    const c = await orchestrator.start('t.group1', {});
    store.runs.set(a.id, { ...store.runs.get(a.id)!, priority: 10, runAt: new Date(Date.now() - 2000) });
    store.runs.set(b.id, { ...store.runs.get(b.id)!, priority: 5, runAt: new Date(Date.now() - 1000) });
    store.runs.set(c.id, { ...store.runs.get(c.id)!, priority: 10, runAt: new Date(Date.now() - 3000) });

    const claimed = await orchestrator.claimNext('batch');
    expect(claimed?.id).toBe(c.id); // priority 10, run_at -3000 is earliest
  });

  it('claimNext skips runs with run_at in the future', async () => {
    const a = await orchestrator.start('t.group1', {}, {
      runAt: new Date(Date.now() + 60_000),
    });
    expect(a.status).toBe('pending');
    const claimed = await orchestrator.claimNext('batch');
    expect(claimed).toBeNull();
  });

  it('claimNext isolates pools', async () => {
    const inBatch = await orchestrator.start('t.group1', {});
    const inInteractive = await orchestrator.start('t.group1.alt', {});

    // Only the 'batch' pool sees the batch run.
    const fromBatch = await orchestrator.claimNext('batch');
    expect(fromBatch?.id).toBe(inBatch.id);

    // 'interactive' pool still has its own run.
    const fromInteractive = await orchestrator.claimNext('interactive');
    expect(fromInteractive?.id).toBe(inInteractive.id);
  });
});

// ─── Group 2 — collision modes ──────────────────────────────────────────────

describe('MemoryJobOrchestrator — collision modes (Group 2)', () => {
  it('queue: second start returns a new pending run blocked until incumbent completes', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const meta: JobHandlerMeta<{ accountId: string }> = {
      pool: 'batch',
      concurrency: {
        key: '{{accountId}}',
        collisionMode: 'queue',
      } as unknown as JobHandlerMeta<{ accountId: string }>['concurrency'],
    };
    orchestrator.registerHandler('t.queue', meta, NoopHandler);

    const first = await orchestrator.start('t.queue', { accountId: '1' });
    // Simulate claim of the first run.
    const claimed = await orchestrator.claimNext('batch');
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe('running');

    const second = await orchestrator.start('t.queue', { accountId: '1' });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');

    // Second should NOT be claimable until first terminates.
    expect(await orchestrator.claimNext('batch')).toBeNull();

    // Complete first synthetically.
    store.runs.set(first.id, {
      ...store.runs.get(first.id)!,
      status: 'completed',
      finishedAt: new Date(),
    });
    // Orchestrator's public transitions advance dependents; call the cancel
    // path which internally unblocks (quickest accessor); alternative: we
    // could re-run start() trigger, but use tick path via direct store.
    // Trigger unblock by calling cancel on a non-existent id (no-op) — the
    // blocker map is cleared on real terminal transitions (tick / cancel).
    // For direct-store completion we manually reset runAt.
    const blocked = store.runs.get(second.id)!;
    store.runs.set(second.id, { ...blocked, runAt: new Date() });

    const after = await orchestrator.claimNext('batch');
    expect(after?.id).toBe(second.id);
  });

  it('reject: second start throws JobCollisionError', async () => {
    const { orchestrator } = buildOrchestrator();
    const meta = {
      pool: 'batch',
      concurrency: { key: '{{accountId}}', collisionMode: 'reject' as const },
    } as unknown as JobHandlerMeta<Record<string, unknown>>;
    orchestrator.registerHandler('t.reject', meta, NoopHandler);

    const first = await orchestrator.start('t.reject', { accountId: '1' });
    expect(first.status).toBe('pending');

    await expect(
      orchestrator.start('t.reject', { accountId: '1' }),
    ).rejects.toBeInstanceOf(JobCollisionError);
  });

  it('replace: second start cancels incumbent and inserts a new pending run', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const meta = {
      pool: 'batch',
      concurrency: { key: '{{accountId}}', collisionMode: 'replace' as const },
    } as unknown as JobHandlerMeta<Record<string, unknown>>;
    orchestrator.registerHandler('t.replace', meta, NoopHandler);

    const first = await orchestrator.start('t.replace', { accountId: '1' });
    const second = await orchestrator.start('t.replace', { accountId: '1' });

    expect(store.runs.get(first.id)?.status).toBe('canceled');
    expect(second.status).toBe('pending');

    const claimed = await orchestrator.claimNext('batch');
    expect(claimed?.id).toBe(second.id);
  });
});

// ─── Group 2b — function-form keys (JOB-FN-KEY, 0.16.2) ──────────────────────
//
// Regression guard for the swe-brain ADR-0009 Amendment B drain: a `@JobHandler`
// authored with `concurrency.key: (input) => …` (the typed function form) was
// silently dropped to `null` at registration, so `collisionMode` never engaged
// and three "shared-lane" runs ran fully concurrently. These assert the function
// key is honored end-to-end on the memory backend.

describe('MemoryJobOrchestrator — function-form keys (Group 2b)', () => {
  it('registration persists a function key as the FN_KEY_SENTINEL (non-null)', () => {
    const { orchestrator, store } = buildOrchestrator();
    const meta: JobHandlerMeta<{ channel: string; ts: string }> = {
      pool: 'batch',
      concurrency: {
        key: (input) => `lane:${input.channel}`,
        collisionMode: 'queue',
      },
    };
    orchestrator.registerHandler('t.fnkey.reg', meta, NoopHandler);

    // The def row stores the sentinel, NOT null — the pre-0.16.2 bug stored
    // null here, which is exactly why the collision path never fired.
    const def = store.jobs.get('t.fnkey.reg');
    expect(def?.concurrencyKeyTemplate).toBe(FN_KEY_SENTINEL);
  });

  it('queue: a function concurrency key serializes two same-lane starts', async () => {
    const { orchestrator } = buildOrchestrator();
    const meta: JobHandlerMeta<{ channel: string; ts: string }> = {
      pool: 'batch',
      // Function of input — the lane is the channel, NOT the per-message ts.
      // Two different messages on the same channel share a lane.
      concurrency: {
        key: (input) => `chan:${input.channel}`,
        collisionMode: 'queue',
      },
    };
    orchestrator.registerHandler('t.fnkey.queue', meta, NoopHandler);

    const first = await orchestrator.start('t.fnkey.queue', {
      channel: 'C1',
      ts: '100',
    });
    const claimed = await orchestrator.claimNext('batch');
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe('running');

    // Second message, same channel, DIFFERENT ts — without the fn key being
    // honored this would run concurrently (the bug). With it, same lane ⇒ queued.
    const second = await orchestrator.start('t.fnkey.queue', {
      channel: 'C1',
      ts: '200',
    });
    expect(second.status).toBe('pending');
    expect(second.concurrencyKey).toBe('chan:C1');
    expect(first.concurrencyKey).toBe('chan:C1');
    // Blocked: not claimable while the incumbent is in-flight.
    expect(await orchestrator.claimNext('batch')).toBeNull();
  });

  it('reject: a function concurrency key throws JobCollisionError on the same lane', async () => {
    const { orchestrator } = buildOrchestrator();
    const meta: JobHandlerMeta<{ channel: string }> = {
      pool: 'batch',
      concurrency: {
        key: (input) => `chan:${input.channel}`,
        collisionMode: 'reject',
      },
    };
    orchestrator.registerHandler('t.fnkey.reject', meta, NoopHandler);

    await orchestrator.start('t.fnkey.reject', { channel: 'C1' });
    await expect(
      orchestrator.start('t.fnkey.reject', { channel: 'C1' }),
    ).rejects.toBeInstanceOf(JobCollisionError);
  });

  it('different lanes from the same fn key do NOT collide', async () => {
    const { orchestrator } = buildOrchestrator();
    const meta: JobHandlerMeta<{ channel: string }> = {
      pool: 'batch',
      concurrency: {
        key: (input) => `chan:${input.channel}`,
        collisionMode: 'reject',
      },
    };
    orchestrator.registerHandler('t.fnkey.lanes', meta, NoopHandler);

    const a = await orchestrator.start('t.fnkey.lanes', { channel: 'C1' });
    const b = await orchestrator.start('t.fnkey.lanes', { channel: 'C2' });
    expect(a.concurrencyKey).toBe('chan:C1');
    expect(b.concurrencyKey).toBe('chan:C2');
    expect(b.status).toBe('pending');
  });

  it('dedupe: a function dedupe key collapses two same-key starts in-window', async () => {
    const { orchestrator } = buildOrchestrator();
    const meta: JobHandlerMeta<{ eventId: string }> = {
      pool: 'batch',
      dedupe: {
        key: (input) => `evt:${input.eventId}`,
        windowMs: 60_000,
      },
    };
    orchestrator.registerHandler('t.fnkey.dedupe', meta, NoopHandler);

    const first = await orchestrator.start('t.fnkey.dedupe', { eventId: 'E1' });
    const second = await orchestrator.start('t.fnkey.dedupe', { eventId: 'E1' });
    // Same dedupe key within the window ⇒ the second returns the first run.
    expect(second.id).toBe(first.id);
    expect(first.dedupeKey).toBe('evt:E1');

    // A different event id is NOT deduped.
    const third = await orchestrator.start('t.fnkey.dedupe', { eventId: 'E2' });
    expect(third.id).not.toBe(first.id);
  });

  it('throws JobKeyFunctionUnavailableError if the live fn is missing for a sentinel', async () => {
    const { orchestrator, store } = buildOrchestrator();
    orchestrator.registerHandler(
      't.fnkey.orphan',
      {
        pool: 'batch',
        concurrency: { key: (i: { x: string }) => i.x, collisionMode: 'queue' },
      } as JobHandlerMeta<{ x: string }>,
      NoopHandler,
    );
    // Simulate the registry losing the live meta while the def row keeps the
    // sentinel (e.g. an older build reading a newer-persisted definition).
    const reg = orchestrator.getHandlerRegistration('t.fnkey.orphan')!;
    reg.meta = { pool: 'batch' };
    expect(store.jobs.get('t.fnkey.orphan')?.concurrencyKeyTemplate).toBe(
      FN_KEY_SENTINEL,
    );
    await expect(
      orchestrator.start('t.fnkey.orphan', { x: 'a' }),
    ).rejects.toBeInstanceOf(JobKeyFunctionUnavailableError);
  });
});

// ─── Group 3 — step memoization ─────────────────────────────────────────────

describe('MemoryJobOrchestrator — step memoization (Group 3)', () => {
  it('re-entering after a completed step does NOT call fn again', async () => {
    const { orchestrator, store, stepService } = buildOrchestrator();
    const calls: string[] = [];
    orchestrator.registerHandler(
      't.memo',
      { pool: 'batch' },
      makeStepHandler(calls),
    );

    const run = await orchestrator.start('t.memo', {});
    // First tick — both 'a' and 'b' invoke fn.
    const claimed1 = await orchestrator.claimNext('batch');
    await orchestrator.tick(claimed1!.id);
    expect(calls).toEqual(['a', 'b']);

    // Synthesise "the run needs to re-tick" by resetting status to running
    // without touching steps (those are memoized).
    const completed = store.runs.get(run.id)!;
    expect(completed.status).toBe('completed');
    store.runs.set(run.id, { ...completed, status: 'running', finishedAt: null });

    // Second tick — both steps should be cached; handler re-runs but fns don't.
    await orchestrator.tick(run.id);
    expect(calls).toEqual(['a', 'b']); // unchanged

    // Confirm both completed step rows exist exactly once.
    const steps = store.steps.get(run.id) ?? [];
    expect(steps.filter((s) => s.stepId === 'a' && s.status === 'completed')).toHaveLength(1);
    expect(steps.filter((s) => s.stepId === 'b' && s.status === 'completed')).toHaveLength(1);
    void stepService;
  });

  it('a step that was not previously completed is invoked on re-entry', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const calls: string[] = [];
    const mutable = { failB: true };
    orchestrator.registerHandler(
      't.memo.retry',
      { pool: 'batch', retry: { attempts: 1, backoff: 'fixed', baseMs: 0 } },
      makeStepHandlerFailB(calls, mutable),
    );

    const run = await orchestrator.start('t.memo.retry', {});
    const first = await orchestrator.claimNext('batch');
    await orchestrator.tick(first!.id);
    // Tick 1: a succeeded + memoized, b failed → run ends 'failed' (no retry since attempts=1).
    expect(calls).toEqual(['a', 'b']);
    expect(store.runs.get(run.id)?.status).toBe('failed');

    // Operator fixes the bug and replays; memoized 'a' stays, 'b' must re-run.
    mutable.failB = false;
    await orchestrator.replay(run.id);
    const second = await orchestrator.claimNext('batch');
    await orchestrator.tick(second!.id);

    expect(calls).toEqual(['a', 'b', 'b']); // 'a' NOT re-invoked, only 'b'
    expect(store.runs.get(run.id)?.status).toBe('completed');
  });
});

// ─── Group 4 — cascade cancel ───────────────────────────────────────────────

describe('MemoryJobOrchestrator — cascade cancel (Group 4)', () => {
  it('parent with Terminate + Abandon children cancels only the Terminate child', async () => {
    const { orchestrator, store } = buildOrchestrator();
    orchestrator.registerHandler('t.parent', { pool: 'batch' }, NoopHandler);
    orchestrator.registerHandler('t.child.t', { pool: 'batch' }, NoopHandler);
    orchestrator.registerHandler('t.child.a', { pool: 'batch' }, NoopHandler);

    const parent = await orchestrator.start('t.parent', {});
    const termChild = await orchestrator.start('t.child.t', {}, {
      parentRunId: parent.id,
      parentClosePolicy: ParentClosePolicy.Terminate,
    });
    const abandonChild = await orchestrator.start('t.child.a', {}, {
      parentRunId: parent.id,
      parentClosePolicy: ParentClosePolicy.Abandon,
    });

    await orchestrator.cancel(parent.id, { cascade: true });

    expect(store.runs.get(parent.id)?.status).toBe('canceled');
    expect(store.runs.get(termChild.id)?.status).toBe('canceled');
    expect(store.runs.get(abandonChild.id)?.status).toBe('pending');
  });

  it('three-level Terminate tree — cancelling root cancels every descendant', async () => {
    const { orchestrator, store } = buildOrchestrator();
    orchestrator.registerHandler('t.root', { pool: 'batch' }, NoopHandler);
    orchestrator.registerHandler('t.mid', { pool: 'batch' }, NoopHandler);
    orchestrator.registerHandler('t.leaf', { pool: 'batch' }, NoopHandler);

    const root = await orchestrator.start('t.root', {});
    const mid = await orchestrator.start('t.mid', {}, {
      parentRunId: root.id,
      parentClosePolicy: ParentClosePolicy.Terminate,
    });
    const leaf = await orchestrator.start('t.leaf', {}, {
      parentRunId: mid.id,
      parentClosePolicy: ParentClosePolicy.Terminate,
    });

    await orchestrator.cancel(root.id, { cascade: true });

    for (const id of [root.id, mid.id, leaf.id]) {
      expect(store.runs.get(id)?.status).toBe('canceled');
    }
  });

  it('Cancel policy — parent finished_at is set only after children transitioned', async () => {
    const { orchestrator, store } = buildOrchestrator();
    orchestrator.registerHandler('t.parent2', { pool: 'batch' }, NoopHandler);
    orchestrator.registerHandler('t.child.c', { pool: 'batch' }, NoopHandler);

    const parent = await orchestrator.start('t.parent2', {});
    const child = await orchestrator.start('t.child.c', {}, {
      parentRunId: parent.id,
      parentClosePolicy: ParentClosePolicy.Cancel,
    });

    await orchestrator.cancel(parent.id, { cascade: true });

    const parentRow = store.runs.get(parent.id)!;
    const childRow = store.runs.get(child.id)!;
    expect(childRow.status).toBe('canceled');
    expect(parentRow.status).toBe('canceled');
    // Child must be terminal BEFORE parent's finished_at — i.e. child
    // finishedAt must be <= parent finishedAt (the orchestrator sets them
    // in that order under the same mutex tick).
    expect(childRow.finishedAt!.getTime()).toBeLessThanOrEqual(parentRow.finishedAt!.getTime());
  });
});

// ─── Group 5 — dedupe window ────────────────────────────────────────────────

describe('MemoryJobOrchestrator — dedupe window (Group 5)', () => {
  it('second start within window returns existing run (no new row)', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const meta = {
      pool: 'batch',
      dedupe: { key: '{{accountId}}', windowMs: 60_000 },
    } as unknown as JobHandlerMeta<Record<string, unknown>>;
    orchestrator.registerHandler('t.dedupe', meta, NoopHandler);

    const first = await orchestrator.start('t.dedupe', { accountId: '1' });
    const second = await orchestrator.start('t.dedupe', { accountId: '1' });
    expect(second.id).toBe(first.id);
    expect(store.runs.size).toBe(1);
  });

  it('second start outside window creates a new row', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const meta = {
      pool: 'batch',
      dedupe: { key: '{{accountId}}', windowMs: 60_000 },
    } as unknown as JobHandlerMeta<Record<string, unknown>>;
    orchestrator.registerHandler('t.dedupe2', meta, NoopHandler);

    const first = await orchestrator.start('t.dedupe2', { accountId: '1' });
    // Age the first row past the window.
    const aged = store.runs.get(first.id)!;
    store.runs.set(first.id, {
      ...aged,
      createdAt: new Date(Date.now() - 120_000),
    });

    const second = await orchestrator.start('t.dedupe2', { accountId: '1' });
    expect(second.id).not.toBe(first.id);
    expect(store.runs.size).toBe(2);
  });
});

// ─── Group 6 — replay modes ─────────────────────────────────────────────────

describe('MemoryJobOrchestrator — replay modes (Group 6)', () => {
  it('scratch — clears every prior step', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const calls: string[] = [];
    orchestrator.registerHandler(
      't.replay.scratch',
      { pool: 'batch', replayFrom: 'scratch' },
      makeStepHandler(calls),
    );

    const run = await orchestrator.start('t.replay.scratch', {});
    await tickUntilTerminal(orchestrator, 'batch');
    expect(calls).toEqual(['a', 'b']);
    expect((store.steps.get(run.id) ?? []).filter((s) => s.status === 'completed')).toHaveLength(2);

    await orchestrator.replay(run.id);
    // After replay the steps must be empty.
    expect(store.steps.get(run.id) ?? []).toEqual([]);

    await tickUntilTerminal(orchestrator, 'batch');
    // Both step fns must have been invoked again.
    expect(calls).toEqual(['a', 'b', 'a', 'b']);
  });

  it('last_step — clears only non-completed (failing) steps', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const calls: string[] = [];
    const mutable = { failB: true };
    orchestrator.registerHandler(
      't.replay.last_step',
      { pool: 'batch', replayFrom: 'last_step', retry: { attempts: 1, backoff: 'fixed', baseMs: 0 } },
      makeStepHandlerFailB(calls, mutable),
    );

    const run = await orchestrator.start('t.replay.last_step', {});
    await tickUntilTerminal(orchestrator, 'batch');
    // 'a' completed, 'b' failed → run ends failed (attempts=1, no retry).
    expect(store.runs.get(run.id)?.status).toBe('failed');
    const stepsAfterFail = store.steps.get(run.id) ?? [];
    expect(stepsAfterFail.find((s) => s.stepId === 'a')?.status).toBe('completed');
    expect(stepsAfterFail.find((s) => s.stepId === 'b')?.status).toBe('failed');

    // Replay: 'a' kept (memoized), 'b' cleared.
    mutable.failB = false;
    await orchestrator.replay(run.id);
    const stepsAfterReplay = store.steps.get(run.id) ?? [];
    expect(stepsAfterReplay.find((s) => s.stepId === 'a')?.status).toBe('completed');
    expect(stepsAfterReplay.find((s) => s.stepId === 'b')).toBeUndefined();

    await tickUntilTerminal(orchestrator, 'batch');
    // 'a' not re-invoked, only 'b'.
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('last_checkpoint — preserves all completed steps', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const calls: string[] = [];
    const mutable = { failB: true };
    orchestrator.registerHandler(
      't.replay.checkpoint',
      { pool: 'batch', replayFrom: 'last_checkpoint', retry: { attempts: 1, backoff: 'fixed', baseMs: 0 } },
      makeStepHandlerFailB(calls, mutable),
    );

    const run = await orchestrator.start('t.replay.checkpoint', {});
    await tickUntilTerminal(orchestrator, 'batch');
    expect(store.runs.get(run.id)?.status).toBe('failed');

    mutable.failB = false;
    const replayed = await orchestrator.replay(run.id);
    // Lineage parity — replay preserves rootRunId + parentRunId on the
    // replayed row (Drizzle backend UPDATEs the same row; memory matches).
    expect(replayed.rootRunId).toBe(run.rootRunId);
    expect(replayed.parentRunId).toBe(run.parentRunId);
    await tickUntilTerminal(orchestrator, 'batch');
    // 'a' stayed memoized; only 'b' re-invoked.
    expect(calls).toEqual(['a', 'b', 'b']);
    expect(store.runs.get(run.id)?.status).toBe('completed');
  });
});

// ─── Group 7 — run-level retry (rescheduleForRetry path) ───────────────────

describe('MemoryJobOrchestrator — run-level retry (Group 7)', () => {
  it('retry re-enters as pending with attempts incremented', async () => {
    const { orchestrator, store } = buildOrchestrator();
    const calls: string[] = [];
    const mutable = { failB: true };
    orchestrator.registerHandler(
      't.retry.run',
      {
        pool: 'batch',
        // attempts=3 → classifyError on first failure returns 'retry'
        // (currentAttempts 0 + 1 = 1 < 3), exercising the
        // `rescheduleForRetry` path that plain failure tests skip.
        retry: { attempts: 3, backoff: 'fixed', baseMs: 0 },
      },
      makeStepHandlerFailB(calls, mutable),
    );

    const run = await orchestrator.start('t.retry.run', {});
    const claimed = await orchestrator.claimNext('batch');
    expect(claimed?.id).toBe(run.id);
    await orchestrator.tick(run.id);

    const after = store.runs.get(run.id)!;
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.claimedAt).toBeNull();
    expect(after.startedAt).toBeNull();
    // Error is serialised with retryable=true on the retry path.
    expect(after.error?.retryable).toBe(true);
    expect(after.error?.attempt).toBe(1);
    // 'a' completed + memoized; 'b' attempted and failed.
    expect(calls).toEqual(['a', 'b']);

    // Re-claim + re-tick with the bug fixed — second attempt succeeds.
    mutable.failB = false;
    const reclaimed = await orchestrator.claimNext('batch');
    expect(reclaimed?.id).toBe(run.id);
    await orchestrator.tick(run.id);
    const final = store.runs.get(run.id)!;
    expect(final.status).toBe('completed');
    expect(final.attempts).toBe(2);
    // 'a' memoized → not re-called; only 'b' was retried.
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
