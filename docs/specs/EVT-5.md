# EVT-5 — Memory Backend Upgrade + Unit Test Suite

**Issue:** EVT-5
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-4 (behavioral contract to match).
**Blocks:** EVT-6 (module wiring needs both backends ready).

## Overview

Upgrade `MemoryEventBus` with pool awareness for test assertions. Write a unit test suite covering publish/subscribe, pool propagation, direction stamping, and pool-filtered dispatch. All tests run without Docker.

## Context

**What exists.** `MemoryEventBus` stores published events in `publishedEvents[]` and dispatches synchronously. It exposes `clear()`. No pool awareness — test authors can only assert the full set of published events, not events by pool.

**What this PR adds.** `publishedEventsForPool(pool)` helper and pool-filter behavior that mirrors the Drizzle backend's per-process restriction. The memory backend remains synchronous (dispatch immediate, no polling interval) — pool filtering affects which events are dispatched to handlers, not which events are stored.

**Why pool-filtered dispatch matters for testing.** When testing components that set up isolated drain workers (e.g. an inbound-webhook worker vs. a change-event worker), the memory backend should behave the same way: events published to `events_inbound` should not be dispatched to a process configured for `events_change` only.

## Architecture

```
MemoryEventBus (opts?: { pools?: string[] })
  ├── publishedEvents: DomainEvent[]   ← all published events (unchanged)
  ├── publishedEventsForPool(pool)     ← NEW: filter by pool metadata
  ├── publish(event)
  │   ├── push to publishedEvents
  │   └── dispatch to handlers only if event.metadata?.pool in opts.pools (or pools unset)
  └── clear() → clears publishedEvents and handlers (unchanged)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/events/event-bus.memory-backend.ts` | modify | Pool awareness |
| `runtime/subsystems/events/__tests__/event-bus.unit.test.ts` | new | Unit test suite |

## Interfaces

```ts
export interface MemoryEventBusOptions {
  pools?: string[];  // restrict dispatch to these pools; undefined = dispatch all
}

@Injectable()
export class MemoryEventBus implements IEventBus {
  readonly publishedEvents: DomainEvent[] = [];  // unchanged

  /** Filter published events by pool (from metadata.pool). */
  publishedEventsForPool(pool: string): DomainEvent[] {
    return this.publishedEvents.filter(e => e.metadata?.['pool'] === pool);
  }

  /** Filter published events by direction (from metadata.direction). */
  publishedEventsForDirection(direction: string): DomainEvent[] {
    return this.publishedEvents.filter(e => e.metadata?.['direction'] === direction);
  }

  clear(): void { ... } // unchanged
}
```

## Implementation Steps

1. Add optional `MemoryEventBusOptions` constructor parameter (or injection token for NestJS context).
2. In `publish(event)`, after pushing to `publishedEvents`, check if `opts.pools` is set. If set and `event.metadata?.pool` is not in the list, skip `dispatch(event)` (still store in `publishedEvents`).
3. Add `publishedEventsForPool(pool: string): DomainEvent[]` helper.
4. Add `publishedEventsForDirection(direction: string): DomainEvent[]` helper.
5. Write unit test suite:
   - publish/subscribe round trip (unchanged behavior)
   - `publishedEventsForPool` returns correct subset
   - pool-restricted dispatch: events with non-matching pool are stored but not dispatched
   - `publishMany` dispatches all events
   - `clear()` resets state
   - handler error propagates synchronously
6. Ensure all tests are in `just test-unit` (no Docker).

## Acceptance Criteria

- [ ] `publishedEventsForPool('events_change')` returns only events where `metadata.pool === 'events_change'`.
- [ ] `publishedEventsForDirection('inbound')` returns only events where `metadata.direction === 'inbound'`.
- [ ] When initialized with `pools: ['events_change']`, `publish` with `metadata.pool = 'events_inbound'` stores the event in `publishedEvents` but does NOT dispatch to handlers.
- [ ] When initialized with `pools: undefined`, all events are dispatched (backwards-compatible).
- [ ] Unit test suite covers all the behaviors above.
- [ ] All tests pass in `just test-unit`.

## Testing Strategy

Pure in-process unit tests. No NestJS test harness needed for the backend class itself. Create `MemoryEventBus` directly with and without pool options; assert behavior via `publishedEvents`, `publishedEventsForPool`, and mock handler call counts.

## Open Questions

None blocking.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Drizzle backend upgrade" (memory mirrors this)
- `runtime/subsystems/events/event-bus.memory-backend.ts` — current implementation
- `docs/specs/JOB-4.md` — reference for memory backend unit test patterns
