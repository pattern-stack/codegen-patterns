# BRIDGE-1 — `bridge_delivery` Drizzle Schema + Enum

**Issue:** BRIDGE-1
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** Nothing — schema foundation.
**Blocks:** BRIDGE-2, BRIDGE-3, BRIDGE-4.

## Overview

Add `bridge_delivery` table and `bridge_delivery_status` enum to the new `runtime/subsystems/bridge/` subsystem. This PR is the schema foundation for every subsequent BRIDGE issue. No service logic, no DI wiring — just the pgTable declaration, enum, indexes, and the UNIQUE idempotency constraint.

## Context

**What exists.** Nothing. `runtime/subsystems/bridge/` does not yet exist; this PR creates the directory.

**What this PR adds.** The `bridge_delivery` ledger table per ADR-023 §Schema, with `UNIQUE (event_id, trigger_id)` for replay idempotency and facade-vs-drain collision dedup (Case B from ADR-023 §`publishAndStart` + existing `triggers:` collision).

**`tenant_id` is emitted unconditionally (nullable).** Mirrors the JOB-8 reversal recorded in `docs/specs/JOB-8.md` §Acceptance Criteria (2026-04-20). Scaffold-time conditional forces every runtime call site to be tenant-aware; emitting the column unconditionally and enforcing at the service layer (BRIDGE-8) is the shipped convention. No runtime toggle; `BRIDGE_MULTI_TENANT` DI token controls enforcement.

## Architecture

```
runtime/subsystems/bridge/bridge-delivery.schema.ts
  ├── bridge_delivery_status pgEnum('pending','delivered','skipped','failed')
  └── bridge_delivery pgTable
        columns: id, event_id (→ domain_events), trigger_id,
                 wrapper_run_id (→ job_run, nullable),
                 user_run_id (→ job_run, nullable),
                 status, skip_reason, error,
                 tenant_id (nullable), attempted_at, delivered_at
        constraints: UNIQUE (event_id, trigger_id)
        indexes:
          bridge_delivery_event_idx (event_id)
          bridge_delivery_status_idx (status) WHERE status IN ('pending','failed')
          bridge_delivery_user_run_idx (user_run_id) WHERE user_run_id IS NOT NULL
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge-delivery.schema.ts` | create | `bridge_delivery` pgTable + enum + indexes |
| `runtime/subsystems/bridge/index.ts` | create | Barrel re-export |
| `src/__tests__/runtime/subsystems/bridge-delivery.schema.spec.ts` | create | Shape assertions |

## Interfaces

`BridgeDeliveryRecord` inferred via `typeof bridge_delivery.$inferSelect` and re-exported from `index.ts`. No hand-declared interface needed.

## Implementation Steps

1. Create `runtime/subsystems/bridge/` directory.
2. Declare `bridge_delivery_status` pgEnum with four values: `pending`, `delivered`, `skipped`, `failed`.
3. Declare `bridge_delivery` pgTable with all columns per ADR-023 §Schema. Use `uuid('event_id').notNull().references(() => domainEvents.id)` and same pattern for `wrapper_run_id` and `user_run_id` against `jobRuns` (both nullable — the facade-eager path pre-writes with `wrapper_run_id=null` per ADR-023).
4. Declare `UNIQUE (event_id, trigger_id)` via Drizzle's `unique()` constraint in the index callback.
5. Declare three indexes per ADR-023 §Schema (event lookup, status partial, user-run partial).
6. Export `bridgeDelivery` + `bridgeDeliveryStatus` from `index.ts`; re-export `BridgeDeliveryRecord` type.
7. Write unit test: import schema; assert column names, enum values, constraint names.

## Acceptance Criteria

- [ ] `bridge_delivery` pgTable present with all columns from ADR-023 §Schema.
- [ ] `bridge_delivery_status` enum has exactly `pending | delivered | skipped | failed`.
- [ ] `UNIQUE (event_id, trigger_id)` constraint declared.
- [ ] Three indexes declared; partial indexes use correct `WHERE` clause.
- [ ] `tenant_id` column emitted unconditionally, nullable; service-layer enforcement lands in BRIDGE-8.
- [ ] `wrapper_run_id` nullable (supports facade-eager path with no wrapper).
- [ ] `BridgeDeliveryRecord` inferred type exported from `index.ts`.
- [ ] Unit test asserts schema imports, column names present, enum values correct.

## Testing Strategy

- **Unit (`just test-unit`):** Import schema; assert `bridge_delivery._.columns` contains expected names; enum values exhaustive. No Docker.
- **Integration test deferred to BRIDGE-4**, where the drizzle-backend round-trips rows.

## Gate/Checkpoint

**CHECKPOINT after merge** — schema direction sanity check before BRIDGE-2..9 proceed. Coordinator reports via `.orchestration-checkpoint-1.md`.

## Open Questions

None. `tenant_id` conditional resolved by JOB-8 precedent; UNIQUE constraint + wrapper_run_id nullability locked in ADR-023.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Schema (`bridge_delivery`)
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 1
- `docs/specs/JOB-1.md` — schema precedent
- `docs/specs/JOB-8.md` — `tenant_id` unconditional emit reversal (2026-04-20)
- `docs/specs/EVT-1.md` — adjacent subsystem schema precedent
