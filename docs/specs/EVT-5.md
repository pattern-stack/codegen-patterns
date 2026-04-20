# EVT-5 — Memory Backend Upgrade + Unit Test Suite

**Issue:** EVT-5
**Status:** Shipped
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-4 (behavioral contract to match).
**Blocks:** EVT-6 (module wiring needs both backends ready).

## Overview

Upgrade `MemoryEventBus` with pool awareness for test assertions. Write a unit test suite covering publish/subscribe, pool propagation, direction stamping, and pool-filtered dispatch. All tests run without Docker.

## Context

**What exists.** `MemoryEventBus` stores published events in `publishedEvents[]` and dispatches synchronously. It exposes `clear()`. No pool awareness — test authors can only assert the full set of published events, not events by pool.

**What this PR adds.** `publishedEventsForPool(pool)` and `publishedEventsForDirection(direction)` helpers, plus pool-filter behaviour that mirrors the Drizzle backend's per-process restriction. The memory backend remains synchronous (dispatch immediate, no polling interval) — pool filtering affects which events are dispatched to handlers, not which events are stored.

**Why pool-filtered dispatch matters for testing.** When testing components that set up isolated drain workers (e.g. an inbound-webhook worker vs. a change-event worker), the memory backend should behave the same way: events published to `events_inbound` should not be dispatched to a process configured for `events_change` only.

## Architecture

```
MemoryEventBus (opts?: EventsModuleOptions)
  ├── publishedEvents: DomainEvent[]   ← all published events (unchanged)
  ├── publishedEventsForPool(pool)     ← filter by metadata.pool
  ├── publishedEventsForDirection(dir) ← filter by metadata.direction
  ├── publish(event)
  │   ├── push to publishedEvents (always)
  │   └── dispatch to handlers only if shouldDispatch(event)
  └── clear() → clears publishedEvents and handlers (unchanged)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/events/event-bus.memory-backend.ts` | modify | Pool awareness + helpers |
| `src/__tests__/runtime/subsystems/event-bus.spec.ts` | extend | Add `MemoryEventBus — pool awareness` block |

## Interfaces

```ts
@Injectable()
export class MemoryEventBus implements IEventBus {
  readonly publishedEvents: DomainEvent[] = [];  // unchanged

  constructor(
    @Optional() @Inject(EVENTS_MODULE_OPTIONS) opts?: EventsModuleOptions,
  ) {
    this.opts = opts ?? { backend: 'memory' };
  }

  /** Filter published events by pool (from metadata.pool). */
  publishedEventsForPool(pool: string): DomainEvent[];

  /** Filter published events by direction (from metadata.direction). */
  publishedEventsForDirection(direction: string): DomainEvent[];

  clear(): void; // unchanged
}
```

## Implementation Steps

1. Add optional `EventsModuleOptions` constructor parameter via `@Optional() @Inject(EVENTS_MODULE_OPTIONS)` — mirrors the `DrizzleEventBus` constructor shape.
2. In `publish(event)`, always push to `publishedEvents`. Then check `shouldDispatch(event)`: if `opts.pools` is a non-empty array and `event.metadata?.pool` is not in it, skip `dispatch()`.
3. Add `publishedEventsForPool(pool: string): DomainEvent[]` helper.
4. Add `publishedEventsForDirection(direction: string): DomainEvent[]` helper.
5. Extend `src/__tests__/runtime/subsystems/event-bus.spec.ts` with a new `describe('MemoryEventBus — pool awareness', ...)` block covering:
   - `publishedEventsForPool` returns correct subset (and empty on miss).
   - `publishedEventsForDirection` returns correct subset for inbound / outbound.
   - Pool-restricted dispatch: events with non-matching pool are stored but not dispatched.
   - Pool-restricted dispatch: matching events ARE dispatched.
   - `pools: undefined` (default) dispatches everything.
   - `pools: []` (empty array) dispatches everything — matches Drizzle's `pools && pools.length > 0` gate.
   - Event without `metadata` under a pool filter is not dispatched.
   - `publishMany` applies per-event filtering.
   - `clear()` resets `publishedEvents` after pool-filtered publishes.
6. Ensure all tests are in `just test-unit` (no Docker).

## Acceptance Criteria

- [x] `publishedEventsForPool('events_change')` returns only events where `metadata.pool === 'events_change'`.
- [x] `publishedEventsForDirection('inbound')` returns only events where `metadata.direction === 'inbound'`.
- [x] When initialized with `pools: ['events_change']`, `publish` with `metadata.pool = 'events_inbound'` stores the event in `publishedEvents` but does NOT dispatch to handlers.
- [x] When initialized with `pools: undefined`, all events are dispatched (backwards-compatible).
- [x] Unit test suite covers all the behaviours above.
- [x] All tests pass in `just test-unit`.

## Testing Strategy

Pure in-process unit tests. No NestJS test harness needed for the backend class itself. Create `MemoryEventBus` directly with and without pool options; assert behavior via `publishedEvents`, `publishedEventsForPool`, `publishedEventsForDirection`, and mock handler call counts.

## Implementation Notes (post-ship)

- **Tests extend the existing spec file, not a new one.** The original plan in this spec named a new file at `runtime/subsystems/events/__tests__/event-bus.unit.test.ts`. That's not the repo convention — runtime-subsystem tests live in `src/__tests__/runtime/subsystems/*.spec.ts`, and `event-bus.spec.ts` already existed there with ~17 MemoryEventBus tests and ~9 DrizzleEventBus tests from EVT-4. The pool-awareness tests were added as a new top-level `describe('MemoryEventBus — pool awareness', ...)` block in that file. Creating a parallel `*.unit.test.ts` file would have split tests across two locations for no reason.
- **Options shape reused, no `MemoryEventBusOptions` introduced.** The original draft contemplated a dedicated `MemoryEventBusOptions` type. Final implementation reuses `EventsModuleOptions` (same injection token, same shape) to keep both backends DI-symmetric. `MemoryEventBus` only reads `opts.pools`, so widening its own type wouldn't have bought anything and would have risked drift between backend option surfaces.
- **Empty-pools semantics: treat as "no filter".** Chosen to match the `DrizzleEventBus.processBatch` WHERE clause, which uses `pools && pools.length > 0` as the gate on the `inArray` fragment. An empty array falls through to the status-only predicate and drains every row. The memory backend does the same: `pools: []` dispatches all events. Documented in the `shouldDispatch` method comment in `event-bus.memory-backend.ts`.
- **Events without `metadata.pool` are out of every configured pool.** When `opts.pools` is non-empty, events missing `metadata.pool` never match and are not dispatched. This mirrors `inArray(pool, [...])` semantics, where `NULL pool` never satisfies the predicate.
- **Test count delta:** baseline 795 unit tests → 806 after adding 11 pool-awareness tests (one more than the ~10 estimated, to cover both inbound and outbound direction filtering independently).
- **`publishedEventsForTenant` helper intentionally omitted.** The AC and the interface block only call out `pool` and `direction` helpers. Adding a tenant helper is cheap but out of scope; the raw `publishedEvents.filter(e => e.metadata?.tenantId === t)` is fine for ad hoc assertions until EVT-6 needs it.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Drizzle backend upgrade" (memory mirrors this)
- `runtime/subsystems/events/event-bus.memory-backend.ts` — current implementation
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` — constructor shape reference (EVT-4)
- `docs/specs/JOB-4.md` — reference for memory backend unit test patterns
