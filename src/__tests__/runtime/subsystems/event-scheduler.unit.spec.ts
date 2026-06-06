/**
 * EventScheduler unit tests (ADR-039 — declarative time-based scheduling:
 * time as an event source).
 *
 * Covers:
 *   1. parseEvery — duration grammar + rejection of malformed values
 *   2. slot math — slotStartFor / nextSlotStart / slotKeyFor (aligned + boot-relative)
 *   3. MemoryEventBus.materializeScheduledEvent — slot idempotency parity with
 *      the DB unique index (emit once per slot, no-op thereafter)
 *   4. reconcile-on-boot — materialise the current slot once
 *   5. tick — materialise current + next slot, idempotent across ticks
 *   6. catch-up — backfill missed slots; run-once default; maxCatchUpSlots bound
 *   7. registry resolution — scheduledEventsFromRegistry + tier/route validation
 *
 * Pure functions tested directly; the scheduler is driven against a real
 * MemoryEventBus with an injectable clock (no real timers).
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  EventScheduler,
  parseEvery,
  slotStartFor,
  nextSlotStart,
  slotKeyFor,
  resolveScheduledEvent,
  scheduledEventsFromRegistry,
  SCHEDULE_KEY_PREFIX,
  type ScheduledEvent,
} from '../../../../runtime/subsystems/events/event-scheduler';
import { MemoryEventBus } from '../../../../runtime/subsystems/events/event-bus.memory-backend';
import { ScheduleConfigError } from '../../../../runtime/subsystems/events/events-errors';
import type { DomainEvent } from '../../../../runtime/subsystems/events/event-bus.protocol';

const HOUR = 3_600_000;

/** A scheduled-event spec with the routing fields a domain event needs. */
function sched(over: Partial<ScheduledEvent> = {}): ScheduledEvent {
  return {
    type: 'reconcile_due',
    everyMs: HOUR,
    align: true,
    catchUp: false,
    maxCatchUpSlots: 1000,
    direction: 'inbound',
    pool: 'events_inbound',
    ...over,
  };
}

/** Count materialised scheduled ticks for a type on a bus. */
function scheduledTicks(bus: MemoryEventBus, type: string): DomainEvent[] {
  return bus.publishedEvents.filter(
    (e) => e.type === type && e.metadata?.['triggerSource'] === 'schedule',
  );
}

// ─── 1. parseEvery ────────────────────────────────────────────────────────────

describe('parseEvery — duration grammar (Group 1)', () => {
  it('parses unit suffixes', () => {
    expect(parseEvery('500ms')).toBe(500);
    expect(parseEvery('15s')).toBe(15_000);
    expect(parseEvery('30m')).toBe(1_800_000);
    expect(parseEvery('1h')).toBe(HOUR);
    expect(parseEvery('1d')).toBe(86_400_000);
  });

  it('accepts decimals and raw numbers', () => {
    expect(parseEvery('1.5h')).toBe(HOUR * 1.5);
    expect(parseEvery(250_000)).toBe(250_000);
  });

  it('rejects malformed / non-positive / non-finite values with ScheduleConfigError', () => {
    expect(() => parseEvery('1 fortnight')).toThrow(ScheduleConfigError);
    expect(() => parseEvery('abc')).toThrow(ScheduleConfigError);
    expect(() => parseEvery('')).toThrow(ScheduleConfigError);
    expect(() => parseEvery(0)).toThrow(ScheduleConfigError);
    expect(() => parseEvery(-1)).toThrow(ScheduleConfigError);
    expect(() => parseEvery(Number.POSITIVE_INFINITY)).toThrow(ScheduleConfigError);
  });
});

// ─── 2. slot math ─────────────────────────────────────────────────────────────

