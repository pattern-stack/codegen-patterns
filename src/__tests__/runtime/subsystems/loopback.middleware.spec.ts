/**
 * Unit tests for `createLoopbackMiddleware` (#226-5).
 *
 * Loopback shipped as a stock `ChangeMiddleware<T>` factory replaces the
 * orchestrator's `@Optional() INTEGRATION_LOOPBACK_FINGERPRINT_STORE` branch.
 * Coverage: matching fingerprint suppresses the change, missing
 * fingerprint passes through, and the store is consulted exactly once
 * per yielded change with the documented arguments.
 */
import { describe, it, expect } from 'bun:test';
import { createLoopbackMiddleware } from '../../../../runtime/subsystems/integration/loopback.middleware';
import type {
  Change,
  IntegrationSubscriptionView,
} from '../../../../runtime/subsystems/integration/integration-change-source.protocol';
import type { ChangeIterator } from '../../../../runtime/subsystems/integration/integration-middleware.protocol';
import type { ILoopbackFingerprintStore } from '../../../../runtime/subsystems/integration/integration-loopback.protocol';

interface CanonicalOpp extends Record<string, unknown> {
  external_id: string;
  amount?: number;
}

const SUB: IntegrationSubscriptionView = {
  id: 'sub-1',
  domain: 'opportunity',
  externalRef: null,
};

class RecordingStore implements ILoopbackFingerprintStore<CanonicalOpp> {
  readonly calls: Array<{
    entityType: string;
    externalId: string;
    record: CanonicalOpp;
  }> = [];
  constructor(private readonly echoed: Set<string>) {}
  async isEchoOfOwnWrite(
    entityType: string,
    externalId: string,
    record: CanonicalOpp,
  ): Promise<boolean> {
    this.calls.push({ entityType, externalId, record });
    return this.echoed.has(externalId);
  }
}

function makeChange(externalId: string): Change<CanonicalOpp> {
  return {
    externalId,
    operation: 'updated',
    record: { external_id: externalId, amount: 100 },
    cursor: { v: externalId },
    source: 'poll',
  };
}

function arrayInner(changes: Change<CanonicalOpp>[]): ChangeIterator<CanonicalOpp> {
  return async function* (
    _sub: IntegrationSubscriptionView,
    _cursor: unknown | null,
  ): AintegrationIterable<Change<CanonicalOpp>> {
    for (const c of changes) yield c;
  };
}

async function collect<T>(it: AintegrationIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('createLoopbackMiddleware', () => {
  it('suppresses changes whose fingerprint matches a recent local write', async () => {
    const store = new RecordingStore(new Set(['echo-1']));
    const mw = createLoopbackMiddleware<CanonicalOpp>(store);
    const inner = arrayInner([makeChange('echo-1')]);

    const wrapped = mw(inner);
    const yielded = await collect(wrapped(SUB, null));

    expect(yielded).toHaveLength(0);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toEqual({
      entityType: 'opportunity',
      externalId: 'echo-1',
      record: { external_id: 'echo-1', amount: 100 },
    });
  });

  it('passes non-matching changes through unchanged', async () => {
    const store = new RecordingStore(new Set());
    const mw = createLoopbackMiddleware<CanonicalOpp>(store);
    const change = makeChange('ext-1');
    const inner = arrayInner([change]);

    const yielded = await collect(mw(inner)(SUB, null));

    expect(yielded).toHaveLength(1);
    expect(yielded[0]).toBe(change);
  });

  it('mixes pass-through + suppression in stream order', async () => {
    const store = new RecordingStore(new Set(['echo-1']));
    const mw = createLoopbackMiddleware<CanonicalOpp>(store);
    const inner = arrayInner([
      makeChange('a'),
      makeChange('echo-1'),
      makeChange('b'),
    ]);

    const yielded = await collect(mw(inner)(SUB, null));

    expect(yielded.map((c) => c.externalId)).toEqual(['a', 'b']);
    // Store consulted once per yielded change in order.
    expect(store.calls.map((c) => c.externalId)).toEqual([
      'a',
      'echo-1',
      'b',
    ]);
  });

  it('uses subscription.domain as the entityType argument to the store', async () => {
    const store = new RecordingStore(new Set());
    const mw = createLoopbackMiddleware<CanonicalOpp>(store);
    const inner = arrayInner([makeChange('ext-1')]);

    await collect(
      mw(inner)({ id: 'sub-9', domain: 'account', externalRef: null }, null),
    );

    expect(store.calls[0].entityType).toBe('account');
  });
});
