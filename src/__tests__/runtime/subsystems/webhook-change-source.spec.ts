/**
 * WebhookChangeSource<T> unit tests (#226-4)
 *
 * Validates the webhook-mode primitive: a `DetectionConfig`-parameterized
 * `IChangeSource<T>` that iterates a consumer-owned inbound staging queue
 * and emits canonical `Change<T>` records with `source: 'webhook'` and a
 * `dedupKey` populated from the configured `webhook.eventIdField`.
 *
 * Key invariants under test:
 *   - constructor accepts `{ queue, config, middlewares? }`
 *   - `listChanges(subscription, cursor)` yields `Change<T>` with
 *     `source: 'webhook'`, `dedupKey` from the configured event-id field
 *   - empty-queue iteration yields nothing
 *   - errors thrown by the queue iterator surface to the consumer
 *   - the primitive does NOT synchronously drive the orchestrator —
 *     it is a passive iterator over the consumer-owned queue
 *   - middleware composition works the same shape as PollChangeSource
 *   - constructor rejects a non-webhook config
 */
import { describe, expect, it } from 'bun:test';
import {
  WebhookChangeSource,
  type WebhookFetchCallback,
  type WebhookFetchContext,
} from '../../../../runtime/subsystems/integration/webhook-change-source';
import type { IntegrationSubscriptionView } from '../../../../runtime/subsystems/integration/integration-change-source.protocol';
import type { ChangeMiddleware } from '../../../../runtime/subsystems/integration/integration-middleware.protocol';
import type { DetectionConfig } from '../../../../runtime/subsystems/integration/detection-config.schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface WebhookRecord {
  external_id: string;
  name: string;
  event_id: string;
}

const subscription: IntegrationSubscriptionView = {
  id: 'sub-webhook-1',
  domain: 'opportunity',
  externalRef: 'sf-org-A',
};

