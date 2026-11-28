import assert from 'node:assert/strict';
import { runToCompletion } from '../adapters/in-process-executor.ts';
import { localLimiters } from '../adapters/local-limiter.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import type { JobDefinition, StepEntry } from '../define/define-job.ts';
import { type ErasedGate, gate } from '../define/gate.ts';
import { createRegistry } from '../define/registry.ts';
import type { ErasedContext, ErasedStep } from '../define/step.ts';
import { signalRun } from '../engine/signals.ts';
import { GateClosedError, SignalRefusedError } from '../model/errors.ts';
import type { RunRequest } from '../model/run.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { ContractCase } from './contract.ts';
import { fakeClock } from './fake-clock.ts';
import { recordingSink } from './recording-sink.ts';

/** A job under the replay contract, with the request it is run on. Its work must be a function of its records. */
export interface ReplaySubject<I, O> {
  name: string;
  job: JobDefinition<I, O, unknown>;
  request: Omit<RunRequest<I>, 'jobKey'>;
  /** The executor shapes the result must not depend on. Default chunks of 1, 3 and 1000 at 1, 4 and 2 in flight. */
  shapes?: { chunkSize: number; chunkConcurrency: number }[];
  /** At most this many crash points, spread over the run's calls. Default 8. */
  crashPoints?: number;
  /** The store each run uses, on the contract's clock. Default a `MemoryJobStore`. */
  makeStore?: (now: () => Date) => JobStore;
  /**
   * A fresh tenant for each run of the contract (a seeded one, for a store with a foreign key), so no run reads
   * another's results from a shared recorder or store. Default `replay-tenant-<n>`.
   */
  tenants?: () => string;
  /**
   * The value each wait step's signal carries, by step name: every run of the contract sends it when the step waits
   * (`runToCompletion`'s `signals`). A job with a wait step needs one for each.
   */
  signals?: Readonly<Record<string, unknown>>;
}

/** One call a step made: a plain step's run, or one batch of a map step (its keys). */
interface Call {
  step: string;
  keys: string[] | null;
}

interface Instrumented<I, O> {
  job: JobDefinition<I, O, unknown>;
  calls: Call[];
  /** Successful answers per step and key, in this process. */
  answered: Map<string, number>;
}

/** No key was answered twice in one process: the engine never asks again for what it already has. */
function assertAnsweredOnce(answered: Map<string, number>, what: string) {
  for (const [key, n] of answered)
    assert.ok(
      n <= 1,
      `${what}: ${key.replace('\u0000', ' ')} was answered ${n} times`,
    );
}

/** What a crashed run had recorded: its ended steps, and each map step's settled items (`step\u0000key`). */
async function recordsOf(
  store: JobStore,
  runId: string,
): Promise<{ doneSteps: Set<string>; recorded: Set<string> }> {
  const doneSteps = new Set<string>();
  const recorded = new Set<string>();
  for (const state of await store.stepStates(runId)) {
    if (state.status === 'completed' || state.status === 'skipped')
      doneSteps.add(state.name);
    if (state.kind !== 'map') continue;
    for (const item of await store.items(runId, state.name))
      if (item.status !== 'pending')
        recorded.add(`${state.name}\u0000${item.key}`);
  }
  return { doneSteps, recorded };
}

/** A resumed run asks nothing it recorded: no ended step runs again, and no settled item is asked again. */
function assertNothingAskedAgain(
  calls: readonly Call[],
  { doneSteps, recorded }: { doneSteps: Set<string>; recorded: Set<string> },
  what: string,
): void {
  for (const c of calls) {
    assert.ok(
      !(c.keys === null && doneSteps.has(c.step)),
      `${what}: completed step ${c.step} ran again`,
    );
    for (const key of c.keys ?? [])
      assert.ok(
        !recorded.has(`${c.step}\u0000${key}`),
        `${what}: ${c.step} asked again for recorded item ${key}`,
      );
  }
}

/**
 * The job with every step's calls counted, and call `crashAt` held until its signal aborts, as a crash leaves it.
 * The version is the original's: the code is the same.
 */