describe('slot math — aligned + boot-relative (Group 2)', () => {
  it('aligned slots are epoch-anchored (floor to the grid)', () => {
    // 2026-06-05T15:37 → slot start 15:00
    const at = Date.UTC(2026, 5, 5, 15, 37, 12);
    const start = slotStartFor(at, HOUR, true, 0);
    expect(new Date(start).toISOString()).toBe('2026-06-05T15:00:00.000Z');
    expect(nextSlotStart(at, HOUR, true, 0)).toBe(start + HOUR);
  });

  it('two skewed clocks compute the same aligned boundary', () => {
    const a = Date.UTC(2026, 5, 5, 15, 1, 0);
    const b = Date.UTC(2026, 5, 5, 15, 58, 0);
    expect(slotStartFor(a, HOUR, true, 0)).toBe(slotStartFor(b, HOUR, true, 0));
  });

  it('boot-relative slots anchor to the first-run time', () => {
    const anchor = Date.UTC(2026, 5, 5, 15, 37, 0);
    // exactly at anchor → anchor; mid-first-slot → still anchor; next slot → anchor + every
    expect(slotStartFor(anchor, HOUR, false, anchor)).toBe(anchor);
    expect(slotStartFor(anchor + 59 * 60_000, HOUR, false, anchor)).toBe(anchor);
    expect(slotStartFor(anchor + HOUR + 1, HOUR, false, anchor)).toBe(anchor + HOUR);
  });

  it('slot key is deterministic and prefix-namespaced', () => {
    const k = slotKeyFor('reconcile_due', 1_000);
    expect(k).toBe(`${SCHEDULE_KEY_PREFIX}reconcile_due/1000`);
    expect(slotKeyFor('reconcile_due', 1_000)).toBe(k); // pure
  });
});

// ─── 3. MemoryEventBus.materializeScheduledEvent — idempotency parity ─────────

describe('MemoryEventBus.materializeScheduledEvent — slot idempotency (Group 3)', () => {
  let bus: MemoryEventBus;
  beforeEach(() => {
    bus = new MemoryEventBus();
  });

  it('emits one tick per slot and reports created', async () => {
    const slotStart = new Date(Date.UTC(2026, 5, 5, 15, 0, 0));
    const r = await bus.materializeScheduledEvent!({
      type: 'reconcile_due',
      slotKey: slotKeyFor('reconcile_due', slotStart.getTime()),
      slotStart,
      direction: 'inbound',
      pool: 'events_inbound',
    });
    expect(r.created).toBe(true);
    const ticks = scheduledTicks(bus, 'reconcile_due');
    expect(ticks.length).toBe(1);
    expect(ticks[0]!.metadata?.['scheduleSlot']).toBe(
      slotKeyFor('reconcile_due', slotStart.getTime()),
    );
    expect(ticks[0]!.metadata?.['pool']).toBe('events_inbound');
    expect(ticks[0]!.metadata?.['triggerSource']).toBe('schedule');
    // payload-free fact
    expect(ticks[0]!.payload).toEqual({});
  });

  it('a repeat materialise of the same slot is a no-op (created: false)', async () => {
    const slotStart = new Date(Date.UTC(2026, 5, 5, 15, 0, 0));
    const spec = {
      type: 'reconcile_due',
      slotKey: slotKeyFor('reconcile_due', slotStart.getTime()),
      slotStart,
      direction: 'inbound',
      pool: 'events_inbound',
    };
    await bus.materializeScheduledEvent!(spec);
    const second = await bus.materializeScheduledEvent!(spec);
    expect(second.created).toBe(false);
    expect(scheduledTicks(bus, 'reconcile_due').length).toBe(1);
  });

  it('dispatches the tick to subscribers (Tier 1 activation)', async () => {
    const seen: string[] = [];
    bus.subscribe('reconcile_due', async (e) => {
      seen.push(e.metadata?.['scheduleSlot'] as string);
    });
    const slotStart = new Date(Date.UTC(2026, 5, 5, 16, 0, 0));
    await bus.materializeScheduledEvent!({
      type: 'reconcile_due',
      slotKey: slotKeyFor('reconcile_due', slotStart.getTime()),
      slotStart,
      direction: 'inbound',
      pool: 'events_inbound',
    });
    expect(seen).toEqual([slotKeyFor('reconcile_due', slotStart.getTime())]);
  });

  it('lastScheduledSlotMs returns the most recent tick or null', async () => {
    expect(await bus.lastScheduledSlotMs!('reconcile_due')).toBeNull();
    const s1 = new Date(Date.UTC(2026, 5, 5, 15, 0, 0));
    const s2 = new Date(Date.UTC(2026, 5, 5, 16, 0, 0));
    for (const s of [s1, s2]) {
      await bus.materializeScheduledEvent!({
        type: 'reconcile_due',
        slotKey: slotKeyFor('reconcile_due', s.getTime()),
        slotStart: s,
        direction: 'inbound',
        pool: 'events_inbound',
      });
    }
    expect(await bus.lastScheduledSlotMs!('reconcile_due')).toBe(s2.getTime());
  });
});

