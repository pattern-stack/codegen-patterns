/**
 * Event bus unit tests
 *
 * Tests MemoryEventBus in isolation (no database).
 * DrizzleEventBus public-API behaviour is verified in the integration test.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryEventBus } from '../../../../runtime/subsystems/events/event-bus.memory-backend';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

// ============================================================================
// Helpers
// ============================================================================

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'test-id-1',
    type: 'test_event',
    aggregateId: 'agg-1',
    aggregateType: 'test',
    payload: { foo: 'bar' },
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ============================================================================
// MemoryEventBus
// ============================================================================

describe('MemoryEventBus', () => {
  let bus: MemoryEventBus;

  beforeEach(() => {
    bus = new MemoryEventBus();
  });

  // --------------------------------------------------------------------------
  // publish
  // --------------------------------------------------------------------------
  describe('publish', () => {
    it('stores the event in publishedEvents', async () => {
      const event = makeEvent();
      await bus.publish(event);
      expect(bus.publishedEvents).toHaveLength(1);
      expect(bus.publishedEvents[0]).toBe(event);
    });

    it('accumulates multiple events in order', async () => {
      const a = makeEvent({ id: '1', type: 'a' });
      const b = makeEvent({ id: '2', type: 'b' });
      await bus.publish(a);
      await bus.publish(b);
      expect(bus.publishedEvents).toHaveLength(2);
      expect(bus.publishedEvents[0].id).toBe('1');
      expect(bus.publishedEvents[1].id).toBe('2');
    });

    it('dispatches to a registered handler synchronously', async () => {
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });

      const event = makeEvent();
      await bus.publish(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    it('does not dispatch to handlers for different event types', async () => {
      const received: DomainEvent[] = [];
      bus.subscribe('other_event', async (e) => { received.push(e); });

      await bus.publish(makeEvent({ type: 'test_event' }));

      expect(received).toHaveLength(0);
    });

    it('ignores the tx parameter (memory backend is transaction-free)', async () => {
      // Passing undefined as tx should still work without error
      const event = makeEvent();
      await expect(bus.publish(event, undefined)).resolves.toBeUndefined();
      expect(bus.publishedEvents).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // publishMany
  // --------------------------------------------------------------------------
  describe('publishMany', () => {
    it('publishes all events and stores them in order', async () => {
      const events = [
        makeEvent({ id: '1', type: 'a' }),
        makeEvent({ id: '2', type: 'b' }),
        makeEvent({ id: '3', type: 'c' }),
      ];
      await bus.publishMany(events);
      expect(bus.publishedEvents).toHaveLength(3);
      expect(bus.publishedEvents.map((e) => e.id)).toEqual(['1', '2', '3']);
    });

    it('dispatches each event to the matching handler', async () => {
      const received: string[] = [];
      bus.subscribe('a', async (e) => { received.push(e.id); });
      bus.subscribe('b', async (e) => { received.push(e.id); });

      await bus.publishMany([
        makeEvent({ id: '1', type: 'a' }),
        makeEvent({ id: '2', type: 'b' }),
      ]);

      expect(received).toEqual(['1', '2']);
    });

    it('is a no-op for an empty array', async () => {
      await expect(bus.publishMany([])).resolves.toBeUndefined();
      expect(bus.publishedEvents).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // subscribe / unsubscribe
  // --------------------------------------------------------------------------
  describe('subscribe', () => {
    it('returns an unsubscribe function', () => {
      const unsubscribe = bus.subscribe('test_event', async () => {});
      expect(typeof unsubscribe).toBe('function');
    });

    it('calling unsubscribe stops delivery', async () => {
      const received: DomainEvent[] = [];
      const unsubscribe = bus.subscribe('test_event', async (e) => { received.push(e); });

      await bus.publish(makeEvent());
      unsubscribe();
      await bus.publish(makeEvent({ id: 'second' }));

      expect(received).toHaveLength(1);
    });

    it('multiple handlers for the same type all receive events', async () => {
      const calls: string[] = [];
      bus.subscribe('test_event', async () => { calls.push('h1'); });
      bus.subscribe('test_event', async () => { calls.push('h2'); });

      await bus.publish(makeEvent());

      expect(calls).toContain('h1');
      expect(calls).toContain('h2');
    });

    it('removing one handler does not affect others', async () => {
      const calls: string[] = [];
      const unsub = bus.subscribe('test_event', async () => { calls.push('h1'); });
      bus.subscribe('test_event', async () => { calls.push('h2'); });

      unsub();
      await bus.publish(makeEvent());

      expect(calls).not.toContain('h1');
      expect(calls).toContain('h2');
    });
  });

  // --------------------------------------------------------------------------
  // clear
  // --------------------------------------------------------------------------
  describe('clear', () => {
    it('empties publishedEvents', async () => {
      await bus.publish(makeEvent());
      bus.clear();
      expect(bus.publishedEvents).toHaveLength(0);
    });

    it('removes all subscriptions so events are no longer dispatched', async () => {
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });
      bus.clear();

      await bus.publish(makeEvent());

      // Event stored but handler was cleared
      expect(bus.publishedEvents).toHaveLength(1);
      expect(received).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // metadata
  // --------------------------------------------------------------------------
  describe('DomainEvent shape', () => {
    it('preserves all event fields', async () => {
      const event: DomainEvent = {
        id: 'uuid-1',
        type: 'contact_created',
        aggregateId: 'contact-99',
        aggregateType: 'contact',
        payload: { contactId: 'contact-99', accountId: 'acc-1' },
        occurredAt: new Date('2026-01-01T12:00:00Z'),
        metadata: { queue: 'domain-events', source: 'test' },
      };

      await bus.publish(event);

      const stored = bus.publishedEvents[0];
      expect(stored.id).toBe('uuid-1');
      expect(stored.type).toBe('contact_created');
      expect(stored.aggregateId).toBe('contact-99');
      expect(stored.aggregateType).toBe('contact');
      expect(stored.payload).toEqual({ contactId: 'contact-99', accountId: 'acc-1' });
      expect(stored.occurredAt).toEqual(new Date('2026-01-01T12:00:00Z'));
      expect(stored.metadata).toEqual({ queue: 'domain-events', source: 'test' });
    });

    it('allows optional metadata to be absent', async () => {
      const event = makeEvent(); // no metadata
      await bus.publish(event);
      expect(bus.publishedEvents[0].metadata).toBeUndefined();
    });
  });
});
