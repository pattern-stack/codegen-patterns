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

### Follow-up: site (c) multi-tenancy guard added in BRIDGE-8 (2026-04-22)

`DrizzleBridgeDeliveryRepo.insertDelivery` is site (c) of the three ADR-023 §Multi-tenancy enforcement sites — the last-line repo defense that fires even when callers skip sites (a) `EventFlowService.publishAndStart` and (b) `BridgeDeliveryHandler.run`. BRIDGE-4 shipped without this guard; BRIDGE-8 added it via `@Optional() @Inject(BRIDGE_MULTI_TENANT) multiTenant: boolean = false` on the constructor and an `assertTenantId('DrizzleBridgeDeliveryRepo.insertDelivery', this.multiTenant, row.tenantId)` call before any SQL is issued. Tests in `bridge.module.spec.ts` confirm the throw fires before any SQL hits the `drizzle-orm/pg-proxy` driver. Cross-link: BRIDGE-8 spec Implementation Notes; ADR-023 §Multi-tenancy null-tenantId.

## Acceptance Criteria

- [x] `DrizzleBridgeDeliveryRepo` implements `IJobBridge`. **Refinement:** uses `INSERT … ON CONFLICT (event_id, trigger_id) DO NOTHING` — the spec asked for an error-mapping path but per the spec's own Implementation Notes the agreed shape was DO NOTHING. The DO NOTHING path surfaces dedup as a silent no-op (the desired behaviour); `UniqueConstraintError` is the memory-backend fidelity tool and not thrown by the Drizzle backend in the normal path. Tests that need to assert "the constraint fired" inspect the existing row via `findDelivery`.
- [x] Drain consults the bridge subsystem via `@Optional() @Inject(BRIDGE_OUTBOX_DRAIN_HOOK) bridgeHook?: IBridgeOutboxDrainHook`. The hook (`BridgeOutboxDrainHook`) reads `BRIDGE_REGISTRY` itself. **Layering refinement:** introducing the hook port keeps the events subsystem free of any knowledge of `bridge_delivery` / wrapper `job_run` shape (the schema crossing happens inside the bridge subsystem). Tests mock the port directly — easier than mocking deeper Drizzle ops.
- [x] Per-event transaction inserts `bridge_delivery + wrapper job_run` for every matched trigger using `ON CONFLICT DO NOTHING + RETURNING id` + rowcount check (rowcount === 0 ⇒ skip wrapper insert; sibling triggers still fire).
- [x] Trigger whose `ON CONFLICT` fired (rowcount=0) skips its own wrapper insert; sibling triggers for the same event still fire — pinned by `bridge-outbox-drain-hook.spec.ts` "Case B / replay dedup" tests.
- [x] `processed_at` stamp on `domain_events` lands inside the same per-event tx, with `AND status='pending'` belt-and-suspenders WHERE clause. **EVT-4 baseline change:** `MAX_RETRIES=3` in-process retry loop and `failed`-stamping path were removed (lead approval 2026-04-22). Subscriber dispatch moved OUTSIDE the per-event tx — subscribers are best-effort; their failures are logged but do not roll back bridge fanout or revert `processed_at`. Lead-decided 2026-04-22 (option (c)).
- [~] Docker integration test — DEFERRED. The unit tests against mocked Drizzle pin the call shape (`bridge-delivery.drizzle-backend.spec.ts`, `bridge-outbox-drain-hook.spec.ts`, `event-bus.spec.ts` BRIDGE-4 block). True end-to-end Docker coverage of "publish → drain → wrapper claim → user job spawn" lands in BRIDGE-8 module-wiring PR where the full DI chain is wired. This is consistent with the resequence note in `docs/specs/BRIDGE-PHASE-2-PLAN.md` — BRIDGE-4 ships drain modification + repos; BRIDGE-8 ships the integration test.
- [~] Docker pre-write Case B test — DEFERRED to BRIDGE-8. Unit-level Case B / replay dedup is covered (see prior AC).
- [x] `just test-all` (unit + baseline + smoke) green. `just test-family` runs unmodified; the bridge tables aren't referenced by family tests.

## Testing Strategy

