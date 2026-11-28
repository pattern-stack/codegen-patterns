import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LimiterConfig, Limiters } from '../ports/limiter.ts';
import type { ContractCase } from './contract.ts';

/**
 * A `Limiters` adapter under test. `make` gives two holders of one set of buckets, the way two worker processes hold
 * them: an in-memory adapter returns the same object twice, a shared one two clients over one store. Both read the
 * suite's clock, which only the suite moves.
 */
export interface LimiterHarness {
  make(
    config: Readonly<Record<string, LimiterConfig>>,
    clock: () => number,
  ): [Limiters, Limiters];
}

/** Whether `p` settles within `ms` (a waiting adapter polls, so give it a few rounds). */
const settledWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

/** Long enough for a polling adapter's next round (50–250 ms) and short of a test timeout. */
const WAITS = 300;
const GOES = 1_500;

/**
 * The rules every `Limiters` adapter keeps, holder to holder: the in-flight cap, the per-minute window, a 429 that
 * blocks every holder until its Retry-After, an expired lease that frees its slot, and one bucket per key.
 */
export function limiterContract(harness: LimiterHarness): ContractCase[] {
  /** A fresh name per case, so a shared store's earlier runs never count. */
  const fresh = (what: string) => `contract-${what}-${randomUUID()}`;
  const world = (name: string, config: LimiterConfig) => {
    const t = { now: 1_000_000 };
    const [a, b] = harness.make({ [name]: config }, () => t.now);
    return { a: a.get(name, name), b: b.get(name, name), t };
  };

  return [
    {
      name: 'limiter: at most inFlight slots are held across holders; a release lets the next one in',
      async run() {
        const { a, b } = world(fresh('cap'), { inFlight: 2 });
        const first = await a.acquire({ tokens: 1 });
        await b.acquire({ tokens: 1 });
        const third = b.acquire({ tokens: 1 });
        assert.equal(await settledWithin(third, WAITS), false);
        await first.release();
        assert.equal(await settledWithin(third, GOES), true);
        (await third).release();
      },
    },
    {
      name: 'limiter: calls per minute hold a sliding window across holders',
      async run() {
        const { a, b, t } = world(fresh('window'), {
          inFlight: 10,
          callsPerMinute: 2,
        });
        (await a.acquire({ tokens: 1 })).release();
        (await b.acquire({ tokens: 1 })).release();
        t.now += 1_000;
        const third = a.acquire({ tokens: 1 }, AbortSignal.timeout(WAITS));
        await assert.rejects(third);
        t.now += 60_000;
        const next = b.acquire({ tokens: 1 });
        assert.equal(await settledWithin(next, GOES), true);
        (await next).release();
      },
    },
    {
      name: 'limiter: a 429 blocks every holder until its Retry-After',
      async run() {
        const { a, b, t } = world(fresh('throttle'), { inFlight: 4 });
        const p = await a.acquire({ tokens: 1 });
        await p.release({ throttled: true, retryAfterMs: 400 });
        const blocked = b.acquire({ tokens: 1 });
        assert.equal(await settledWithin(blocked, WAITS), false);
        t.now += 401;
        assert.equal(await settledWithin(blocked, GOES), true);
        (await blocked).release();
      },
    },
    {
      name: 'limiter: a slot never released frees itself when its lease runs out, and its late release frees nothing more',
      async run() {
        const { a, b, t } = world(fresh('lease'), {
          inFlight: 1,
          leaseMs: 1_000,
        });
        const lost = await a.acquire({ tokens: 1 });
        const waiting = b.acquire({ tokens: 1 });
        assert.equal(await settledWithin(waiting, WAITS), false);
        t.now += 1_001;
        assert.equal(await settledWithin(waiting, GOES), true);
        // The crashed holder comes back: its release must not free the slot the new holder has.
        await lost.release();
        const after = a.acquire({ tokens: 1 }, AbortSignal.timeout(WAITS));
        await assert.rejects(after);
        (await waiting).release();
      },
    },
    {
      name: 'limiter: each key is its own bucket under one config (one per tenant)',
      async run() {
        const name = fresh('keys');
        const [a, b] = harness.make({ [name]: { inFlight: 1 } }, () => 1);
        const one = await a.get(name, `${name}:tenant-1`).acquire({ tokens: 1 });
        const two = b.get(name, `${name}:tenant-2`).acquire({ tokens: 1 });
        assert.equal(await settledWithin(two, GOES), true);
        const again = b
          .get(name, `${name}:tenant-1`)
          .acquire({ tokens: 1 }, AbortSignal.timeout(WAITS));
        await assert.rejects(again);
        one.release();
        (await two).release();
      },
    },
    {
      name: 'limiter: an aborted wait leaves, and takes no slot',
      async run() {
        const { a, b } = world(fresh('abort'), { inFlight: 1 });
        const held = await a.acquire({ tokens: 1 });
        const c = new AbortController();
        const waiting = b.acquire({ tokens: 1 }, c.signal);
        c.abort(new Error('gone'));
        await assert.rejects(waiting, /gone/);
        await held.release();
        const next = a.acquire({ tokens: 1 });
        assert.equal(await settledWithin(next, GOES), true);
        (await next).release();
      },
    },
  ];
}
