/**
 * EventBus integration tests against real Postgres.
 *
 * Tests the DrizzleEventBus against the docker-compose Postgres instance,
 * verifying the transactional outbox pattern: publish inserts rows, the
 * polling loop dispatches and marks them processed.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

type DomainEvent = any;
let DrizzleEventBus: any;
let domainEvents: any;
let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let eq: any;
let bus: any;

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

beforeAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  ({ DrizzleEventBus } = await import(
    '@gen/shared/subsystems/events/event-bus.drizzle-backend'
  ));
  ({ domainEvents } = await import(
    '@gen/shared/subsystems/events/domain-events.schema'
  ));
  ({ getTestDb, truncateAll, closeDb } = await import('./setup'));
  ({ eq } = await import('drizzle-orm'));

  const db = getTestDb();
  bus = new DrizzleEventBus(db as any);
});

beforeEach(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await truncateAll();
});

afterAll(async () => {
  if (!SHOULD_RUN_SCAFFOLD) return;
  await closeDb();
});

d('publish', () => {
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

d('publishMany', () => {
  test('inserts all events', async () => {
    const db = getTestDb();
    const events = [makeEvent({ type: 'a' }), makeEvent({ type: 'b' }), makeEvent({ type: 'c' })];
    await bus.publishMany(events);

    const rows = await db.select().from(domainEvents);
    expect(rows).toHaveLength(3);
    const types = rows.map((r: DomainEvent) => r.type).sort();
    expect(types).toEqual(['a', 'b', 'c']);
  });

  test('is a no-op for empty array', async () => {
    const db = getTestDb();
    await bus.publishMany([]);
    const rows = await db.select().from(domainEvents);
    expect(rows).toHaveLength(0);
  });
});

d('transactional outbox', () => {
  test('event is not persisted when the transaction rolls back', async () => {
    const db = getTestDb();
    const event = makeEvent({ type: 'rolled_back_event' });

    try {
      await db.transaction(async (tx: any) => {
        await bus.publish(event, tx as any);
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

    await db.transaction(async (tx: any) => {
      await bus.publish(event, tx as any);
    });

    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).toBeNull();
  });
});

d('polling loop', () => {
  test('marks events as processed after dispatching', async () => {
    const db = getTestDb();
    const received: DomainEvent[] = [];
    const event = makeEvent({ type: 'poll_test' });

    bus.subscribe('poll_test', async (e: DomainEvent) => { received.push(e); });
    await bus.publish(event);

    await bus.onModuleInit();
    await new Promise((r) => setTimeout(r, 2_000));
    await bus.onModuleDestroy();

    expect(received.length).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(domainEvents).where(eq(domainEvents.id, event.id));
    expect(rows[0].processedAt).not.toBeNull();
    expect(rows[0].processedAt!.getFullYear()).toBeGreaterThan(1970);
  }, 10_000);

  test('unprocessed events remain when no handler is registered', async () => {
    const db = getTestDb();
    const event = makeEvent({ type: 'no_handler_event' });
    await bus.publish(event);

    await bus.onModuleInit();
    await new Promise((r) => setTimeout(r, 1_500));
    await bus.onModuleDestroy();

    const rows = await db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.id, event.id));

    expect(rows).toHaveLength(1);
  }, 10_000);
});

d('subscribe', () => {
  test('returns an unsubscribe function', () => {
    const unsub = bus.subscribe('test_event', async () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });
});
