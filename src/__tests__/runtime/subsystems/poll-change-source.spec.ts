/**
 * PollChangeSource<T> unit tests (#226-3)
 *
 * Validates the poll-mode primitive: a `DetectionConfig`-parameterized
 * `IChangeSource<T>` that delegates the actual fetch to a consumer
 * callback (`PollFetchCallback<T>`) and emits canonical `Change<T>`
 * records with `source: 'poll'`.
 *
 * Key invariants under test:
 *   - constructor accepts `{ adapter, config, middlewares? }`
 *   - `listChanges(subscription, cursor)` yields `Change<T>` with
 *     `source: 'poll'`, advancing cursor as the adapter yields
 *   - `PollFetchContext` is exactly `{ subscription, cursor, filters }`
 *     (Q5 lock — no `userId`/`tenantId`)
 *   - filters resolved from `DetectionConfig` are forwarded to the callback
 *   - field mapping resolves `external_id` on emitted records
 *   - middleware chain composes left-to-right (first middleware = outermost)
 *   - errors thrown by the callback propagate to the iterator consumer
 */
import { describe, it, expect } from 'bun:test';
import {
  PollChangeSource,
  type PollFetchCallback,
  type PollFetchContext,
} from '../../../../runtime/subsystems/sync/poll-change-source';
import type {
  Change,
  SyncSubscriptionView,
} from '../../../../runtime/subsystems/sync/sync-change-source.protocol';
import type { ChangeMiddleware } from '../../../../runtime/subsystems/sync/sync-middleware.protocol';
import type { DetectionConfig } from '../../../../runtime/subsystems/sync/detection-config.schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface OppRecord {
  external_id: string;
  name: string;
  modstamp: string;
}

const subscription: SyncSubscriptionView = {
  id: 'sub-1',
  domain: 'opportunity',
  externalRef: 'sf-org-A',
};