// ─── 4. reconcile-on-boot ─────────────────────────────────────────────────────

describe('EventScheduler — reconcile-on-boot (Group 4)', () => {
  it('materialises exactly the current slot on boot (catchUp off)', async () => {
    const bus = new MemoryEventBus();
    const nowMs = Date.UTC(2026, 5, 5, 15, 37, 0);
    const scheduler = new EventScheduler(bus, [sched()], { now: () => nowMs });
    await scheduler.materializeBoot();
    const ticks = scheduledTicks(bus, 'reconcile_due');
    expect(ticks.length).toBe(1);
    // current slot = 15:00
    expect(ticks[0]!.occurredAt.toISOString()).toBe('2026-06-05T15:00:00.000Z');
  });

  it('a re-boot in the same slot does not double-emit (slot idempotency)', async () => {
    const bus = new MemoryEventBus();
    const nowMs = Date.UTC(2026, 5, 5, 15, 37, 0);
    const a = new EventScheduler(bus, [sched()], { now: () => nowMs });
    const b = new EventScheduler(bus, [sched()], { now: () => nowMs + 60_000 });
    await a.materializeBoot();
    await b.materializeBoot();
    expect(scheduledTicks(bus, 'reconcile_due').length).toBe(1);
  });
});

// ─── 5. tick ──────────────────────────────────────────────────────────────────

describe('EventScheduler — tick pass (Group 5)', () => {
  it('materialises current + next slot, idempotent across repeated ticks', async () => {
    const bus = new MemoryEventBus();
    let nowMs = Date.UTC(2026, 5, 5, 15, 37, 0);
    const scheduler = new EventScheduler(bus, [sched()], { now: () => nowMs });

    await scheduler.materializeTick(); // emits 15:00 + 16:00
    expect(scheduledTicks(bus, 'reconcile_due').length).toBe(2);

    await scheduler.materializeTick(); // same slots → no new rows
    expect(scheduledTicks(bus, 'reconcile_due').length).toBe(2);

    nowMs = Date.UTC(2026, 5, 5, 16, 5, 0); // advance into the next slot
    await scheduler.materializeTick(); // 16:00 already exists → emits 17:00
    const slots = scheduledTicks(bus, 'reconcile_due')
      .map((e) => e.occurredAt.toISOString())
      .sort();
    expect(slots).toEqual([
      '2026-06-05T15:00:00.000Z',
      '2026-06-05T16:00:00.000Z',
      '2026-06-05T17:00:00.000Z',
    ]);
  });
});

// ─── 6. catch-up ──────────────────────────────────────────────────────────────

