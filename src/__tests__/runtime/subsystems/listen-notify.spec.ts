/**
 * Unit tests for LISTEN-NOTIFY-1 — Postgres LISTEN/NOTIFY wakeups across the
 * jobs orchestrator, events outbox drainer, bridge wrapper insert, and the
 * `PgNotifyListener` helper. No Postgres / Docker — mocked Drizzle clients +
 * a fake `pg.Pool` exercise the wiring. The on-commit delivery semantics
 * (NOTIFY queued in-tx, delivered only on commit) are inherent to Postgres and
 * out of unit scope; these tests pin the SEAM (emit-through-the-tx-client +
 * debounce + degradation), which is what the framework owns.
 */
import { describe, it, expect, mock } from 'bun:test';

import { DrizzleJobOrchestrator } from '../../../../runtime/subsystems/jobs/job-orchestrator.drizzle-backend';
import { DrizzleEventBus } from '../../../../runtime/subsystems/events/event-bus.drizzle-backend';
import { BridgeOutboxDrainHook } from '../../../../runtime/subsystems/bridge';
import {
  JobWorker,
  type JobWorkerOptions,
} from '../../../../runtime/subsystems/jobs/job-worker';
import {
  PgNotifyListener,
  JOBS_WAKE_CHANNEL,
  EVENTS_WAKE_CHANNEL,
} from '../../../../runtime/subsystems/jobs/pg-notify';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Render a captured drizzle `sql` chunk to its raw SQL string. */
function sqlText(arg: unknown): string {
  const q = arg as { queryChunks?: Array<{ value?: string[] }> };
  const chunks = q?.queryChunks ?? [];
  return chunks.map((c) => (c?.value ? c.value.join('') : '')).join('');
}

// ─── 1. Orchestrator emits NOTIFY on start (in-tx, gated on the flag) ─────────