function makeWebhookConfig(extra?: Partial<DetectionConfig>): DetectionConfig {
  return {
    mode: 'webhook',
    webhook: {
      eventIdField: 'event_id',
    },
    // The queue yields ALREADY-MAPPED canonical records keyed by the mapping
    // `source` (the field on the emitted record). These fixtures emit records
    // keyed `external_id`/`name`, so `source` must match those keys — the
    // primitive reads `record[source]`, NOT `record[target]`. (The original
    // fixtures declared `source: 'id'`/`'Name'` while emitting `external_id`;
    // that only passed because the pre-fix primitive read `.target` — the gap
    // #6 transposition. Aligned here so the fixture exercises the real path.)
    mapping: [
      { source: 'external_id', target: 'external_id' },
      { source: 'name', target: 'name' },
    ],
    filters: [],
    ...(extra as object),
  } as DetectionConfig;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// Empty queue
// ---------------------------------------------------------------------------

describe('WebhookChangeSource — empty queue', () => {
  it('yields no changes when the queue is empty', async () => {
    const queue: WebhookFetchCallback<WebhookRecord> = async function* () {
      // empty
    };
    const src = new WebhookChangeSource<WebhookRecord>({
      queue,
      config: makeWebhookConfig(),
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Event-id dedup
// ---------------------------------------------------------------------------

describe('WebhookChangeSource — event-id dedup', () => {
  it('populates Change.dedupKey from the configured eventIdField on the record', async () => {
    const queue: WebhookFetchCallback<WebhookRecord> = async function* () {
      yield {
        record: { external_id: 'A1', name: 'Alpha', event_id: 'evt_001' },
      };
      yield {
        record: { external_id: 'A2', name: 'Beta', event_id: 'evt_002' },
      };
    };
    const src = new WebhookChangeSource<WebhookRecord>({
      queue,
      config: makeWebhookConfig(),
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe('webhook');
    expect(out[0].dedupKey).toBe('evt_001');
    expect(out[0].externalId).toBe('A1');
    expect(out[1].dedupKey).toBe('evt_002');
  });

  it('throws if a record is missing the configured eventIdField', async () => {
    const queue: WebhookFetchCallback<WebhookRecord> = async function* () {
      yield {
        record: { external_id: 'A1', name: 'Alpha' } as WebhookRecord,
      };
    };
    const src = new WebhookChangeSource<WebhookRecord>({
      queue,
      config: makeWebhookConfig(),
    });
    await expect(
      (async () => {
        for await (const _c of src.listChanges(subscription, null)) {
          // drain
        }
      })(),
    ).rejects.toThrow(/event_id/);
  });

  it('forwards subscription + cursor to the queue iterator context', async () => {
    let seen: WebhookFetchContext | undefined;
    const queue: WebhookFetchCallback<WebhookRecord> = async function* (ctx) {
      seen = ctx;
    };
    const src = new WebhookChangeSource<WebhookRecord>({
      queue,
      config: makeWebhookConfig(),
    });
    await collect(src.listChanges(subscription, { lastTs: 'x' }));
    expect(seen).toBeDefined();
    expect(seen!.subscription.id).toBe('sub-webhook-1');
    expect(seen!.cursor).toEqual({ lastTs: 'x' });
  });
});

// ---------------------------------------------------------------------------
// camelCase canonical record — externalId read via mapping.source, not target
//
// Regression for the externalId mapping transposition (gap #6, swe-brain
// dogfood — the first real exercise of WebhookChangeSource). The constructor
// must read the emitted record off the mapping's `source` (the field on the
// emitted record), NOT its `target` (the canonical column). The two diverge
// whenever the canonical record is vendor-neutral camelCase: a consumer that
// emits records keyed `externalId` with `mapping: [{ source: 'externalId',
// target: 'external_id' }]` and NO `external_id` key on the record. The bug
// (`.target`) made the primitive look up `record['external_id']` → undefined →
// "record missing string 'external_id'", rendering the primitive unusable for
// any camelCase-canonical consumer. The original fixtures masked it because
// they keyed records `external_id` (== the target), so source vs. target never
// diverged.
// ---------------------------------------------------------------------------

interface CamelCaseRecord {
  externalId: string;
  name: string;
}

describe('WebhookChangeSource — camelCase canonical record (mapping.source)', () => {
  function makeCamelConfig(): DetectionConfig {
    return {
      mode: 'webhook',
      // The eventIdField IS the externalId field here — the swe-brain shape,
      // where the canonical event id and external id are the same camelCase key.
      webhook: { eventIdField: 'externalId' },
      mapping: [{ source: 'externalId', target: 'external_id' }],
      filters: [],
    } as DetectionConfig;
  }

  it('reads externalId off the record via mapping.source (record has NO external_id key)', async () => {
    const queue: WebhookFetchCallback<CamelCaseRecord> = async function* () {
      // Note: keyed `externalId` only — there is deliberately NO `external_id`
      // key on the record. The buggy `.target` lookup would throw here.
      yield { record: { externalId: 'gh:123', name: 'Alpha' } };
    };
    const src = new WebhookChangeSource<CamelCaseRecord>({
      queue,
      config: makeCamelConfig(),
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('webhook');
    expect(out[0].externalId).toBe('gh:123');
    expect(out[0].dedupKey).toBe('gh:123');
    // Sanity: the emitted record carries no `external_id` key whatsoever, so a
    // passing assertion proves the primitive resolved via `.source`.
    expect(
      (out[0].record as Record<string, unknown>).external_id,
    ).toBeUndefined();
  });

  it('throws naming the mapping source field when the record is missing it', async () => {
    const queue: WebhookFetchCallback<CamelCaseRecord> = async function* () {
      yield { record: { name: 'Alpha' } as unknown as CamelCaseRecord };
    };
    const src = new WebhookChangeSource<CamelCaseRecord>({
      queue,
      config: makeCamelConfig(),
    });
    await expect(
      (async () => {
        for await (const _c of src.listChanges(subscription, null)) {
          // drain
        }
      })(),
    ).rejects.toThrow(/externalId/);
  });
});

// ---------------------------------------------------------------------------
// Queue errors
// ---------------------------------------------------------------------------

describe('WebhookChangeSource — queue errors', () => {
  it('propagates errors thrown by the queue iterator', async () => {
    const boom: WebhookFetchCallback<WebhookRecord> = async function* () {
      throw new Error('queue offline');
    };
    const src = new WebhookChangeSource<WebhookRecord>({
      queue: boom,
      config: makeWebhookConfig(),
    });
    await expect(
      (async () => {
        for await (const _c of src.listChanges(subscription, null)) {
          // drain
        }
      })(),
    ).rejects.toThrow(/queue offline/);
  });
});

// ---------------------------------------------------------------------------
// Middleware composition
// ---------------------------------------------------------------------------

describe('WebhookChangeSource — middleware composition', () => {
  it('composes middlewares the same shape as PollChangeSource (first = outermost)', async () => {
    const order: string[] = [];
    const tag =
      (label: string): ChangeMiddleware<WebhookRecord> =>
      (next) =>
      async function* (sub, cur) {
        order.push(`${label}:enter`);
        for await (const c of next(sub, cur)) {
          order.push(`${label}:yield`);
          yield c;
        }
        order.push(`${label}:exit`);
      };
    const queue: WebhookFetchCallback<WebhookRecord> = async function* () {
      yield {
        record: { external_id: 'A', name: 'a', event_id: 'evt_1' },
      };
    };
    const src = new WebhookChangeSource<WebhookRecord>({
      queue,
      config: makeWebhookConfig(),
      middlewares: [tag('outer'), tag('inner')],
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out).toHaveLength(1);
    expect(order).toEqual([
      'outer:enter',
      'inner:enter',
      'inner:yield',
      'outer:yield',
      'inner:exit',
      'outer:exit',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Construction guard
// ---------------------------------------------------------------------------

describe('WebhookChangeSource — construction', () => {
  it('rejects a non-webhook config', () => {
    const pollConfig: DetectionConfig = {
      mode: 'poll',
      poll: { cursor: { kind: 'systemModstamp', field: 'm' } },
      mapping: [{ source: 'Id', target: 'external_id' }],
      filters: [],
    };
    expect(
      () =>
        new WebhookChangeSource<WebhookRecord>({
          queue: async function* () {},
          config: pollConfig,
        }),
    ).toThrow(/webhook/);
  });

  it('exposes a label for run logs', () => {
    const src = new WebhookChangeSource<WebhookRecord>({
      queue: async function* () {},
      config: makeWebhookConfig(),
      label: 'stripe-webhook-charge',
    });
    expect(src.label).toBe('stripe-webhook-charge');
  });

  it('falls back to a default label when not provided', () => {
    const src = new WebhookChangeSource<WebhookRecord>({
      queue: async function* () {},
      config: makeWebhookConfig(),
    });
    expect(typeof src.label).toBe('string');
    expect(src.label.length).toBeGreaterThan(0);
  });
});

// Compile-time guard: WebhookFetchContext must NOT include userId/tenantId.
const _shapeGuard: WebhookFetchContext = {
  subscription,
  cursor: null,
};
void _shapeGuard;
