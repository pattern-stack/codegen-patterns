/**
 * emitSafely unit tests.
 *
 * emitSafely is fire-and-forget: a throwing bus must NEVER propagate (it would
 * fail the host CRUD operation). Before this fix the failure was swallowed by a
 * bare `catch` and printed via `console.warn` with no cause — these tests lock
 * in the never-throw contract AND that the cause + the distinct event types now
 * reach the Nest Logger.
 */
import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import { Logger } from '@nestjs/common';

import {
  emitSafely,
  buildLifecycleEvent,
  buildChangeEvents,
} from '../../../../runtime/base-classes/lifecycle-events';
import type {
  IEventBus,
  DomainEvent,
} from '../../../../runtime/subsystems/events/event-bus.protocol';

function makeEvent(type: string): DomainEvent {
  return {
    id: `id-${type}`,
    type,
    aggregateId: 'agg-1',
    aggregateType: 'widget',
    payload: {},
    occurredAt: new Date(),
  };
}

function makeBus(overrides: Partial<IEventBus> = {}): IEventBus {
  return {
    publish: mock(async () => undefined),
    publishMany: mock(async () => undefined),
    subscribe: mock(() => () => undefined),
    ...overrides,
  } as unknown as IEventBus;
}

afterEach(() => {
  mock.restore();
});

describe('emitSafely', () => {
  it('is a no-op when no bus is provided', async () => {
    // No throw, nothing to assert beyond completion.
    await emitSafely(undefined, [makeEvent('widget.created')]);
  });

  it('is a no-op when the event list is empty', async () => {
    const bus = makeBus();
    await emitSafely(bus, []);
    expect(bus.publish).not.toHaveBeenCalled();
    expect(bus.publishMany).not.toHaveBeenCalled();
  });

  it('publishes a single event via publish()', async () => {
    const bus = makeBus();
    const ev = makeEvent('widget.created');
    await emitSafely(bus, [ev]);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenCalledWith(ev);
    expect(bus.publishMany).not.toHaveBeenCalled();
  });

  it('publishes multiple events via publishMany()', async () => {
    const bus = makeBus();
    const events = [makeEvent('widget.created'), makeEvent('widget.field_changed')];
    await emitSafely(bus, events);
    expect(bus.publishMany).toHaveBeenCalledTimes(1);
    expect(bus.publishMany).toHaveBeenCalledWith(events);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does NOT throw when a single-event publish rejects', async () => {
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const bus = makeBus({
      publish: mock(async () => {
        throw new Error('bus is down');
      }),
    });

    // Must resolve, not reject.
    await emitSafely(bus, [makeEvent('widget.created')]);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('bus is down'); // the cause
    expect(line).toContain('widget.created'); // the event type
    expect(line).toContain('1 event(s)');
  });

  it('logs the cause and the distinct event types when publishMany rejects', async () => {
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const cause = new Error('publishMany exploded');
    const bus = makeBus({
      publishMany: mock(async () => {
        throw cause;
      }),
    });

    // Three events, two distinct types — the log must dedupe the types.
    const events = [
      makeEvent('widget.created'),
      makeEvent('widget.field_changed'),
      makeEvent('widget.field_changed'),
    ];

    await emitSafely(bus, events); // never-throw

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('publishMany exploded');
    expect(line).toContain('3 event(s)');
    expect(line).toContain('widget.created');
    expect(line).toContain('widget.field_changed');
    // Distinct, not repeated: exactly one occurrence of the duplicated type.
    expect(line.match(/widget\.field_changed/g)).toHaveLength(1);

    // Stack surfaced at debug level (available, not noisy at default threshold).
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0] ?? '')).toContain(
      'publishMany exploded',
    );
  });

  it('tolerates a non-Error throw without propagating', async () => {
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const bus = makeBus({
      publish: mock(async () => {
        throw 'string failure';
      }),
    });

    await emitSafely(bus, [makeEvent('widget.created')]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('string failure');
    // No Error ⇒ no stack ⇒ no debug follow-up.
    expect(debug).not.toHaveBeenCalled();
  });

  // The original silent failure: `domain_events_tier_routing_check` rejects a
  // domain-tier row with NULL pool/direction. With builders now stamping
  // `tier:'audit'`, such rows are constraint-legal — but emitSafely must STILL
  // swallow any genuine bus error. This bus mirrors the DB check.
  it('never throws even when the bus enforces the tier-routing invariant', async () => {
    spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    // Reproduce `domain_events_tier_routing_check`: tier:'audit' ⇔ pool/direction null.
    const enforcingPublish = (event: DomainEvent) => {
      const meta = event.metadata ?? {};
      const tier = (meta['tier'] as string | undefined) ?? 'domain';
      const routingNull = meta['pool'] == null && meta['direction'] == null;
      if ((tier === 'audit') !== routingNull) {
        throw new Error(
          'new row for relation "domain_events" violates check constraint ' +
            '"domain_events_tier_routing_check"',
        );
      }
    };
    const bus = makeBus({
      publish: mock(async (e: DomainEvent) => enforcingPublish(e)),
      publishMany: mock(async (es: DomainEvent[]) => es.forEach(enforcingPublish)),
    });

    // The builder output (audit-tier) passes the enforcing bus — no throw, no log.
    const warnSpy = spyOn(Logger.prototype, 'warn');
    await emitSafely(bus, [buildLifecycleEvent('widget', 'updated', 'agg-1')]);
    await emitSafely(bus, buildChangeEvents('widget', 'agg-1', [
      { field: 'name', oldValue: 'a', newValue: 'b' },
    ]));
    expect(warnSpy).not.toHaveBeenCalled();

    // An un-tiered (domain) row with null routing trips the constraint — but
    // emitSafely still resolves, never rejecting the host CRUD op.
    const domainTierRow: DomainEvent = {
      ...makeEvent('widget.updated'),
      metadata: { category: 'lifecycle' },
    };
    await emitSafely(bus, [domainTierRow]); // must NOT reject
  });
});

describe('event builders — AUDIT tier stamping', () => {
  it('buildLifecycleEvent stamps tier:audit (constraint-legal: no pool/direction)', () => {
    const ev = buildLifecycleEvent('widget', 'created', 'agg-1', { name: 'x' });
    expect(ev.type).toBe('widget.created');
    expect(ev.metadata?.['tier']).toBe('audit');
    expect(ev.metadata?.['category']).toBe('lifecycle');
    // Audit branch of the CHECK: pool/direction must be absent (→ NULL).
    expect(ev.metadata?.['pool']).toBeUndefined();
    expect(ev.metadata?.['direction']).toBeUndefined();
  });

  it('buildChangeEvents stamps tier:audit on every change event', () => {
    const events = buildChangeEvents('widget', 'agg-1', [
      { field: 'name', oldValue: 'a', newValue: 'b' },
      { field: 'size', oldValue: 1, newValue: 2 },
    ]);
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.type).toBe('widget.field_changed');
      expect(ev.metadata?.['tier']).toBe('audit');
      expect(ev.metadata?.['category']).toBe('change');
      expect(ev.metadata?.['pool']).toBeUndefined();
      expect(ev.metadata?.['direction']).toBeUndefined();
    }
  });
});