function instrument<I, O>(
  job: JobDefinition<I, O, unknown>,
  options: {
    /** The call it hangs at, as a process dying mid-call does; `reached` is told as it hangs. */
    crash?: { at: number; reached: () => void };
    jitter?: boolean;
    gateAt?: ReadonlySet<number>;
  } = {},
): Instrumented<I, O> {
  const calls: Call[] = [];
  const answered = new Map<string, number>();
  const count = (step: string, keys: readonly string[]) => {
    for (const k of keys) {
      const id = `${step}\u0000${k}`;
      answered.set(id, (answered.get(id) ?? 0) + 1);
    }
  };
  // The probe gate: a call numbered in `gateAt` finds it closed (it throws `GateClosedError`), and it stays closed
  // for one more read, so the step parks and is woken by its poll.
  let closedReads = 0;
  const probe: ErasedGate = gate({
    name: REPLAY_GATE,
    isOpen: () => {
      if (closedReads === 0) return true;
      closedReads--;
      return false;
    },
    poll: { initialMs: 5, maxMs: 5 },
  }).erased;
  const hold = async (call: Call, signal: AbortSignal) => {
    calls.push(call);
    if (options.gateAt?.has(calls.length)) {
      closedReads = 1;
      throw new GateClosedError(REPLAY_GATE);
    }
    // Out of order: a batch's delay comes from its keys, so later chunks often return before earlier ones.
    if (options.jitter && call.keys?.length) {
      const ms =
        [...call.keys.join('')].reduce((a, c) => a + c.charCodeAt(0), 0) % 7;
      await new Promise((r) => setTimeout(r, ms));
    }
    if (calls.length !== options.crash?.at) return;
    options.crash.reached();
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const wrap = (entry: StepEntry): StepEntry => {
    const erased: ErasedStep = entry.erased;
    // A wait step makes no call (its value comes from the signal), nor does a children step (its children do).
    if (erased.kind === 'wait' || erased.kind === 'children') return entry;
    const gates = options.gateAt ? [...erased.gates, probe] : erased.gates;
    if (erased.kind === 'step')
      return {
        ...entry,
        erased: {
          ...erased,
          gates,
          run: async (ctx: ErasedContext) => {
            await hold({ step: entry.name, keys: null }, ctx.signal);
            const out = await erased.run(ctx);
            count(entry.name, ['(step)']);
            return out;
          },
        },
      };
    return {
      ...entry,
      erased: {
        ...erased,
        gates,
        run: async (batch, ctx) => {
          const keys = batch.map((b) => b.key);
          await hold({ step: entry.name, keys }, ctx.signal);
          const out = await erased.run(batch, ctx);
          count(entry.name, keys);
          return out;
        },
      },
    };
  };
  return { job: { ...job, steps: job.steps.map(wrap) }, calls, answered };
}

const REPLAY_GATE = 'replay.gate';

const DEFAULT_SHAPES = [
  { chunkSize: 1, chunkConcurrency: 1 },
  { chunkSize: 3, chunkConcurrency: 4 },
  { chunkSize: 1000, chunkConcurrency: 2 },
];

const fast = { pollMs: 1 };

/**
 * The determinism check every job and the engine pass, over what a test can observe of the Temporal-ready rules: the
 * result does not depend on chunk size, width or the order calls return; no key is answered twice in one process; a
 * run stopped at any call and resumed from its records gives the same result without running a completed step or
 * asking again for a recorded item; and every timestamp, event time and the deadline are read on the clock it was
 * given. Each run has its own tenant, so no run is answered from another's results.
 */
export function replayContract<I, O>(
  subject: ReplaySubject<I, O>,
): ContractCase[] {
  const { job } = subject;
  let runs = 0;
  const nextTenant =
    subject.tenants ?? (() => `replay-tenant-${++runs}`);
  /** The subject's request under a fresh tenant. */
  const fresh = () => ({
    ...subject.request,
    tenantId: nextTenant(),
  });
  const newStore = (now: () => Date): JobStore =>
    subject.makeStore?.(now) ?? new MemoryJobStore({ now });
  const signals = ({ step }: { step: string }) => subject.signals?.[step];
  const waitSteps = job.steps
    .filter((s) => s.erased.kind === 'wait')
    .map((s) => s.name);
  const reference = async () => {
    const { job: counted, calls, answered } = instrument(job);
    const clock = fakeClock();
    const outcome = await runToCompletion(counted, fresh(), {
      store: newStore(clock.now),
      signals,
      clock,
      limiters: localLimiters({}, { fallback: { inFlight: 1 } }),
      executor: { ...fast, chunkConcurrency: 1 },
    });
    assert.equal(
      outcome.run.status,
      'completed',
      'the reference run completes',
    );
    assertAnsweredOnce(answered, 'the reference run');
    // A map step with items must have been asked: a contract that only read a cache would pass vacuously.
    for (const s of outcome.steps)
      if (s.kind === 'map' && s.counts.total > 0)
        assert.ok(
          calls.some((c) => c.step === s.name && c.keys !== null),
          `the reference run asked map step ${s.name} nothing: its results came from a cache`,
        );
    return { output: outcome.output, calls };
  };

  return [
    {
      name: `${subject.name}: the result does not depend on how the engine splits and spreads the work, nor on the order calls return`,
      async run() {
        const { output } = await reference();
        for (const shape of subject.shapes ?? DEFAULT_SHAPES) {
          const clock = fakeClock();
          const shaped = instrument(job, { jitter: true });
          const outcome = await runToCompletion(
            shaped.job,
            { ...fresh(), chunkSize: shape.chunkSize },
            {
              store: newStore(clock.now),
              signals,
              clock,
              executor: { ...fast, chunkConcurrency: shape.chunkConcurrency },
            },
          );
          assert.equal(outcome.run.status, 'completed');
          assert.deepEqual(
            outcome.output,
            output,
            `chunks of ${shape.chunkSize} at ${shape.chunkConcurrency} in flight`,
          );
          assertAnsweredOnce(
            shaped.answered,
            `chunks of ${shape.chunkSize} at ${shape.chunkConcurrency} in flight`,
          );
        }
      },
    },
    {
      name: `${subject.name}: a run stopped at any call resumes from its records, with the same result and no extra calls`,
      async run() {
        const { output, calls } = await reference();
        const points = crashPoints(calls.length, subject.crashPoints ?? 8);
        for (const k of points) {
          const clock = fakeClock();
          const store = newStore(clock.now);
          const dedupeKey = `replay-${k}`;
          const request = fresh();
          const atCrash = Promise.withResolvers<void>();
          const before = instrument(job, {
            crash: { at: k, reached: atCrash.resolve },
          });
          const crash = new AbortController();
          const dying = runToCompletion(
            before.job,
            { ...request, dedupeKey },
            {
              store,
              clock,
              signals,
              signal: crash.signal,
              limiters: localLimiters({}, { fallback: { inFlight: 1 } }),
              executor: { ...fast, chunkConcurrency: 1 },
            },
          );
          await Promise.race([atCrash.promise, dying]);
          crash.abort(new Error('the process died'));
          await assert.rejects(dying);
          const [run] = await store.listRuns({
            tenantId: request.tenantId,
            jobKey: job.key,
            limit: 1,
          });
          assert.ok(run, 'the crashed run exists');
          const records = await recordsOf(store, run.id);

          // The next process, past the dead owner's claims.
          clock.advance(10 * 60_000);
          const after = instrument(job);
          const resumed = await runToCompletion(
            after.job,
            { ...request, dedupeKey },
            {
              store,
              clock,
              signals,
              limiters: localLimiters({}, { fallback: { inFlight: 1 } }),
              executor: { ...fast, chunkConcurrency: 1 },
            },
          );
          assert.equal(
            resumed.run.id,
            run.id,
            `crash at call ${k}: resumed the same run`,
          );
          assert.equal(resumed.run.status, 'completed');
          assertAnsweredOnce(before.answered, `crash at call ${k}, before`);
          assertAnsweredOnce(after.answered, `crash at call ${k}, after`);
          assert.deepEqual(
            resumed.output,
            output,
            `crash at call ${k}: the same result`,
          );
          assertNothingAskedAgain(after.calls, records, `crash at call ${k}`);
        }
      },
    },
    {
      name: `${subject.name}: a gate closing at any call parks the run, and it carries on to the same result`,
      async run() {
        const { output, calls } = await reference();
        const points = crashPoints(calls.length, subject.crashPoints ?? 8);
        // Each point alone, then every point in one run.
        for (const gateAt of [...points.map((k) => [k]), points]) {
          const clock = fakeClock();
          const sink = recordingSink();
          const gated = instrument(job, {
            gateAt: new Set(gateAt),
          });
          const outcome = await runToCompletion(gated.job, fresh(), {
            store: newStore(clock.now),
            signals,
            clock,
            sinks: [sink],
            limiters: localLimiters({}, { fallback: { inFlight: 1 } }),
            executor: { ...fast, chunkConcurrency: 1 },
          });
          const what = `the gate closed at call${gateAt.length > 1 ? 's' : ''} ${gateAt.join(', ')}`;
          assert.equal(
            outcome.run.status,
            'completed',
            `${what}: completes (${outcome.run.status}, ${outcome.run.error?.type ?? 'no error'})`,
          );
          assert.deepEqual(outcome.output, output, `${what}: the same result`);
          assertAnsweredOnce(gated.answered, what);
          assert.ok(
            sink.events.some(
              (e) => e.type === 'step.waiting' && e.waitName === REPLAY_GATE,
            ),
            `${what}: the step parked on the gate`,
          );
          assert.ok(
            !sink.events.some(
              (e) =>
                (e.type === 'item.failed' ||
                  e.type === 'step.failed' ||
                  e.type === 'step.retried') &&
                e.errorType === GateClosedError.name,
            ),
            `${what}: a closed gate fails and retries nothing`,
          );
        }
      },
    },
    ...(waitSteps.length
      ? [
          {
            name: `${subject.name}: a signal delivered and the process dying before the advance resumes to the same result; the signal counts once`,
            async run() {
              const { output } = await reference();
              const clock = fakeClock();
              const store = newStore(clock.now);
              const request = { ...fresh(), dedupeKey: 'replay-signals' };
              const registry = createRegistry([job]);
              // Each wait: run until it waits with nothing sent, then deliver its signal with no executor to submit
              // the run, as a process dying between the delivery and the advance leaves it.
              for (const step of waitSteps) {
                const waiting = await runToCompletion(job, request, {
                  store,
                  clock,
                  limiters: localLimiters({}, { fallback: { inFlight: 1 } }),
                  executor: { ...fast, chunkConcurrency: 1 },
                });
                assert.equal(
                  waiting.run.status,
                  'waiting',
                  `the run waits at ${step}`,
                );
                const state = waiting.steps.find((s) => s.name === step);
                assert.equal(state?.status, 'waiting', `${step} waits`);
                const signal = state?.wait?.name ?? '';
                const send = () =>
                  signalRun(
                    { store, registry, clock, events: recordingSink() },
                    {
                      runId: waiting.run.id,
                      step,
                      signal,
                      value: subject.signals?.[step],
                      by: null,
                    },
                  );
                await send();
                // The first signal wins: a second finds the step settled.
                await assert.rejects(send(), SignalRefusedError);
              }
              const resumed = await runToCompletion(job, request, {
                store,
                clock,
                limiters: localLimiters({}, { fallback: { inFlight: 1 } }),
                executor: { ...fast, chunkConcurrency: 1 },
              });
              assert.equal(resumed.run.status, 'completed');
              assert.deepEqual(resumed.output, output, 'the same result');
            },
          },
        ]
      : []),
    {
      name: `${subject.name}: the engine reads time only through its clock`,
      async run() {
        const start = new Date('2001-02-03T04:05:06Z');
        const clock = fakeClock(start);
        const sink = recordingSink();
        const store = newStore(clock.now);
        // A deadline an hour on, on the clock: an engine reading the wall clock pauses the run, which fails below.
        const request = fresh();
        const outcome = await runToCompletion(
          job,
          {
            ...request,
            budget: {
              ...request.budget,
              deadline: new Date(start.getTime() + 3_600_000),
            },
          },
          { store, clock, sinks: [sink], signals, executor: fast },
        );
        assert.equal(outcome.run.status, 'completed');
        const end = clock.now().getTime();
        const within = (d: Date | null, what: string) =>
          assert.ok(
            d === null ||
              (d.getTime() >= start.getTime() && d.getTime() <= end),
            `${what} (${d?.toISOString()}) is on the clock`,
          );
        within(outcome.run.createdAt, 'run.createdAt');
        within(outcome.run.startedAt, 'run.startedAt');
        within(outcome.run.completedAt, 'run.completedAt');
        for (const s of outcome.steps) {
          within(s.startedAt, `${s.name}.startedAt`);
          within(s.completedAt, `${s.name}.completedAt`);
        }
        assert.ok(sink.events.length > 0);
        for (const e of sink.events) within(e.at, e.type);
      },
    },
  ];
}

/** Up to `max` call numbers from 1 to n, spread evenly, the first and the last included. */
function crashPoints(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i + 1);
  const out = new Set<number>();
  for (let i = 0; i < max; i++)
    out.add(1 + Math.round((i * (n - 1)) / (max - 1)));
  return [...out];
}
