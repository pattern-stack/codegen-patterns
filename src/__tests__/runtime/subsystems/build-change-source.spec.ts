/**
 * buildChangeSource() unit tests (#250, ADR-033.1 b)
 *
 * Validates the mode-dispatching factory:
 *   - poll cfg → instanceof PollChangeSource
 *   - webhook cfg → instanceof WebhookChangeSource
 *   - middlewares array threaded into the constructed primitive
 *   - default empty middlewares is fine
 *   - import resolves via the integration barrel (no deep path)
 */
import { describe, expect, it } from 'bun:test';
import {
  buildChangeSource,
  PollChangeSource,
  WebhookChangeSource,
  type ChangeMiddleware,
  type DetectionConfig,
  type PollFetchCallback,
  type WebhookFetchCallback,
} from '../../../../runtime/subsystems/integration';
import type {
  Change,
  IntegrationSubscriptionView,
} from '../../../../runtime/subsystems/integration/integration-change-source.protocol';

interface PollRecord {
  external_id: string;
  modstamp: string;
}

interface WebhookRecord {
  external_id: string;
  event_id: string;
}

const subscription: IntegrationSubscriptionView = {
  id: 'sub-1',
  domain: 'opportunity',
  externalRef: 'sf-org-A',
};

// The fetch callbacks below emit ALREADY-MAPPED canonical records keyed
// `external_id`. The primitive reads `record[mapping.source]`, so `source` must
// match the emitted key (`external_id`), NOT `'Id'`/`'id'`. The original
// fixtures declared `source: 'Id'`/`'id'` while emitting `external_id` keys;
// that only passed because the pre-fix primitive read `.target` — the gap #6
// transposition this PR fixes.
function pollConfig(): DetectionConfig {
  return {
    mode: 'poll',
    poll: { cursor: { kind: 'systemModstamp', field: 'modstamp' } },
    mapping: [{ source: 'external_id', target: 'external_id' }],
    filters: [],
  } as DetectionConfig;
}

function webhookConfig(): DetectionConfig {
  return {
    mode: 'webhook',
    webhook: { eventIdField: 'event_id' },
    mapping: [{ source: 'external_id', target: 'external_id' }],
    filters: [],
  } as DetectionConfig;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('buildChangeSource — mode dispatch', () => {
  it('returns a PollChangeSource for mode: poll', () => {
    const fetch: PollFetchCallback<PollRecord> = async function* () {
      // empty
    };
    const src = buildChangeSource<PollRecord>(pollConfig(), fetch);
    expect(src).toBeInstanceOf(PollChangeSource);
  });

  it('returns a WebhookChangeSource for mode: webhook', () => {
    const fetch: WebhookFetchCallback<WebhookRecord> = async function* () {
      // empty
    };
    const src = buildChangeSource<WebhookRecord>(webhookConfig(), fetch);
    expect(src).toBeInstanceOf(WebhookChangeSource);
  });

  it('accepts a default empty middlewares array', async () => {
    const fetch: PollFetchCallback<PollRecord> = async function* () {
      yield {
        record: { external_id: 'opp-1', modstamp: '2025-01-01T00:00:00Z' },
        cursor: { ts: '2025-01-01T00:00:00Z' },
      };
    };
    const src = buildChangeSource<PollRecord>(pollConfig(), fetch);
    const changes = await collect(src.listChanges(subscription, null));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.externalId).toBe('opp-1');
  });
});

describe('buildChangeSource — middleware threading', () => {
  it('threads middlewares into the poll primitive (observed via stream)', async () => {
    const calls: string[] = [];
    const tagging: ChangeMiddleware<PollRecord> = (next) =>
      async function* (sub, cur) {
        calls.push('mw-in');
        for await (const change of next(sub, cur)) {
          calls.push('mw-out');
          yield change;
        }
      };
    const fetch: PollFetchCallback<PollRecord> = async function* () {
      yield {
        record: { external_id: 'opp-1', modstamp: '2025-01-01T00:00:00Z' },
        cursor: { ts: '2025-01-01T00:00:00Z' },
      };
    };
    const src = buildChangeSource<PollRecord>(pollConfig(), fetch, [tagging]);
    const changes = await collect(src.listChanges(subscription, null));
    expect(changes).toHaveLength(1);
    expect(calls).toEqual(['mw-in', 'mw-out']);
  });

  it('threads middlewares into the webhook primitive (observed via stream)', async () => {
    const calls: string[] = [];
    const filtering: ChangeMiddleware<WebhookRecord> = (next) =>
      async function* (sub, cur) {
        calls.push('mw-in');
        for await (const change of next(sub, cur)) {
          calls.push('mw-out');
          yield change;
        }
      };
    const fetch: WebhookFetchCallback<WebhookRecord> = async function* () {
      yield {
        record: { external_id: 'opp-1', event_id: 'evt-1' },
      };
    };
    const src = buildChangeSource<WebhookRecord>(webhookConfig(), fetch, [
      filtering,
    ]);
    const changes = await collect(src.listChanges(subscription, null));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.dedupKey).toBe('evt-1');
    expect(calls).toEqual(['mw-in', 'mw-out']);
  });

  it('composes multiple middlewares outermost-first', async () => {
    const order: string[] = [];
    const a: ChangeMiddleware<PollRecord> = (next) =>
      async function* (sub, cur) {
        order.push('a-in');
        yield* next(sub, cur);
      };
    const b: ChangeMiddleware<PollRecord> = (next) =>
      async function* (sub, cur) {
        order.push('b-in');
        yield* next(sub, cur);
      };
    const fetch: PollFetchCallback<PollRecord> = async function* () {
      // empty
    };
    const src = buildChangeSource<PollRecord>(pollConfig(), fetch, [a, b]);
    await collect(src.listChanges(subscription, null));
    expect(order).toEqual(['a-in', 'b-in']);
  });
});
