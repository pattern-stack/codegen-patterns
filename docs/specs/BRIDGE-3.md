# BRIDGE-3 — Memory Backend (`MemoryBridgeDeliveryRepo`)

**Issue:** BRIDGE-3
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-2.
**Blocks:** BRIDGE-5 (handler tests), BRIDGE-7 (facade tests).

## Overview

Test-double implementation of `IJobBridge`. In-memory `Map` keyed by `(event_id, trigger_id)`; UNIQUE constraint simulated by throwing a typed error on duplicate insert. Ergonomic helpers used by BRIDGE-5 and BRIDGE-7 tests.

## Context

**What exists.** Protocol + tokens (BRIDGE-2). No implementation.

**What this PR adds.** A behavioral twin to the Drizzle backend that BRIDGE-4 will ship, but 100% synchronous, no Docker, suitable for `just test-unit`. Precedent: `MemoryEventBus` (EVT-5), `MemoryJobOrchestrator` (JOB-3 companion).

## Architecture

```
MemoryBridgeDeliveryRepo implements IJobBridge
  internal state:
    deliveries: Map<`${eventId}::${triggerId}`, BridgeDeliveryRecord>

  insertDelivery(row):
    key = `${row.event_id}::${row.trigger_id}`
    if map.has(key) → throw UniqueConstraintError(key)
    else map.set(key, row)

  findDelivery(eventId, triggerId) → map.get(key) ?? null
  markDelivered / markSkipped / markFailed → mutate record in place

  // test helpers
  getDeliveriesForEvent(eventId): BridgeDeliveryRecord[]
  getByStatus(status): BridgeDeliveryRecord[]
  clear(): void
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge-delivery.memory-backend.ts` | create | Memory implementation + helpers |
| `src/__tests__/runtime/subsystems/bridge-delivery.memory-backend.spec.ts` | create | Unit tests |
| `runtime/subsystems/bridge/index.ts` | modify | Re-export memory backend |
| `runtime/subsystems/bridge/bridge-errors.ts` | modify | Add `UniqueConstraintError` (shape matches what drizzle-orm pg driver throws — minimal shim) |

## Implementation Steps

1. Create `MemoryBridgeDeliveryRepo` class implementing `IJobBridge`.
2. Back with a `Map<string, BridgeDeliveryRecord>` keyed by `"${event_id}::${trigger_id}"`.
3. `insertDelivery`: if key exists → throw `UniqueConstraintError` with a `.constraint === 'bridge_delivery_event_id_trigger_id_unique'` discriminator so BRIDGE-4's ON CONFLICT handling can share a type check path with BRIDGE-7's test assertions.
4. State-transition methods mutate in place; unknown id throws.
5. Helpers: `getDeliveriesForEvent(eventId)`, `getByStatus(status)`, `clear()`.
6. Unit tests cover: insert + find; duplicate insert throws; state transitions; helpers.

## Acceptance Criteria

- [ ] `MemoryBridgeDeliveryRepo` implements `IJobBridge`.
- [ ] Duplicate `(event_id, trigger_id)` insert throws `UniqueConstraintError` with a discriminator constant equal to the Drizzle constraint name.
- [ ] `findDelivery` returns `null` on miss.
- [ ] `markDelivered` / `markSkipped` / `markFailed` update in place; unknown id throws.
- [ ] `getDeliveriesForEvent`, `getByStatus`, `clear` helpers present.
- [ ] Unit tests pass in `just test-unit` — no Docker.

## Testing Strategy

Unit only. No integration (that's BRIDGE-4's job).

## Gate/Checkpoint

None.

## Open Questions

None.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Schema (`bridge_delivery`)
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 3
- `docs/specs/EVT-5.md` — memory backend precedent