- **Unit** (mocked `db.insert(...).onConflictDoNothing().returning()`): verify rowcount branching for both cases; verify non-bridge-registered path is a no-op.
- **Integration** (Docker Postgres, gated by `SCAFFOLD_INTEGRATION=1`): end-to-end drain with two triggers; Case B pre-write dedup; crash-between-triggers atomicity.
- **Smoke test**: existing `event-bus.test.ts` scenarios must continue passing — no EVT-4 regression.

## Gate/Checkpoint

**GATE before opening PR** — DB migration surface + drain modification review. Coordinator reports via `.orchestration-gate-4.md`. User confirms diff against EVT-4 preserves `FOR UPDATE SKIP LOCKED`, `processed_at` semantics, and per-pool filtering before PR opens.

## Open Questions

- [ ] Bulk-fanout batch-insert optimization (50+ triggers per event) is ADR Resolved #4 — "not a Phase 2 blocker." Single-row inserts in a loop are the shipped behavior. Revisit if throughput becomes a concern.

## Implementation Notes (added in PR per CLAUDE.md living-docs rule)

**Hook port instead of direct schema imports.** The spec sketched the drain consulting `BRIDGE_REGISTRY` directly and writing `bridge_delivery + job_run` rows from inside `event-bus.drizzle-backend.ts`. To keep the events subsystem free of any knowledge of bridge schemas (cleaner layering), we introduced a narrow `IBridgeOutboxDrainHook` port instead. The drain only knows the hook interface; the bridge subsystem owns the SQL. `BridgeModule.forRoot()` (BRIDGE-8) wires the hook implementation; non-bridge consumers see `undefined` and the drain skips the bridge block. Token: `BRIDGE_OUTBOX_DRAIN_HOOK`. Result type: `BridgeOutboxDrainResult { delivered, dedupSkips, triggerCount }` — useful for observability + tests.

**Per-event tx restructure of EVT-4 (lead-approved 2026-04-22).** The pre-BRIDGE-4 `processBatch` had no per-event tx; `dispatch(event)` ran outside any tx and was followed by an unguarded `processed_at` UPDATE. Restructured to:
1. Per-event `db.transaction(async tx => { bridgeHook.processEvent(event, tx); UPDATE domain_events SET processed_at WHERE id = ? AND status = 'pending'; })`.
2. After commit (outside the tx), `dispatch(event)` for in-process subscribers — best-effort; errors logged + discarded.

**Removed: `MAX_RETRIES=3` in-process retry loop and `failed`-stamping.** Lead-approved 2026-04-22. The next-cycle re-claim handles transient infra failures cleanly; bridge `UNIQUE` makes retry idempotent. Subscriber failures are observability concerns (ADR-026 territory), not gate-on-progress concerns.

**Tightened `processed_at` UPDATE WHERE.** Now carries `AND status = 'pending'` (lead-approved 2026-04-22).

**Null direction handling.** When `event.metadata.direction` is null/unknown, the hook logs once per process and returns zero deliveries. The drain still stamps `processed_at` and dispatches subscribers normally. Bridge fanout is opt-in via direction-routed publishing through `TypedEventBus.publish()`; legacy publishers don't lose the event, they just don't spawn bridge wrappers.

**Wrapper `job_run` shape.** `type='@framework/bridge_delivery'` (constant from BRIDGE-5: `BRIDGE_DELIVERY_JOB_TYPE`), `pool='events_<direction>'`, `input={ deliveryId }`, `triggerSource='event'`, `triggerRef=event.id`, `tenantId` from event metadata. `id`/`rootRunId` generated client-side via `randomUUID()` (mirrors `MemoryJobOrchestrator` shape).

**Why no `RETURNING id` on the wrapper insert.** Nobody needs the wrapper id at drain time; `BridgeDeliveryHandler` looks up the wrapper via `bridge_delivery.wrapper_run_id` if it ever needs to. Saves a round-trip per trigger.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Outbox drain atomicity, §`publishAndStart` + existing `triggers:` collision
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 4, risk #1 (invasiveness)
- `docs/specs/EVT-4.md` — drain implementation this PR modifies
- `docs/specs/JOB-3.md` — wrapper `job_run` insert pattern