function makeConfig(extra?: Partial<DetectionConfig>): DetectionConfig {
  return {
    mode: 'poll',
    poll: {
      cursor: { kind: 'systemModstamp', field: 'modstamp' },
    },
    mapping: [
      { source: 'Id', target: 'external_id' },
      { source: 'Name', target: 'name' },
    ],
    filters: [{ field: 'StageName', op: 'eq', value: 'Won' }],
    ...(extra as object),
  } as DetectionConfig;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// Empty cursor (first run)
// ---------------------------------------------------------------------------

describe('PollChangeSource — empty cursor (first run)', () => {
  it('passes cursor: null through to the adapter', async () => {
    let seen: PollFetchContext | undefined;
    const adapter: PollFetchCallback<OppRecord> = async function* (ctx) {
      seen = ctx;
      // first run: nothing to yield
    };
    const src = new PollChangeSource<OppRecord>({
      adapter,
      config: makeConfig(),
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toEqual([]);
    expect(seen).toBeDefined();
    expect(seen!.cursor).toBeNull();
    expect(seen!.subscription.id).toBe('sub-1');
  });
});

// ---------------------------------------------------------------------------
// Advancing cursor
// ---------------------------------------------------------------------------

describe('PollChangeSource — advancing cursor', () => {
  it('yields Change<T> records with source: "poll" and cursor from callback', async () => {
    const adapter: PollFetchCallback<OppRecord> = async function* () {
      yield {
        record: { external_id: 'A1', name: 'Alpha', modstamp: '2026-04-01T00:00:00Z' },
        cursor: { systemModstamp: '2026-04-01T00:00:00Z' },
      };
      yield {
        record: { external_id: 'A2', name: 'Beta', modstamp: '2026-04-02T00:00:00Z' },
        cursor: { systemModstamp: '2026-04-02T00:00:00Z' },
      };
    };
    const src = new PollChangeSource<OppRecord>({
      adapter,
      config: makeConfig(),
    });
    const out = await collect(src.listChanges(subscription, { systemModstamp: '2026-03-31T00:00:00Z' }));
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe('poll');
    expect(out[0].externalId).toBe('A1');
    expect(out[0].operation).toBe('updated');
    expect(out[0].record.name).toBe('Alpha');
    expect(out[0].cursor).toEqual({ systemModstamp: '2026-04-01T00:00:00Z' });
    expect(out[1].externalId).toBe('A2');
    expect(out[1].cursor).toEqual({ systemModstamp: '2026-04-02T00:00:00Z' });
  });

  it('forwards prior cursor by-value to the adapter context', async () => {
    let seen: PollFetchContext | undefined;
    const adapter: PollFetchCallback<OppRecord> = async function* (ctx) {
      seen = ctx;
    };
    const src = new PollChangeSource<OppRecord>({
      adapter,
      config: makeConfig(),
    });
    const cursor = { systemModstamp: '2026-04-10T12:00:00Z' };
    await collect(src.listChanges(subscription, cursor));
    expect(seen!.cursor).toEqual(cursor);
  });
});

// ---------------------------------------------------------------------------
// Filter passthrough
// ---------------------------------------------------------------------------

describe('PollChangeSource — filter passthrough', () => {
  it('forwards resolved filters from DetectionConfig to the callback', async () => {
    let seen: PollFetchContext | undefined;
    const adapter: PollFetchCallback<OppRecord> = async function* (ctx) {
      seen = ctx;
    };
    const config = makeConfig();
    const src = new PollChangeSource<OppRecord>({ adapter, config });
    await collect(src.listChanges(subscription, null));
    expect(seen!.filters).toEqual([
      { field: 'StageName', op: 'eq', value: 'Won' },
    ]);
  });

  it('forwards an empty filter array when none are configured', async () => {
    let seen: PollFetchContext | undefined;
    const adapter: PollFetchCallback<OppRecord> = async function* (ctx) {
      seen = ctx;
    };
    const config: DetectionConfig = {
      mode: 'poll',
      poll: { cursor: { kind: 'systemModstamp', field: 'modstamp' } },
      mapping: [{ source: 'Id', target: 'external_id' }],
      filters: [],
    };
    const src = new PollChangeSource<OppRecord>({ adapter, config });
    await collect(src.listChanges(subscription, null));
    expect(seen!.filters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe('PollChangeSource — field mapping', () => {
  it('uses the mapping target "external_id" to populate Change.externalId', async () => {
    const adapter: PollFetchCallback<OppRecord> = async function* () {
      yield {
        record: { external_id: 'OPP-42', name: 'Mapped', modstamp: 't' },
        cursor: { systemModstamp: 't' },
      };
    };
    const src = new PollChangeSource<OppRecord>({
      adapter,
      config: makeConfig(),
    });
    const [change] = await collect(src.listChanges(subscription, null));
    expect(change.externalId).toBe('OPP-42');
  });

  it('throws if the mapping declares no external_id target', () => {
    const config = {
      mode: 'poll' as const,
      poll: { cursor: { kind: 'systemModstamp' as const, field: 'modstamp' } },
      mapping: [{ source: 'Name', target: 'name' }],
      filters: [],
    };
    expect(
      () =>
        new PollChangeSource<OppRecord>({
          adapter: async function* () {},
          config,
        }),
    ).toThrow(/external_id/);
  });
});

// ---------------------------------------------------------------------------
// Middleware composition
// ---------------------------------------------------------------------------

describe('PollChangeSource — middleware composition', () => {
  it('composes middlewares in order: first = outermost', async () => {
    const order: string[] = [];

    const tag =
      (label: string): ChangeMiddleware<OppRecord> =>
      (next) =>
      async function* (sub, cur) {
        order.push(`${label}:enter`);
        for await (const c of next(sub, cur)) {
          order.push(`${label}:yield`);
          yield c;
        }
        order.push(`${label}:exit`);
      };

    const adapter: PollFetchCallback<OppRecord> = async function* () {
      yield {
        record: { external_id: 'A', name: 'a', modstamp: 't' },
        cursor: { systemModstamp: 't' },
      };
    };

    const src = new PollChangeSource<OppRecord>({
      adapter,
      config: makeConfig(),
      middlewares: [tag('outer'), tag('inner')],
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toHaveLength(1);
    // outer enters first, inner enters second; on yield inner sees first then outer
    expect(order).toEqual([
      'outer:enter',
      'inner:enter',
      'inner:yield',
      'outer:yield',
      'inner:exit',
      'outer:exit',
    ]);
  });

  it('lets a middleware filter out a change', async () => {
    const dropAll: ChangeMiddleware<OppRecord> =
      (next) =>
      async function* (sub, cur) {
        for await (const _c of next(sub, cur)) {
          // drop
        }
      };
    const adapter: PollFetchCallback<OppRecord> = async function* () {
      yield {
        record: { external_id: 'A', name: 'a', modstamp: 't' },
        cursor: { systemModstamp: 't' },
      };
    };
    const src = new PollChangeSource<OppRecord>({
      adapter,
      config: makeConfig(),
      middlewares: [dropAll],
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('PollChangeSource — adapter errors', () => {
  it('propagates errors thrown by the callback', async () => {
    const boom: PollFetchCallback<OppRecord> = async function* () {
      throw new Error('upstream 503');
    };
    const src = new PollChangeSource<OppRecord>({
      adapter: boom,
      config: makeConfig(),
    });
    await expect(
      (async () => {
        for await (const _c of src.listChanges(subscription, null)) {
          // drain
        }
      })(),
    ).rejects.toThrow(/upstream 503/);
  });
});

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

describe('PollChangeSource — label', () => {
  it('exposes a label for run logs', () => {
    const src = new PollChangeSource<OppRecord>({
      adapter: async function* () {},
      config: makeConfig(),
      label: 'salesforce-poll-opportunity',
    });
    expect(src.label).toBe('salesforce-poll-opportunity');
  });

  it('falls back to a default label when not provided', () => {
    const src = new PollChangeSource<OppRecord>({
      adapter: async function* () {},
      config: makeConfig(),
    });
    expect(typeof src.label).toBe('string');
    expect(src.label.length).toBeGreaterThan(0);
  });
});

// Compile-time guard: PollFetchContext must NOT include userId/tenantId.
// This is a structural assertion via TypeScript — if the shape grows
// these fields the line below stops compiling.
const _shapeGuard: PollFetchContext = {
  subscription,
  cursor: null,
  filters: [],
};
void _shapeGuard;
