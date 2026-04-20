# EVT-4 — Drizzle Backend Upgrade: Pool Columns + Pool-Filtered Drain

**Issue:** EVT-4
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-1 (schema must have `pool`/`direction` columns).
**Blocks:** EVT-5 (Memory backend behavioral parity).

## Overview

Upgrade `DrizzleEventBus` to populate the new `pool` and `direction` first-class columns at insert time, and to accept an optional `pools` filter in the drain loop. Update `EventsModuleOptions` to expose the `pools` parameter. Write `tenant_id` when multi-tenancy is enabled.

## Context

**What exists.** `DrizzleEventBus.publish()` inserts into `domain_events` without writing `pool` or `direction` columns (they didn't exist). `processBatch()` queries all `pending` rows regardless of pool. There is no way to restrict a drain process to a subset of event lanes.

**What this PR adds.** Pool-awareness at both the insert and drain layers. After this PR, running two separate `EventsModule.forRoot({ pools: ['events_inbound'] })` and `EventsModule.forRoot({ pools: ['events_change'] })` processes provides the lane isolation that ADR-022 describes — each process claims only its own pool.

**Why both metadata and columns.** `metadata.pool` and `metadata.direction` remain in the JSON for protocol stability (downstream consumers reading metadata directly still work). The first-class columns are a Drizzle-query optimization — filtered drain doesn't need to touch JSON.

## Architecture

```
DrizzleEventBus.publish(event, tx?)
  ├── extracts event.metadata?.pool → writes to domain_events.pool column
  ├── extracts event.metadata?.direction → writes to domain_events.direction column
  ├── extracts event.metadata?.tenantId → writes to domain_events.tenant_id (if column exists)
  └── metadata column still written (unchanged)

DrizzleEventBus.processBatch(opts?: { pools?: string[] })
  └── WHERE status='pending'
        AND (pool = ANY($pools) OR $pools IS NULL)
      ORDER BY occurred_at ASC LIMIT $batchSize
      FOR UPDATE SKIP LOCKED

EventsModule.forRoot({ backend: 'drizzle', pools: ['events_inbound'] })
  └── DrizzleEventBus constructed with pools=['events_inbound']
      → processBatch always called with this filter
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/events/event-bus.drizzle-backend.ts` | modify | Column population at insert, pool filter in drain |
| `runtime/subsystems/events/events.module.ts` | modify | `EventsModuleOptions` gains `pools?: string[]` |

## Interfaces

```ts
// events.module.ts
export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis';
  redisUrl?: string;
  pools?: string[];      // ← NEW: restrict drain to these pools; undefined = drain all
  multi_tenant?: boolean; // ← NEW (EVT-6 wires this; placeholder here)
}
```

```ts
// event-bus.drizzle-backend.ts constructor
constructor(
  @Inject(DRIZZLE) private readonly db: DrizzleClient,
  @Inject(EVENTS_MODULE_OPTIONS) private readonly opts: EventsModuleOptions,
) {}

// processBatch now pool-aware
private async processBatch(): Promise<void> {
  const pools = this.opts.pools;
  // SELECT ... WHERE status='pending' AND (pool = ANY($pools) OR $pools IS NULL)
  // ... FOR UPDATE SKIP LOCKED
}
```

## Implementation Steps

1. Inject `EventsModuleOptions` into `DrizzleEventBus` (via `EVENTS_MODULE_OPTIONS` token).
2. In `publish(event, tx?)`, extract `event.metadata?.pool` and `event.metadata?.direction` and add them to the `.values({...})` insert call alongside the existing fields.
3. Extract `event.metadata?.tenantId` for `tenant_id` column (only write if the column exists — guard with a try/catch or runtime check, or just always include it and let the column be null when absent).
4. In `processBatch()`, build the WHERE clause: `eq(domainEvents.status, 'pending')` plus optional `inArray(domainEvents.pool, pools)` when `pools` is defined.
5. Switch from raw `sql\`SELECT ...\`` to Drizzle ORM builder (see the current implementation — it uses raw SQL; migrate to `tx.select().from(domainEvents).where(...).for('update', { skipLocked: true })` for consistency and pool filtering).
6. Add `EVENTS_MODULE_OPTIONS` token to `events.tokens.ts`.
7. Wire `EVENTS_MODULE_OPTIONS` provider in `EventsModule.forRoot()`.
8. Write integration test (Docker Postgres): publish events with two different `metadata.pool` values; drain with `pools: ['events_change']`; assert only `events_change` rows are claimed; `events_inbound` rows remain `pending`.

## Acceptance Criteria

- [ ] `publish(event)` writes `event.metadata?.pool` to `domain_events.pool` column.
- [ ] `publish(event)` writes `event.metadata?.direction` to `domain_events.direction` column.
- [ ] `processBatch()` with `pools: ['events_change']` only claims rows where `pool = 'events_change'`.
- [ ] `processBatch()` without `pools` drains all pending rows (backwards-compatible).
- [ ] `EventsModuleOptions.pools` defaults to `undefined` (drain all) — no behaviour change for existing consumers.
- [ ] `processBatch()` uses Drizzle ORM query builder, not raw `sql\`...\`` template.
- [ ] Integration test (Docker): per-pool drain isolation confirmed.

## Testing Strategy

- **Unit test** (no Docker): mock `DrizzleClient`, verify `publish` includes `pool`/`direction` in the insert values.
- **Integration test** (Docker Postgres): full round-trip with pool filtering. These run in `just test-family`.

## Open Questions

None blocking. EVT-Q7 (stale-event sweeper) resolved: no sweeper needed. The `FOR UPDATE SKIP LOCKED` model is self-healing.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Drizzle backend upgrade"
- `docs/specs/events-codegen-plan.md` §3 — drain pool routing design
- `.claude/skills/events/outbox-and-transactions.md` §"The polling loop" — current drain implementation
- `docs/specs/JOB-3.md` — reference for FOR UPDATE SKIP LOCKED pattern in jobs
