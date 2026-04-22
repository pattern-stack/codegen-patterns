# BRIDGE-4 — Drizzle Backend + Outbox Drain Integration

**Issue:** BRIDGE-4
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-1, BRIDGE-2, BRIDGE-3.
**Blocks:** BRIDGE-5, BRIDGE-8.

## Overview

Two deliverables bound together because they must land atomically.

1. **`DrizzleBridgeDeliveryRepo`** — Postgres implementation of `IJobBridge`. Maps pg driver's `unique_violation` error to typed `UniqueConstraintError` matching BRIDGE-3's discriminator.
2. **Outbox drain modification** — `runtime/subsystems/events/event-bus.drizzle-backend.ts` (already shipped as EVT-4) is modified so that, per drained event, the drain consults the `bridgeRegistry` (injected via `BRIDGE_REGISTRY` token, nullable — non-bridge projects see `undefined` and skip this block) and, for each matched trigger, inserts a `bridge_delivery` row + a wrapper `job_run` row. All inside the per-event transaction (ADR-023 §Outbox drain atomicity).

## Context

**Why coupled.** Shipping `DrizzleBridgeDeliveryRepo` without the drain hookup leaves the table empty forever; shipping the drain hookup without the repo produces an unbuildable import graph. Single PR.

**Invasiveness flag.** This is the most invasive change in the stack — it touches already-shipped EVT-4 code. Baseline + smoke + unit tests must all pass unchanged; no regression of the `FOR UPDATE SKIP LOCKED` claim semantics or the `processed_at` stamp.

## Architecture

```
DrizzleEventBus.processBatch() (per EVT-4)
  for each claimed row (per-event tx):
    ┌── consult bridgeRegistry[row.type]  // may be undefined → skip bridge block
    │   for each matched trigger:
    │     INSERT INTO bridge_delivery (event_id, trigger_id, status='pending', tenant_id, ...)
    │       ON CONFLICT (event_id, trigger_id) DO NOTHING
    │       RETURNING id
    │     if (rowcount === 1):
    │       INSERT INTO job_run (type='@framework/bridge_delivery',
    │                            pool=`events_${direction}`,
    │                            input={ deliveryId },
    │                            status='pending',
    │                            trigger_source='event',
    │                            trigger_ref=row.id,
    │                            tenant_id)
    │     else:
    │       // Case B (facade pre-wrote status=delivered) OR drain replay:
    │       // skip wrapper spawn; a previous owner handles it
    ├── await handle user subscribers (unchanged EVT-4 behavior)
    └── UPDATE domain_events SET processed_at = now() WHERE id = row.id
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts` | create | Drizzle implementation of `IJobBridge` |
| `runtime/subsystems/events/event-bus.drizzle-backend.ts` | modify | Drain inserts `bridge_delivery` + wrapper `job_run` per matched trigger |
| `src/__tests__/runtime/subsystems/bridge-delivery.drizzle-backend.spec.ts` | create | Unit (mocked Drizzle) |
| `test/scaffold/tests/bridge-drain.test.ts` | create | Docker integration |
| `runtime/subsystems/bridge/bridge.tokens.ts` | modify | Confirm `BRIDGE_REGISTRY` token exists |

## Implementation Notes

### Per-trigger conflict handling (CRITICAL — read before coding)

ADR-023 §Outbox drain atomicity says "one transaction per event." An event with N triggers inserts N ledger rows + N wrapper rows inside that one tx. In Case B, the facade has already pre-written one of those N rows (`status='delivered'`, `wrapper_run_id=null`). The drain's INSERT for that specific trigger must gracefully dedup while **other triggers for the same event still fire normally inside the same tx**.

Naive `INSERT ... ` would throw on UNIQUE, and because we're in a tx, the exception aborts the whole per-event tx — every trigger for this event loses.

**Decision: `INSERT ... ON CONFLICT (event_id, trigger_id) DO NOTHING` + rowcount check.**

