/**
 * OBS-LIST-1 — unit tests for `MemoryEventBus.listEvents` (IEventReadPort).
 *
 * Covers the keyset-paginated, filterable domain_events list:
 *   - Empty log
 *   - Ordering (occurred_at desc, id desc tie-break)
 *   - Filters: poolId, direction, rootRunId (metadata->>'rootRunId'), since,
 *     tenantId (string + null)
 *   - Keyset pagination round-trip
 *   - EventSummary projection (rootRunId lifted from metadata)
 *   - Malformed cursor tolerated
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryEventBus } from '../../../../runtime/subsystems/events/event-bus.memory-backend';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

let seq = 0;
function evt(overrides: Partial<DomainEvent> & { occurredAt: Date }): DomainEvent {
  seq += 1;
  return {
    id: overrides.id ?? `evt-${String(seq).padStart(4, '0')}`,
    type: overrides.type ?? 'thing_happened',
    aggregateId: overrides.aggregateId ?? 'agg-1',
    aggregateType: overrides.aggregateType ?? 'thing',
    payload: overrides.payload ?? {},
    occurredAt: overrides.occurredAt,
    metadata: overrides.metadata,
  };
}

async function seed(bus: MemoryEventBus, events: DomainEvent[]): Promise<void> {
  for (const e of events) {
    await bus.publish(e);
  }
}

describe('MemoryEventBus.listEvents — basics', () => {
  let bus: MemoryEventBus;
  beforeEach(() => {
    bus = new MemoryEventBus();
  });

  it('returns an empty page when nothing has been published', async () => {
    expect(await bus.listEvents()).toEqual({ items: [], nextCursor: null });
  });

  it('orders by occurred_at desc', async () => {
    await seed(bus, [
      evt({ id: 'old', occurredAt: new Date('2026-01-01T00:00:00Z') }),
      evt({ id: 'new', occurredAt: new Date('2026-01-03T00:00:00Z') }),
      evt({ id: 'mid', occurredAt: new Date('2026-01-02T00:00:00Z') }),
    ]);
    const page = await bus.listEvents();
    expect(page.items.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('filters by poolId and direction (from metadata)', async () => {
    await seed(bus, [
      evt({ id: 'a', occurredAt: new Date('2026-01-01T00:00:00Z'), metadata: { pool: 'events_change', direction: 'change' } }),
      evt({ id: 'b', occurredAt: new Date('2026-01-02T00:00:00Z'), metadata: { pool: 'events_inbound', direction: 'inbound' } }),
    ]);
    expect((await bus.listEvents({ poolId: 'events_change' })).items.map((e) => e.id)).toEqual(['a']);
    expect((await bus.listEvents({ direction: 'inbound' })).items.map((e) => e.id)).toEqual(['b']);
  });

  it('filters by rootRunId via metadata->>rootRunId', async () => {
    await seed(bus, [
      evt({ id: 'r1a', occurredAt: new Date('2026-01-01T00:00:00Z'), metadata: { rootRunId: 'root-1' } }),
      evt({ id: 'r2a', occurredAt: new Date('2026-01-02T00:00:00Z'), metadata: { rootRunId: 'root-2' } }),
      evt({ id: 'none', occurredAt: new Date('2026-01-03T00:00:00Z'), metadata: {} }),
    ]);
    const page = await bus.listEvents({ rootRunId: 'root-1' });
    expect(page.items.map((e) => e.id)).toEqual(['r1a']);
    expect(page.items[0]!.rootRunId).toBe('root-1');
  });

  it('filters by since (inclusive)', async () => {
    await seed(bus, [
      evt({ id: 'before', occurredAt: new Date('2026-01-01T00:00:00Z') }),
      evt({ id: 'on', occurredAt: new Date('2026-01-02T00:00:00Z') }),
      evt({ id: 'after', occurredAt: new Date('2026-01-03T00:00:00Z') }),
    ]);
    const page = await bus.listEvents({ since: new Date('2026-01-02T00:00:00Z') });
    expect(page.items.map((e) => e.id).sort()).toEqual(['after', 'on']);
  });

  it('filters by tenantId string and null', async () => {
    await seed(bus, [
      evt({ id: 'ta', occurredAt: new Date('2026-01-01T00:00:00Z'), metadata: { tenantId: 'A' } }),
      evt({ id: 'tn', occurredAt: new Date('2026-01-02T00:00:00Z'), metadata: {} }),
    ]);
    expect((await bus.listEvents({ tenantId: 'A' })).items.map((e) => e.id)).toEqual(['ta']);
    expect((await bus.listEvents({ tenantId: null })).items.map((e) => e.id)).toEqual(['tn']);
  });

  it('projects EventSummary fields including tier default', async () => {
    await seed(bus, [
      evt({
        id: 'p',
        type: 'contact_created',
        aggregateId: 'c-1',
        aggregateType: 'contact',
        occurredAt: new Date('2026-01-05T00:00:00Z'),
        metadata: { pool: 'events_change', direction: 'change', rootRunId: 'root-9', tenantId: 'T' },
      }),
    ]);
    const [row] = (await bus.listEvents()).items;
    expect(row).toEqual({
      id: 'p',
      type: 'contact_created',
      aggregateId: 'c-1',
      aggregateType: 'contact',
      status: 'processed',
      pool: 'events_change',
      direction: 'change',
      tier: 'domain',
      rootRunId: 'root-9',
      tenantId: 'T',
      occurredAt: new Date('2026-01-05T00:00:00Z'),
      processedAt: new Date('2026-01-05T00:00:00Z'),
    });
  });
});

describe('MemoryEventBus.listEvents — keyset pagination', () => {
  let bus: MemoryEventBus;
  beforeEach(() => {
    bus = new MemoryEventBus();
  });

  it('walks every event once across pages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = `e-${i}`;
      ids.push(id);
      await bus.publish(evt({ id, occurredAt: new Date(Date.UTC(2026, 0, i + 1)) }));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await bus.listEvents({ limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(7);
  });

  it('tolerates a malformed cursor', async () => {
    await bus.publish(evt({ id: 'x', occurredAt: new Date('2026-01-01T00:00:00Z') }));
    const page = await bus.listEvents({ cursor: '@@@not-base64@@@' });
    expect(page.items.map((e) => e.id)).toEqual(['x']);
  });
});
