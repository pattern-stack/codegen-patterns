/**
 * `createJobsEngine` (J-1): the jobs engine with no framework, as a pattern-stack app's `jobs` system builds it. A job
 * factory's dependencies are the values the composition provides for that factory; `start` checks every one was
 * provided before it starts anything; the limiter check runs at create; `stop` is idempotent.
 */
import { describe, expect, it } from 'bun:test';
import { defineJob, injected, type JobEvent, jobFactory, step } from '@pattern-stack/jobs';
import { MemoryJobStore } from '@pattern-stack/jobs/testing';
import { z } from 'zod';

import { createJobsEngine } from '../../../../runtime/subsystems/jobs/core';

/** The app's Drizzle client: the store is built over it, and nothing here queries. */
const db = {};

const plain = defineJob({
  key: 'toy.plain',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  steps: (s) => s.add('ok', step({ run: () => ({ ok: true }) })),
});

interface Greeter {
  hi(name: string): string;
}

const greet = jobFactory({
  deps: { greeter: injected<Greeter>('greeting') },
  create: ({ greeter }) =>
    defineJob({
      key: 'toy.greet',
      input: z.object({ name: z.string() }),
      output: z.object({ said: z.string() }),
      steps: (s) => s.add('hi', step({ run: (ctx) => ({ said: greeter.hi((ctx.input as { name: string }).name) }) })),
    }),
});

/** A memory store that also keeps the event log, so the engine's event-log sink is seen. */
function loggingStore() {
  const events: JobEvent[] = [];
  const store = Object.assign(new MemoryJobStore(), {
    async appendEvent(event: JobEvent) {
      events.push(event);
    },
  });
  return { store, events };
}

/** A run through the engine itself: its starter creates it, its executor (a worker's loop) completes it. */
async function runThrough(engine: ReturnType<typeof createJobsEngine>, key: string, input: unknown) {
  const { run } = await engine.starter.start(key, input, { tenantId: 'tenant-1', budget: { maxItems: 10 } });
  for (let i = 0; i < 500; i++) {
    const now = await engine.store.getRun(run.id);
    if (now.status === 'completed' || now.status === 'failed') return now;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`run ${run.id} did not end`);
}

describe('createJobsEngine', () => {
  it('registers plain jobs and factories; a run goes through its starter, executor and sinks, and a factory reaches its values', async () => {
    const { store, events } = loggingStore();
    const engine = createJobsEngine({ db, store, definitions: [plain, greet], worker: true, inProcess: { pollMs: 1 } });
    expect(engine.registry.has('toy.plain')).toBe(true);
    expect(engine.starter.has('toy.greet')).toBe(true);

    engine.provide(greet, { greeter: { hi: (name) => `hi ${name}` } });
    await engine.start();
    const done = await runThrough(engine, 'toy.greet', { name: 'ada' });
    expect(done.status).toBe('completed');
    expect(await store.stepOutput(done.id, 'hi')).toEqual({ said: 'hi ada' });
    expect((await runThrough(engine, 'toy.plain', {})).status).toBe('completed');
    // The engine's own sinks ran: the store's event log saw the run end.
    expect(events.some((e) => e.type === 'run.completed' && e.runId === done.id)).toBe(true);
    await engine.stop();
  });

  it("start stops on a factory whose values were never provided, naming the job and the dependency", async () => {
    const engine = createJobsEngine({ db, definitions: [greet], worker: true });
    await expect(engine.start()).rejects.toThrow(/job 'toy\.greet': its dependency 'greeter' \(greeting\)/);
    // Nothing was started, so there is nothing to stop.
    await engine.stop();
  });

  it('refuses values for a factory the app does not list', () => {
    const engine = createJobsEngine({ db, definitions: [plain], worker: false });
    expect(() => engine.provide(greet, { greeter: { hi: () => '' } })).toThrow(/does not list/);
  });

  it('a step naming a limiter with no config stops the create', () => {
    const limited = defineJob({
      key: 'toy.limited',
      input: z.object({}),
      output: z.object({}),
      steps: (s) => s.add('go', step({ limiter: 'integration', run: () => ({}) })),
    });
    expect(() => createJobsEngine({ db, definitions: [limited], worker: false })).toThrow(/toy\.limited\/go: integration/);
    expect(() =>
      createJobsEngine({ db, definitions: [limited], worker: false, limiters: { integration: { inFlight: 1 } } }),
    ).not.toThrow();
  });

  it('a worker starts the executor loop once and stops it once; stopping twice does nothing; a non-worker never starts it', async () => {
    const counted = (worker: boolean) => {
      const engine = createJobsEngine({ db, store: loggingStore().store, definitions: [plain], worker });
      const calls = { start: 0, stop: 0 };
      const { start, stop } = engine.executor;
      engine.executor.start = async () => {
        calls.start++;
        return start.call(engine.executor);
      };
      engine.executor.stop = async (o) => {
        calls.stop++;
        return stop.call(engine.executor, o);
      };
      return { engine, calls };
    };
    const worker = counted(true);
    await worker.engine.start();
    await worker.engine.start();
    await worker.engine.stop();
    await worker.engine.stop();
    expect(worker.calls).toEqual({ start: 1, stop: 1 });

    const http = counted(false);
    await http.engine.start();
    await http.engine.stop();
    expect(http.calls).toEqual({ start: 0, stop: 0 });
  });
});
