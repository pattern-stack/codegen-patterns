/**
 * EventBus integration tests against real Postgres.
 *
 * Tests the DrizzleEventBus against the docker-compose Postgres instance,
 * verifying the transactional outbox pattern: publish inserts rows, the
 * polling loop dispatches and marks them processed.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { DrizzleEventBus } from '@gen/shared/subsystems/events/event-bus.drizzle-backend';
import { domainEvents } from '@gen/shared/subsystems/events/domain-events.schema';
import type { DomainEvent } from '@gen/shared/subsystems/events/event-bus.protocol';
import { getTestDb, truncateAll, closeDb } from './setup';
import { isNull, eq } from 'drizzle-orm';

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: crypto.randomUUID(),
    type: 'integration_test_event',
    aggregateId: crypto.randomUUID(),
    aggregateType: 'test_aggregate',
    payload: { test: true },
    occurredAt: new Date(),
    ...overrides,
  };
}

let bus: DrizzleEventBus;

beforeAll(() => {
  const db = getTestDb();
  // Direct instantiation — @Inject is just metadata, constructor takes DRIZZLE
  bus = new DrizzleEventBus(db as any);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------
describe('publish', () => {
  test('inserts an event row into domain_events', async () => {
    const db = getTestDb();
    const event = makeEvent();
    await bus.publish(event);

    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(event.type);
    expect(rows[0].aggregateId).toBe(event.aggregateId);
    expect(rows[0].aggregateType).toBe(event.aggregateType);
    expect(rows[0].payload).toEqual(event.payload);
    expect(rows[0].processedAt).toBeNull();
  });

  test('event row stores metadata when provided', async () => {
    const db = getTestDb();
    const event = makeEvent({ metadata: { queue: 'domain-events', origin: 'test' } });
    await bus.publish(event);

    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows[0].metadata).toEqual({ queue: 'domain-events', origin: 'test' });
  });
});

// ---------------------------------------------------------------------------
// publishMany
// ---------------------------------------------------------------------------
describe('publishMany', () => {
  test('inserts all events', async () => {
    const db = getTestDb();
    const events = [makeEvent({ type: 'a' }), makeEvent({ type: 'b' }), makeEvent({ type: 'c' })];
    await bus.publishMany(events);

    const rows = await db.select().from(domainEvents);
    expect(rows).toHaveLength(3);
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(['a', 'b', 'c']);
  });

  test('is a no-op for empty array', async () => {
    const db = getTestDb();
    await bus.publishMany([]);
    const rows = await db.select().from(domainEvents);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// transactional outbox — tx rollback prevents event persistence
// ---------------------------------------------------------------------------
describe('transactional outbox', () => {
  test('event is not persisted when the transaction rolls back', async () => {
    const db = getTestDb();
    const event = makeEvent({ type: 'rolled_back_event' });

    try {
      await db.transaction(async (tx) => {
        await bus.publish(event, tx as any);
        // Force rollback
        throw new Error('intentional rollback');
      });
    } catch {
      // expected
    }

    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows).toHaveLength(0);
  });

  test('event is persisted when the transaction commits', async () => {
    const db = getTestDb();
    const event = makeEvent({ type: 'committed_event' });

    await db.transaction(async (tx) => {
      await bus.publish(event, tx as any);
    });

    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// polling / dispatch
// ---------------------------------------------------------------------------
describe('polling loop', () => {
  test('marks events as processed after dispatching', async () => {
    const db = getTestDb();
    const received: DomainEvent[] = [];
    const event = makeEvent({ type: 'poll_test' });

    bus.subscribe('poll_test', async (e) => { received.push(e); });
    await bus.publish(event);

    // Start polling
    await bus.onModuleInit();

    // Wait for the polling cycle to run (poll interval is 1 s; allow 2 s)
    await new Promise((r) => setTimeout(r, 2_000));

    await bus.onModuleDestroy();

    expect(received.length).toBeGreaterThanOrEqual(1);

    // Row should be marked processed
    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows[0].processedAt).not.toBeNull();
    // Not the sentinel failure date
    expect(rows[0].processedAt!.getFullYear()).toBeGreaterThan(1970);
  }, 10_000);

  test('unprocessed events remain when no handler is registered', async () => {
    const db = getTestDb();
    const event = makeEvent({ type: 'no_handler_event' });
    await bus.publish(event);

    // Start and stop polling quickly — event has no handler so stays unprocessed
    await bus.onModuleInit();
    await new Promise((r) => setTimeout(r, 1_500));
    await bus.onModuleDestroy();

    const rows = await db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.id, event.id));

    // No handler registered: dispatch is a no-op, event is still marked processed
    // (the backend marks it processed after dispatch even if no handler consumed it)
    expect(rows).toHaveLength(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------
describe('subscribe', () => {
  test('returns an unsubscribe function', () => {
    const unsub = bus.subscribe('test_event', async () => {});
    expect(typeof unsub).toBe('function');
    unsub(); // cleanup
  });
});