describe('DrizzleJobOrchestrator — listen_notify enqueue wake', () => {
  function makeDb(insertedRow: Record<string, unknown>) {
    const executeCalls: unknown[][] = [];
    const insertBuilder = {
      values: mock(() => insertBuilder),
      returning: mock(async () => [insertedRow]),
    };
    const selectBuilder = {
      from: mock(() => selectBuilder),
      where: mock(() => selectBuilder),
      limit: mock(async () => [
        // job definition row used by start()
        { type: 'job.t', version: 1, pool: 'interactive', priorityDefault: 0 },
      ]),
      orderBy: mock(() => selectBuilder),
    };
    const db = {
      select: mock(() => selectBuilder),
      insert: mock(() => insertBuilder),
      execute: mock(async (q: unknown) => {
        executeCalls.push([q]);
        return { rows: [] };
      }),
    };
    return { db, executeCalls };
  }

  const insertedRow = {
    id: 'run-1',
    pool: 'interactive',
    jobType: 'job.t',
    status: 'pending',
  };

  it('emits pg_notify(codegen_jobs_wake, <pool>) when listen_notify is on', async () => {
    const { db, executeCalls } = makeDb(insertedRow);
    const orch = new DrizzleJobOrchestrator(db as never, false, /*listenNotify*/ true);
    await orch.start('job.t', {});
    expect(executeCalls.length).toBe(1);
    const text = sqlText(executeCalls[0][0]).toLowerCase();
    expect(text).toContain('pg_notify');
  });

  it('does NOT emit pg_notify when listen_notify is off (default)', async () => {
    const { db, executeCalls } = makeDb(insertedRow);
    const orch = new DrizzleJobOrchestrator(db as never, false /* default off */);
    await orch.start('job.t', {});
    expect(executeCalls.length).toBe(0);
  });

  it('emits through the SAME client (the tx when one is passed)', async () => {
    const { db: rootDb } = makeDb(insertedRow);
    const txExecute = mock(async () => ({ rows: [] }));
    const txInsertBuilder = {
      values: mock(() => txInsertBuilder),
      returning: mock(async () => [insertedRow]),
    };
    const txSelectBuilder = {
      from: mock(() => txSelectBuilder),
      where: mock(() => txSelectBuilder),
      limit: mock(async () => [
        { type: 'job.t', version: 1, pool: 'interactive', priorityDefault: 0 },
      ]),
      orderBy: mock(() => txSelectBuilder),
    };
    const tx = {
      select: mock(() => txSelectBuilder),
      insert: mock(() => txInsertBuilder),
      execute: txExecute,
    };
    const orch = new DrizzleJobOrchestrator(rootDb as never, false, true);
    await orch.start('job.t', {}, {}, tx as never);
    // NOTIFY rode the tx handle, not the root db (D2 — in-tx, commit-gated).
    expect(txExecute).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Events drainer emits NOTIFY on publish ────────────────────────────────

describe('DrizzleEventBus — listen_notify publish wake', () => {
  function makeDb() {
    const executeCalls: unknown[][] = [];
    const insertBuilder = { values: mock(async () => []) };
    const db = {
      insert: mock(() => insertBuilder),
      execute: mock(async (q: unknown) => {
        executeCalls.push([q]);
        return { rows: [] };
      }),
    };
    return { db, executeCalls };
  }

  const event: DomainEvent = {
    id: 'e-1',
    type: 't',
    aggregateId: 'a-1',
    aggregateType: 'agg',
    payload: {},
    occurredAt: new Date('2026-06-04T00:00:00Z'),
    metadata: { pool: 'events_inbound', direction: 'inbound' },
  };

  it('emits pg_notify(codegen_events_wake, <pool>) on publish when enabled', async () => {
    const { db, executeCalls } = makeDb();
    const bus = new DrizzleEventBus(db as never, {
      backend: 'drizzle',
      listenNotify: true,
    });
    await bus.publish(event);
    expect(executeCalls.length).toBe(1);
    expect(sqlText(executeCalls[0][0]).toLowerCase()).toContain('pg_notify');
  });

  it('does NOT emit when listen_notify is off', async () => {
    const { db, executeCalls } = makeDb();
    const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });
    await bus.publish(event);
    expect(executeCalls.length).toBe(0);
  });

  it('publishMany de-dups one wake per distinct pool', async () => {
    const { db, executeCalls } = makeDb();
    const bus = new DrizzleEventBus(db as never, {
      backend: 'drizzle',
      listenNotify: true,
    });
    await bus.publishMany([
      event,
      { ...event, id: 'e-2' }, // same pool → coalesced
    ]);
    expect(executeCalls.length).toBe(1);
  });
});

// ─── 3. Bridge wrapper insert emits NOTIFY ────────────────────────────────────

describe('BridgeOutboxDrainHook — listen_notify wrapper wake', () => {
  function makeTx() {
    const executeCalls: unknown[][] = [];
    let returningIdx = 0;
    const returningResults = [['delivery-1']]; // delivery row inserted
    const tx = {
      insert() {
        const builder = {
          values() {
            const chain = {
              onConflictDoNothing() {
                return {
                  returning() {
                    const ids = returningResults[returningIdx++] ?? [];
                    return Promise.resolve(ids.map((id) => ({ id })));
                  },
                };
              },
              then(resolve: (v: unknown[]) => void) {
                resolve([]);
              },
            };
            return chain;
          },
        };
        return builder;
      },
      delete() {
        return { where: () => Promise.resolve([]) };
      },
      execute: mock(async (q: unknown) => {
        executeCalls.push([q]);
        return { rows: [] };
      }),
    };
    return { tx, executeCalls };
  }

  const registry = {
    contact_created: [{ triggerId: 'trig-1', jobType: 'job.x', concurrency: undefined }],
  } as never;

  const event: DomainEvent = {
    id: 'evt-1',
    type: 'contact_created',
    aggregateId: 'a',
    aggregateType: 'contact',
    payload: {},
    occurredAt: new Date(),
    metadata: { direction: 'change' },
  };

  it('emits pg_notify(codegen_jobs_wake, events_change) when enabled', async () => {
    const { tx, executeCalls } = makeTx();
    const hook = new BridgeOutboxDrainHook(registry, /*listenNotify*/ true);
    const res = await hook.processEvent(event, tx as never);
    expect(res.delivered).toBe(1);
    expect(executeCalls.length).toBe(1);
    expect(sqlText(executeCalls[0][0]).toLowerCase()).toContain('pg_notify');
  });

  it('does NOT emit when listen_notify is off', async () => {
    const { tx, executeCalls } = makeTx();
    const hook = new BridgeOutboxDrainHook(registry); // default false
    await hook.processEvent(event, tx as never);
    expect(executeCalls.length).toBe(0);
  });
});

// ─── 4. JobWorker wake debounce + pool filtering ──────────────────────────────

describe('JobWorker — onWake debounce + pool filter', () => {
  function makeWorker(opts: Partial<JobWorkerOptions> = {}): {
    worker: JobWorker;
    pollSpy: ReturnType<typeof mock>;
  } {
    const db = { $client: { connect: mock(async () => ({})) } };
    const orch = {} as never;
    const runSvc = {} as never;
    const stepSvc = {} as never;
    const moduleRef = {} as never;
    const options: JobWorkerOptions = {
      pool: 'interactive',
      concurrency: 2,
      listenNotify: true,
      ...opts,
    };
    const worker = new JobWorker(
      db as never,
      orch,
      runSvc,
      stepSvc,
      options,
      moduleRef,
    );
    // Stub the claim cycle so onWake's drain loop exercises debounce, not DB.
    const pollSpy = mock(async () => {
      /* claims nothing → no progress → drain loop exits */
    });
    (worker as unknown as { pollAndProcess: unknown }).pollAndProcess = pollSpy;
    return { worker, pollSpy };
  }

  it('ignores a notify naming a foreign pool', () => {
    const { worker, pollSpy } = makeWorker();
    (worker as unknown as { onWake(p: string): void }).onWake('batch');
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it('drives a claim cycle on a notify for its own pool', async () => {
    const { worker, pollSpy } = makeWorker();
    (worker as unknown as { onWake(p: string): void }).onWake('interactive');
    // drainOnWake is async; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(pollSpy).toHaveBeenCalled();
  });

  it('coalesces a mid-drain notify into a single re-check (no stacking)', async () => {
    const db = { $client: { connect: mock(async () => ({})) } };
    const options: JobWorkerOptions = {
      pool: 'interactive',
      concurrency: 2,
      listenNotify: true,
    };
    const worker = new JobWorker(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      options,
      {} as never,
    );
    let cycles = 0;
    // First cycle: while "draining", fire a second notify → must set recheck,
    // NOT spawn a parallel drain. Returns no progress so the inner loop exits.
    (worker as unknown as { pollAndProcess: () => Promise<void> }).pollAndProcess =
      async () => {
        cycles++;
        if (cycles === 1) {
          (worker as unknown as { onWake(p: string): void }).onWake('interactive');
        }
      };
    await (worker as unknown as { drainOnWake(): Promise<void> }).drainOnWake();
    // cycle 1 (initial) + cycle 2 (the coalesced re-check) = exactly 2, never 3+.
    expect(cycles).toBe(2);
  });
});

// ─── 5. PgNotifyListener — degradation to polling on listener death ───────────

describe('PgNotifyListener — degradation + recovery', () => {
  it('reconnects with backoff after the listener connection drops', async () => {
    let connects = 0;
    let dropHandler: ((err: Error) => void) | null = null;
    const client = {
      query: mock(async () => ({})),
      on: (ev: string, cb: (arg: never) => void) => {
        if (ev === 'error') dropHandler = cb as (err: Error) => void;
      },
      release: mock(() => {}),
    };
    const pool = {
      connect: mock(async () => {
        connects++;
        return client;
      }),
    };
    const notifies: string[] = [];
    const listener = new PgNotifyListener({
      channel: JOBS_WAKE_CHANNEL,
      pool: pool as never,
      label: 'test',
      onNotify: (p) => notifies.push(p),
      backoffMinMs: 5,
      backoffMaxMs: 10,
    });
    await listener.start();
    expect(connects).toBe(1);
    // Simulate a connection drop → listener schedules a reconnect.
    dropHandler?.(new Error('connection terminated'));
    await new Promise((r) => setTimeout(r, 30));
    expect(connects).toBeGreaterThanOrEqual(2); // reconnected → still degraded-safe
    await listener.stop();
  });

  it('forwards only matching-channel notifications to onNotify', async () => {
    let notificationHandler:
      | ((msg: { channel: string; payload?: string }) => void)
      | null = null;
    const client = {
      query: mock(async () => ({})),
      on: (ev: string, cb: (arg: never) => void) => {
        if (ev === 'notification')
          notificationHandler = cb as (msg: {
            channel: string;
            payload?: string;
          }) => void;
      },
      release: mock(() => {}),
    };
    const pool = { connect: mock(async () => client) };
    const received: string[] = [];
    const listener = new PgNotifyListener({
      channel: EVENTS_WAKE_CHANNEL,
      pool: pool as never,
      label: 'events',
      onNotify: (p) => received.push(p),
    });
    await listener.start();
    notificationHandler?.({ channel: EVENTS_WAKE_CHANNEL, payload: 'events_inbound' });
    notificationHandler?.({ channel: 'other_channel', payload: 'nope' });
    expect(received).toEqual(['events_inbound']);
    await listener.stop();
  });
});

// ─── 6. PgNotifyListener — stop()/connect() race (LISTEN-NOTIFY-2) ─────────────
//
// The shutdown leak: a stop() that fires while connect() is mid-`pool.connect()`
// used to see `this.client === null` (nothing to release), then connect()
// resumed, assigned the client, and issued `LISTEN` — leaking an ESTABLISHED
// listener socket past `app.close()`. These tests force the race deterministically
// with a controllable `pool.connect()` / `LISTEN` (manual promises) and assert the
// checked-out client is RELEASED and `LISTEN` is never wired into a surviving
// client. Pre-fix all three fail; post-fix all pass.

describe('PgNotifyListener — stop() racing an in-flight connect() (LISTEN-NOTIFY-2)', () => {
  /** A controllable client whose checkout + LISTEN we can gate by hand. */
  function makeControllableClient() {
    const listenCalls: string[] = [];
    let released = false;
    const client = {
      query: mock(async (text: string) => {
        if (text.startsWith('LISTEN')) listenCalls.push(text);
        return {};
      }),
      on: mock(() => {}),
      removeAllListeners: mock(() => {}),
      release: mock(() => {
        released = true;
      }),
    };
    return {
      client,
      listenCalls,
      get released() {
        return released;
      },
    };
  }

  it('releases the checked-out client when stop() fires during pool.connect()', async () => {
    const ctl = makeControllableClient();
    // Gate the checkout: connect() awaits this until we resolve it.
    let resolveConnect!: (c: unknown) => void;
    const connectGate = new Promise((res) => {
      resolveConnect = res;
    });
    const pool = {
      connect: mock(() => connectGate),
    };

    const listener = new PgNotifyListener({
      channel: JOBS_WAKE_CHANNEL,
      pool: pool as never,
      label: 'race',
      onNotify: () => {},
    });

    // start() kicks off connect(); it parks on the gated pool.connect().
    const starting = listener.start();
    // stop() arrives WHILE the checkout is in flight (the race window).
    const stopping = listener.stop();
    // Now let the checkout resolve — connect() resumes and MUST notice stopped.
    resolveConnect(ctl.client);

    await Promise.all([starting, stopping]);

    // Pre-fix: connect() assigned the client and issued LISTEN → leak.
    // Post-fix: the resumed connect() sees `stopped`, releases the client,
    // and never wires LISTEN.
    expect(ctl.released).toBe(true);
    expect(ctl.listenCalls).toEqual([]);
  });

  it('releases the client when stop() fires during the LISTEN round-trip', async () => {
    const listenCalls: string[] = [];
    let released = false;
    let resolveListen!: () => void;
    const listenGate = new Promise<void>((res) => {
      resolveListen = res;
    });
    const client = {
      query: mock(async (text: string) => {
        if (text.startsWith('LISTEN')) {
          listenCalls.push(text);
          await listenGate; // park inside LISTEN
        }
        return {};
      }),
      on: mock(() => {}),
      removeAllListeners: mock(() => {}),
      release: mock(() => {
        released = true;
      }),
    };
    const pool = { connect: mock(async () => client) };

    const listener = new PgNotifyListener({
      channel: JOBS_WAKE_CHANNEL,
      pool: pool as never,
      label: 'race-listen',
      onNotify: () => {},
    });

    const starting = listener.start();
    // Let the checkout resolve + LISTEN begin, then fire stop() mid-LISTEN.
    await new Promise((r) => setTimeout(r, 0));
    const stopping = listener.stop();
    resolveListen();

    await Promise.all([starting, stopping]);

    // The client must be released even though LISTEN was issued — the post-LISTEN
    // stopped-recheck destroys the socket so nothing survives shutdown.
    expect(released).toBe(true);
  });

  it('stop() awaits an in-flight connect() (no early return that leaves a checkout dangling)', async () => {
    const ctl = makeControllableClient();
    let resolveConnect!: (c: unknown) => void;
    const connectGate = new Promise((res) => {
      resolveConnect = res;
    });
    const pool = { connect: mock(() => connectGate) };

    const listener = new PgNotifyListener({
      channel: JOBS_WAKE_CHANNEL,
      pool: pool as never,
      label: 'race-await',
      onNotify: () => {},
    });

    void listener.start();
    let stopResolved = false;
    const stopping = listener.stop().then(() => {
      stopResolved = true;
    });

    // stop() must NOT resolve while the checkout is still pending — otherwise
    // app.close() returns before the listener is actually torn down.
    await new Promise((r) => setTimeout(r, 5));
    expect(stopResolved).toBe(false);

    resolveConnect(ctl.client);
    await stopping;
    expect(stopResolved).toBe(true);
    expect(ctl.released).toBe(true);
  });
});