describe('EventScheduler — misfire / catch-up (Group 6)', () => {
  it('default (catchUp off) emits ONE run on recovery, not the missed slots', async () => {
    const bus = new MemoryEventBus();
    // Seed an old tick 5 hours ago, then boot now — no backfill.
    const oldSlot = new Date(Date.UTC(2026, 5, 5, 10, 0, 0));
    await bus.materializeScheduledEvent!({
      type: 'reconcile_due',
      slotKey: slotKeyFor('reconcile_due', oldSlot.getTime()),
      slotStart: oldSlot,
      direction: 'inbound',
      pool: 'events_inbound',
    });
    const nowMs = Date.UTC(2026, 5, 5, 15, 30, 0);
    const scheduler = new EventScheduler(bus, [sched()], { now: () => nowMs });
    await scheduler.materializeBoot();
    // old (10:00) + the single current (15:00) = 2 total; nothing from 11..14.
    const slots = scheduledTicks(bus, 'reconcile_due')
      .map((e) => e.occurredAt.toISOString())
      .sort();
    expect(slots).toEqual([
      '2026-06-05T10:00:00.000Z',
      '2026-06-05T15:00:00.000Z',
    ]);
  });

  it('catchUp:true backfills missed slots from last+1 to current', async () => {
    const bus = new MemoryEventBus();
    const lastSlot = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    await bus.materializeScheduledEvent!({
      type: 'reconcile_due',
      slotKey: slotKeyFor('reconcile_due', lastSlot.getTime()),
      slotStart: lastSlot,
      direction: 'inbound',
      pool: 'events_inbound',
    });
    const nowMs = Date.UTC(2026, 5, 5, 15, 10, 0);
    const scheduler = new EventScheduler(bus, [sched({ catchUp: true })], {
      now: () => nowMs,
    });
    await scheduler.materializeBoot();
    // last=12:00 already there; backfill 13:00, 14:00, 15:00.
    const slots = scheduledTicks(bus, 'reconcile_due')
      .map((e) => e.occurredAt.toISOString())
      .sort();
    expect(slots).toEqual([
      '2026-06-05T12:00:00.000Z',
      '2026-06-05T13:00:00.000Z',
      '2026-06-05T14:00:00.000Z',
      '2026-06-05T15:00:00.000Z',
    ]);
  });

  it('catchUp is bounded by maxCatchUpSlots (caps to most-recent N)', async () => {
    const bus = new MemoryEventBus();
    // No prior tick; pretend last was a long time ago by seeding one 10 slots back
    const lastSlot = new Date(Date.UTC(2026, 5, 5, 5, 0, 0)); // 10h before 15:00
    await bus.materializeScheduledEvent!({
      type: 'reconcile_due',
      slotKey: slotKeyFor('reconcile_due', lastSlot.getTime()),
      slotStart: lastSlot,
      direction: 'inbound',
      pool: 'events_inbound',
    });
    const nowMs = Date.UTC(2026, 5, 5, 15, 0, 0);
    const scheduler = new EventScheduler(
      bus,
      [sched({ catchUp: true, maxCatchUpSlots: 3 })],
      { now: () => nowMs },
    );
    await scheduler.materializeBoot();
    // Backfill capped to the 3 most-recent slots: 13:00, 14:00, 15:00 (plus the
    // pre-seeded 05:00). 06:00..12:00 are dropped.
    const slots = scheduledTicks(bus, 'reconcile_due')
      .map((e) => e.occurredAt.toISOString())
      .sort();
    expect(slots).toEqual([
      '2026-06-05T05:00:00.000Z',
      '2026-06-05T13:00:00.000Z',
      '2026-06-05T14:00:00.000Z',
      '2026-06-05T15:00:00.000Z',
    ]);
  });
});

// ─── 7. registry resolution + validation ──────────────────────────────────────

describe('scheduledEventsFromRegistry + resolveScheduledEvent (Group 7)', () => {
  it('picks only events that declare schedule and resolves defaults', () => {
    const registry = {
      reconcile_due: {
        schedule: { every: '1h' },
        direction: 'inbound',
        pool: 'events_inbound',
      },
      contact_created: { direction: 'change', pool: 'events_change' }, // no schedule
    };
    const out = scheduledEventsFromRegistry(registry);
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe('reconcile_due');
    expect(out[0]!.everyMs).toBe(HOUR);
    expect(out[0]!.align).toBe(true); // default
    expect(out[0]!.catchUp).toBe(false); // default
    expect(out[0]!.maxCatchUpSlots).toBe(1000); // default
  });

  it('rejects a scheduled event with no direction/pool (must be domain-tier)', () => {
    expect(() =>
      resolveScheduledEvent('bad', { every: '1h' }, null, null),
    ).toThrow(ScheduleConfigError);
  });

  it('an empty / no-schedule registry yields no scheduled events', () => {
    expect(scheduledEventsFromRegistry({})).toEqual([]);
    expect(
      scheduledEventsFromRegistry({
        contact_created: { direction: 'change', pool: 'events_change' },
      }),
    ).toEqual([]);
  });
});
