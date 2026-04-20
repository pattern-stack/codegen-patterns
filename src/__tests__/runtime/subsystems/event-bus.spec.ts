/**
 * Event bus unit tests
 *
 * Tests MemoryEventBus in isolation (no database).
 * DrizzleEventBus is tested with a mock Drizzle client (no Docker
 * required). Integration round-trip tests live in
 * `test/scaffold/tests/event-bus.test.ts` (SCAFFOLD_INTEGRATION=1).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MemoryEventBus } from '../../../../runtime/subsystems/events/event-bus.memory-backend';
import { DrizzleEventBus } from '../../../../runtime/subsystems/events/event-bus.drizzle-backend';
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

    it('a throwing handler does not prevent other handlers from receiving the event', async () => {
      const received: string[] = [];
      bus.subscribe('test_event', async () => {
        throw new Error('handler 1 failed');
      });
      bus.subscribe('test_event', async () => {
        received.push('h2');
      });

      // publish should throw (first error re-thrown) but h2 still ran
      await expect(bus.publish(makeEvent())).rejects.toThrow('handler 1 failed');
      expect(received).toContain('h2');
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

// ============================================================================
// MemoryEventBus — pool awareness (EVT-5)
// ============================================================================

describe('MemoryEventBus — pool awareness', () => {
  // --------------------------------------------------------------------------
  // publishedEventsForPool / publishedEventsForDirection helpers
  // --------------------------------------------------------------------------
  describe('publishedEventsForPool', () => {
    it('returns only events whose metadata.pool matches', async () => {
      const bus = new MemoryEventBus();
      await bus.publish(makeEvent({ id: '1', metadata: { pool: 'events_change' } }));
      await bus.publish(makeEvent({ id: '2', metadata: { pool: 'events_inbound' } }));
      await bus.publish(makeEvent({ id: '3', metadata: { pool: 'events_change' } }));

      const changeEvents = bus.publishedEventsForPool('events_change');
      expect(changeEvents).toHaveLength(2);
      expect(changeEvents.map((e) => e.id)).toEqual(['1', '3']);
    });

    it('returns an empty array when no events match the pool', async () => {
      const bus = new MemoryEventBus();
      await bus.publish(makeEvent({ metadata: { pool: 'events_inbound' } }));
      expect(bus.publishedEventsForPool('events_change')).toEqual([]);
    });
  });

  describe('publishedEventsForDirection', () => {
    it('returns only inbound events', async () => {
      const bus = new MemoryEventBus();
      await bus.publish(makeEvent({ id: '1', metadata: { direction: 'inbound' } }));
      await bus.publish(makeEvent({ id: '2', metadata: { direction: 'change' } }));
      await bus.publish(makeEvent({ id: '3', metadata: { direction: 'inbound' } }));

      const inbound = bus.publishedEventsForDirection('inbound');
      expect(inbound).toHaveLength(2);
      expect(inbound.map((e) => e.id)).toEqual(['1', '3']);
    });

    it('returns only outbound events', async () => {
      const bus = new MemoryEventBus();
      await bus.publish(makeEvent({ id: '1', metadata: { direction: 'outbound' } }));
      await bus.publish(makeEvent({ id: '2', metadata: { direction: 'change' } }));

      const outbound = bus.publishedEventsForDirection('outbound');
      expect(outbound).toHaveLength(1);
      expect(outbound[0].id).toBe('1');
    });
  });

  // --------------------------------------------------------------------------
  // pool-filtered dispatch
  // --------------------------------------------------------------------------
  describe('pool-filtered dispatch', () => {
    it('stores events outside the configured pool but does NOT dispatch them', async () => {
      const bus = new MemoryEventBus({ backend: 'memory', pools: ['events_change'] });
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });

      const outOfPool = makeEvent({ id: 'oop', metadata: { pool: 'events_inbound' } });
      await bus.publish(outOfPool);

      // Recorded for assertions, but handler never ran.
      expect(bus.publishedEvents).toHaveLength(1);
      expect(bus.publishedEvents[0]).toBe(outOfPool);
      expect(received).toHaveLength(0);
    });

    it('dispatches events whose pool is in the configured list', async () => {
      const bus = new MemoryEventBus({ backend: 'memory', pools: ['events_change'] });
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });

      const inPool = makeEvent({ metadata: { pool: 'events_change' } });
      await bus.publish(inPool);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(inPool);
    });

    it('dispatches all events when pools is undefined (backwards-compat)', async () => {
      const bus = new MemoryEventBus(); // no opts
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });

      await bus.publish(makeEvent({ id: '1', metadata: { pool: 'events_change' } }));
      await bus.publish(makeEvent({ id: '2', metadata: { pool: 'events_inbound' } }));
      await bus.publish(makeEvent({ id: '3' })); // no metadata

      expect(received).toHaveLength(3);
    });

    it('treats an empty pools array as "no filter" (matches DrizzleEventBus)', async () => {
      // DrizzleEventBus's WHERE uses `pools && pools.length > 0`, so an
      // empty array drops to the status-only predicate and drains
      // everything. MemoryEventBus mirrors that semantic.
      const bus = new MemoryEventBus({ backend: 'memory', pools: [] });
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });

      await bus.publish(makeEvent({ id: '1', metadata: { pool: 'events_change' } }));
      await bus.publish(makeEvent({ id: '2', metadata: { pool: 'events_inbound' } }));

      expect(received).toHaveLength(2);
    });

    it('does NOT dispatch events without metadata when pools is set', async () => {
      const bus = new MemoryEventBus({ backend: 'memory', pools: ['events_change'] });
      const received: DomainEvent[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e); });

      await bus.publish(makeEvent()); // no metadata at all

      expect(bus.publishedEvents).toHaveLength(1); // still recorded
      expect(received).toHaveLength(0);           // but not dispatched
    });

    it('publishMany filters per-event: only matching-pool events dispatch', async () => {
      const bus = new MemoryEventBus({ backend: 'memory', pools: ['events_change'] });
      const received: string[] = [];
      bus.subscribe('test_event', async (e) => { received.push(e.id); });

      await bus.publishMany([
        makeEvent({ id: 'a', metadata: { pool: 'events_change' } }),
        makeEvent({ id: 'b', metadata: { pool: 'events_inbound' } }),
        makeEvent({ id: 'c', metadata: { pool: 'events_change' } }),
        makeEvent({ id: 'd', metadata: { pool: 'events_outbound' } }),
      ]);

      // All four are recorded; only two matching dispatched.
      expect(bus.publishedEvents).toHaveLength(4);
      expect(received).toEqual(['a', 'c']);
    });

    it('clear() resets publishedEvents after pool-filtered publishes', async () => {
      const bus = new MemoryEventBus({ backend: 'memory', pools: ['events_change'] });
      await bus.publish(makeEvent({ metadata: { pool: 'events_change' } }));
      await bus.publish(makeEvent({ metadata: { pool: 'events_inbound' } }));
      expect(bus.publishedEvents).toHaveLength(2);

      bus.clear();
      expect(bus.publishedEvents).toHaveLength(0);
    });
  });
});

// ============================================================================
// DrizzleEventBus (mocked Drizzle client — no Docker)
// ============================================================================

describe('DrizzleEventBus', () => {
  /**
   * Build a minimal Drizzle-shaped mock that captures insert/select calls.
   * Good enough to verify the publish() column mapping and the
   * processBatch() WHERE-clause composition.
   */
  function makeMockDb() {
    const insertBuilder = {
      values: mock(async (_args: unknown) => []),
    };

    // Fluent select builder: select().from().where().orderBy().limit().for()
    // — the terminal `.for(...)` awaits to rows.
    const selectRows: unknown[] = [];
    const selectState: {
      whereArg: unknown;
      orderByArg: unknown;
      limitArg: number | undefined;
      forArgs: unknown[];
    } = { whereArg: undefined, orderByArg: undefined, limitArg: undefined, forArgs: [] };

    const selectBuilder = {
      from: mock(() => selectBuilder),
      where: mock((arg: unknown) => {
        selectState.whereArg = arg;
        return selectBuilder;
      }),
      orderBy: mock((arg: unknown) => {
        selectState.orderByArg = arg;
        return selectBuilder;
      }),
      limit: mock((n: number) => {
        selectState.limitArg = n;
        return selectBuilder;
      }),
      for: mock((...args: unknown[]) => {
        selectState.forArgs = args;
        return Promise.resolve(selectRows);
      }),
    };

    const updateBuilder = {
      set: mock(() => updateBuilder),
      where: mock(async () => []),
    };

    const db = {
      insert: mock(() => insertBuilder),
      select: mock(() => selectBuilder),
      update: mock(() => updateBuilder),
      transaction: mock(async (cb: (tx: unknown) => Promise<unknown>) => {
        // The drain runs its select inside a transaction; hand the same
        // fluent builder to the callback.
        return cb({
          select: () => selectBuilder,
        });
      }),
    };

    return { db, insertBuilder, selectBuilder, selectState, updateBuilder };
  }

  // --------------------------------------------------------------------------
  // publish — pool/direction/tenantId column population (EVT-4)
  // --------------------------------------------------------------------------
  describe('publish — metadata → columns', () => {
    it('writes pool/direction/tenantId from event.metadata into columns', async () => {
      const { db, insertBuilder } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });

      await bus.publish({
        id: 'id-1',
        type: 't',
        aggregateId: 'a-1',
        aggregateType: 'agg',
        payload: {},
        occurredAt: new Date('2026-01-01T00:00:00Z'),
        metadata: { pool: 'events_change', direction: 'outbound', tenantId: 't1' },
      });

      expect(insertBuilder.values).toHaveBeenCalledTimes(1);
      const values = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
      expect(values['pool']).toBe('events_change');
      expect(values['direction']).toBe('outbound');
      expect(values['tenantId']).toBe('t1');
      // metadata JSON preserved unchanged
      expect(values['metadata']).toEqual({ pool: 'events_change', direction: 'outbound', tenantId: 't1' });
    });

    it('fills missing direction/tenantId with null when only pool is set', async () => {
      const { db, insertBuilder } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });

      await bus.publish({
        id: 'id-2',
        type: 't',
        aggregateId: 'a-1',
        aggregateType: 'agg',
        payload: {},
        occurredAt: new Date(),
        metadata: { pool: 'events_change' },
      });

      const values = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
      expect(values['pool']).toBe('events_change');
      expect(values['direction']).toBeNull();
      expect(values['tenantId']).toBeNull();
    });

    it('passes all three routing columns as null when metadata is absent', async () => {
      const { db, insertBuilder } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });

      await bus.publish({
        id: 'id-3',
        type: 't',
        aggregateId: 'a-1',
        aggregateType: 'agg',
        payload: {},
        occurredAt: new Date(),
      });

      const values = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
      expect(values['pool']).toBeNull();
      expect(values['direction']).toBeNull();
      expect(values['tenantId']).toBeNull();
      expect(values['metadata']).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // publishMany — per-event metadata preserved independently
  // --------------------------------------------------------------------------
  describe('publishMany — per-event column mapping', () => {
    it('preserves each event\'s pool/direction/tenantId independently', async () => {
      const { db, insertBuilder } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });

      await bus.publishMany([
        {
          id: 'id-a',
          type: 't',
          aggregateId: 'a-1',
          aggregateType: 'agg',
          payload: {},
          occurredAt: new Date(),
          metadata: { pool: 'events_inbound', direction: 'inbound' },
        },
        {
          id: 'id-b',
          type: 't',
          aggregateId: 'a-2',
          aggregateType: 'agg',
          payload: {},
          occurredAt: new Date(),
          metadata: { pool: 'events_change', direction: 'change', tenantId: 't9' },
        },
        {
          id: 'id-c',
          type: 't',
          aggregateId: 'a-3',
          aggregateType: 'agg',
          payload: {},
          occurredAt: new Date(),
        },
      ]);

      const rows = (insertBuilder.values as ReturnType<typeof mock>).mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ id: 'id-a', pool: 'events_inbound', direction: 'inbound', tenantId: null });
      expect(rows[1]).toMatchObject({ id: 'id-b', pool: 'events_change', direction: 'change', tenantId: 't9' });
      expect(rows[2]).toMatchObject({ id: 'id-c', pool: null, direction: null, tenantId: null });
    });

    it('no-op on empty array (no insert issued)', async () => {
      const { db, insertBuilder } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });

      await bus.publishMany([]);

      expect(db.insert).not.toHaveBeenCalled();
      expect(insertBuilder.values).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // processBatch — pool-filtered drain (EVT-4)
  // --------------------------------------------------------------------------
  describe('processBatch — pool filter plumbed into WHERE', () => {
    /**
     * Flatten the Drizzle SQL AST into leaf values (param values, column
     * names) so we can assert on it without running into the cyclic
     * decoder references `JSON.stringify` would hit.
     */
    function flatten(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
      if (node === null || node === undefined) return out;
      if (typeof node !== 'object') {
        out.push(node);
        return out;
      }
      if (seen.has(node)) return out;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const v of node) flatten(v, out, seen);
        return out;
      }
      const obj = node as Record<string, unknown>;
      // Column reference — keep the name for readability.
      if ('name' in obj && typeof obj['name'] === 'string' && 'columnType' in obj) {
        out.push(`col:${obj['name']}`);
        return out;
      }
      // Inline parameter value — leaf.
      if ('value' in obj && typeof obj['value'] !== 'object') {
        out.push(obj['value']);
        return out;
      }
      for (const key of Object.keys(obj)) {
        if (key === 'decoder' || key === 'usedTables' || key === 'table' || key === 'columnType') continue;
        flatten(obj[key], out, seen);
      }
      return out;
    }

    it('composes WHERE with inArray when opts.pools is set', async () => {
      const { db, selectBuilder, selectState } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, {
        backend: 'drizzle',
        pools: ['events_change'],
      });

      await bus.drainOnce();

      expect(selectBuilder.where).toHaveBeenCalledTimes(1);
      const tokens = flatten(selectState.whereArg);
      // Both the status predicate and the inArray(pool, ...) fragment
      // should be present in the composed WHERE.
      expect(tokens).toContain('col:pool');
      expect(tokens).toContain('events_change');
      expect(tokens).toContain('col:status');
      expect(tokens).toContain('pending');
      // The FOR UPDATE SKIP LOCKED modifier was applied to the claim.
      expect(selectBuilder.for).toHaveBeenCalledWith('update', { skipLocked: true });
    });

    it('omits the inArray clause when opts.pools is undefined', async () => {
      const { db, selectBuilder, selectState } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle' });

      await bus.drainOnce();

      expect(selectBuilder.where).toHaveBeenCalledTimes(1);
      const tokens = flatten(selectState.whereArg);
      // Only the status='pending' predicate; no pool reference.
      expect(tokens).toContain('col:status');
      expect(tokens).toContain('pending');
      expect(tokens).not.toContain('col:pool');
    });

    it('omits the inArray clause when opts.pools is an empty array', async () => {
      const { db, selectBuilder, selectState } = makeMockDb();
      const bus = new DrizzleEventBus(db as never, { backend: 'drizzle', pools: [] });

      await bus.drainOnce();

      expect(selectBuilder.where).toHaveBeenCalledTimes(1);
      const tokens = flatten(selectState.whereArg);
      expect(tokens).not.toContain('col:pool');
    });
  });

  // --------------------------------------------------------------------------
  // Constructor defaults — backwards-compatible direct construction
  // --------------------------------------------------------------------------
  describe('constructor', () => {
    it('accepts a single-arg form (defaults opts to { backend: "drizzle" })', async () => {
      const { db } = makeMockDb();
      // No second arg — mirrors pre-EVT-4 integration-test construction.
      const bus = new DrizzleEventBus(db as never);
      await expect(bus.drainOnce()).resolves.toBeUndefined();
    });
  });
});