```sql
INSERT INTO bridge_delivery (event_id, trigger_id, status, ...)
VALUES (...)
ON CONFLICT (event_id, trigger_id) DO NOTHING
RETURNING id
```

If `RETURNING` yields 1 row → fresh insert, proceed to wrapper `job_run` insert. If 0 rows → the row was pre-written (Case B) or a previous drain attempt already wrote it (replay). Skip the wrapper insert for this trigger only; move to the next trigger in the loop.

**Why not savepoints.** Savepoints-per-trigger would work (`SAVEPOINT trigger_N` around each INSERT, roll back on exception) but adds three SQL round-trips per trigger and obscures the intent. `ON CONFLICT DO NOTHING` is one round-trip, atomic, and self-documenting. Savepoints considered and rejected.

**Rowcount source.** drizzle-orm's `.returning({ id: ... })` → `result.length`. Don't rely on driver `rowCount` — ORM-specific.

### Non-bridge projects

`BRIDGE_REGISTRY` is injected `@Optional()` into `DrizzleEventBus`. When the bridge subsystem is not installed, the token is undefined and the drain's bridge block is a no-op. EVT-4 behavior preserved for non-bridge consumers.

### Wrapper row shape

Wrapper `job_run.type = '@framework/bridge_delivery'` (the handler BRIDGE-5 will register). Pool = `events_${row.direction}`. `trigger_source='event'`, `trigger_ref=row.id` (the event id) — these columns already exist on `job_run` per ADR-022.

## Acceptance Criteria

- [ ] `DrizzleBridgeDeliveryRepo` implements `IJobBridge`; `insertDelivery` maps `23505` pg unique-violation to typed `UniqueConstraintError` (same discriminator as BRIDGE-3).
- [ ] Drain consults `bridgeRegistry` via `@Optional() @Inject(BRIDGE_REGISTRY)`.
- [ ] Per-event transaction inserts `bridge_delivery` + wrapper `job_run` for every matched trigger using `ON CONFLICT DO NOTHING + RETURNING` + rowcount check.
- [ ] Trigger whose `ON CONFLICT` fired (rowcount=0) skips its own wrapper insert; sibling triggers for the same event still fire.
- [ ] `processed_at` stamp on `domain_events` lands inside the same per-event tx (no EVT-4 regression).
- [ ] Docker integration test: publish event with two matching triggers → 2× `bridge_delivery` + 2× wrapper `job_run` rows; `processed_at` set; kill-between-triggers test shows no half-state (both or neither).
- [ ] Docker integration test: pre-write `bridge_delivery` for one of two triggers before drain → drain inserts only the second trigger's rows; processed_at still set.
- [ ] `just test-unit` + `just test-family` + `just test-baseline` all green.

## Testing Strategy

- **Unit** (mocked `db.insert(...).onConflictDoNothing().returning()`): verify rowcount branching for both cases; verify non-bridge-registered path is a no-op.
- **Integration** (Docker Postgres, gated by `SCAFFOLD_INTEGRATION=1`): end-to-end drain with two triggers; Case B pre-write dedup; crash-between-triggers atomicity.
- **Smoke test**: existing `event-bus.test.ts` scenarios must continue passing — no EVT-4 regression.

## Gate/Checkpoint

**GATE before opening PR** — DB migration surface + drain modification review. Coordinator reports via `.orchestration-gate-4.md`. User confirms diff against EVT-4 preserves `FOR UPDATE SKIP LOCKED`, `processed_at` semantics, and per-pool filtering before PR opens.

## Open Questions

- [ ] Bulk-fanout batch-insert optimization (50+ triggers per event) is ADR Resolved #4 — "not a Phase 2 blocker." Single-row inserts in a loop are the shipped behavior. Revisit if throughput becomes a concern.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Outbox drain atomicity, §`publishAndStart` + existing `triggers:` collision
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 4, risk #1 (invasiveness)
- `docs/specs/EVT-4.md` — drain implementation this PR modifies
- `docs/specs/JOB-3.md` — wrapper `job_run` insert pattern
