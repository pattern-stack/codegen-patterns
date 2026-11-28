/**
 * Unit tests for LISTEN-NOTIFY-1 — Postgres LISTEN/NOTIFY wakeups for the events
 * outbox drainer and the `PgNotifyListener` helper (the jobs halves left with ADR-022, JOBS-3). No Postgres / Docker — mocked Drizzle clients +
 * a fake `pg.Pool` exercise the wiring. The on-commit delivery semantics
 * (NOTIFY queued in-tx, delivered only on commit) are inherent to Postgres and
 * out of unit scope; these tests pin the SEAM (emit-through-the-tx-client +
 * debounce + degradation), which is what the framework owns.
 */
import { describe, it, expect, mock } from 'bun:test';

import { DrizzleEventBus } from '../../../../runtime/subsystems/events/event-bus.drizzle-backend';
import {
  PgNotifyListener,
  EVENTS_WAKE_CHANNEL,
} from '../../../../runtime/subsystems/events/pg-notify';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Render a captured drizzle `sql` chunk to its raw SQL string. */
function sqlText(arg: unknown): string {
  const q = arg as { queryChunks?: Array<{ value?: string[] }> };
  const chunks = q?.queryChunks ?? [];
  return chunks.map((c) => (c?.value ? c.value.join('') : '')).join('');
}


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
      channel: EVENTS_WAKE_CHANNEL,
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
      channel: EVENTS_WAKE_CHANNEL,
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
      channel: EVENTS_WAKE_CHANNEL,
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
      channel: EVENTS_WAKE_CHANNEL,
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

describe('PgNotifyListener — connect / drop hooks and the heartbeat (ID-1)', () => {
  /** A client whose `SELECT 1` (the heartbeat) answers or hangs as the test says; everything else answers. */
  function hangingClient(answers: () => boolean) {
    const handlers: Record<string, (arg: unknown) => void> = {};
    return {
      query: mock((text: string) =>
        text !== 'SELECT 1' || answers() ? Promise.resolve({}) : new Promise(() => {}),
      ),
      on: (event: string, cb: (arg: unknown) => void) => void (handlers[event] = cb),
      removeAllListeners: () => {},
      release: mock(() => {}),
    };
  }

  it('calls onConnect once LISTEN is in place, and a heartbeat with no answer is a drop that reconnects', async () => {
    let answer = true;
    const client = hangingClient(() => answer);
    const pool = { connect: mock(async () => client) };
    const events: string[] = [];
    const listener = new PgNotifyListener({
      channel: 'identity_requester',
      pool: pool as never,
      label: 'test',
      onNotify: () => {},
      onConnect: () => events.push('connect'),
      onDrop: () => events.push('drop'),
      heartbeatMs: 20,
      heartbeatTimeoutMs: 20,
      backoffMinMs: 10,
    });
    await listener.start();
    expect(events).toEqual(['connect']);
    answer = false;
    await new Promise((r) => setTimeout(r, 80));
    answer = true;
    await new Promise((r) => setTimeout(r, 60));
    await listener.stop();
    expect(events.slice(0, 3)).toEqual(['connect', 'drop', 'connect']);
    expect(pool.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sends no heartbeat when heartbeatMs is absent (jobs and events, as before)', async () => {
    const client = hangingClient(() => true);
    const listener = new PgNotifyListener({ channel: 'c', pool: { connect: async () => client } as never, label: 'test', onNotify: () => {} });
    await listener.start();
    await new Promise((r) => setTimeout(r, 40));
    await listener.stop();
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(["SET application_name TO 'pg-notify:test'", 'LISTEN c']);
  });
});
