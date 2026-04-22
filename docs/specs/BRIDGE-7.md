# BRIDGE-7 — `EventFlowService` Facade

**Issue:** BRIDGE-7
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-2, BRIDGE-3, BRIDGE-6.
**Blocks:** BRIDGE-8.

## Overview

`EventFlowService implements IEventFlow` — the developer-facing facade from ADR-023 §Decision 7. `publish()` is a thin delegate to `IEventBus.publish()`. `publishAndStart()` is the load-bearing method: outbox insert + eager `orchestrator.start()` + (Case B only) `bridge_delivery(status='delivered')` pre-write, all inside one transaction.

## Context

**What exists.** `IEventBus.publish` (EVT-4), `IJobOrchestrator.start` (JOB-3), `IJobBridge.insertDelivery` (BRIDGE-3/4), `bridgeRegistry` (BRIDGE-6). No facade.

**What this PR adds.** The facade. After this PR, authors call `eventFlow.publishAndStart(...)` from use cases; reviewers can grep `publishAndStart` to find all Tier 2 call sites.

## Architecture

```
EventFlowService.publishAndStart(event, jobType, input, opts?)
  return db.transaction(async (tx) => {
    // Multi-tenancy gate (BRIDGE-8 wires; structurally here)
    assertTenantId('publishAndStart', multiTenant, opts?.tenantId);

    // 1. Outbox insert
    await eventBus.publish(event, tx);

    // 2. Eager start
    const { runId } = await orchestrator.start(jobType, input, {
      ...opts,
      tenantId: opts?.tenantId ?? null,
      triggerSource: 'event',
      triggerRef: event.id,
    }, tx);

    // 3. Case B detection — consult bridgeRegistry
    const entries = bridgeRegistry[event.type] ?? [];
    const match = entries.find(e => e.jobType === jobType);
    if (match) {
      // Case B: pre-write delivery to dedup the later drain insert
      await bridgeRepo.insertDelivery({
        eventId: event.id,
        triggerId: match.triggerId,
        wrapperRunId: null,              // facade never writes a wrapper
        userRunId: runId,
        status: 'delivered',
        tenantId: opts?.tenantId ?? null,
        attemptedAt: new Date(),
        deliveredAt: new Date(),
      }, tx);
    }
    // Case A: no entry → no pre-write; drain finds nothing to dedup against; no double-run possible.

    return { runId };
  });
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/event-flow.service.ts` | create | Facade implementation |
| `src/__tests__/runtime/subsystems/event-flow.service.spec.ts` | create | Unit + collision tests |
| `runtime/subsystems/bridge/index.ts` | modify | Re-export service |

## Implementation Notes

### Transactional coupling (CRITICAL)

**All three DB writes in Case B MUST happen inside the same transaction.**

- A crash between `orchestrator.start` (step 2) and `insertDelivery` (step 3) would leave an orphan `job_run` with no ledger row. The drain later processes the event, finds no delivery row, inserts one + a wrapper → wrapper claims → handler calls `orchestrator.start` → **double-spawn**.
- Conversely, a crash between `eventBus.publish` (step 1) and `orchestrator.start` (step 2) in a non-tx'd world would produce an outbox row with no eager runner; the drain would eventually fanout normally → single-run (wrong Case A; caller thought Case B).

The single-transaction boundary eliminates both failure modes. Spec body is explicit; PR body must restate this.

### Case A vs Case B detection

Registry is an in-memory `Map`; lookup is O(1). Only entries whose `jobType` matches the argument `jobType` are Case B. Multiple triggers with the same `(eventType, jobType)` pair are not expressible (triggerId is `jobType#index`; facade writes one pre-write per match — typically zero or one).

### Transaction source

`EventFlowService` injects `DRIZZLE` client; starts its own `tx` and passes to each collaborator. If the underlying protocols' `publish(event, tx?)` / `start(type, input, opts, tx?)` don't yet take `tx` last-arg, BRIDGE-7 adds it in BRIDGE-2 / extends EVT-4 / extends JOB-3. Implementer confirms in PR body which protocol extensions were needed and lands them here.

### `publish()` delegate

Just `eventBus.publish(event)` — no tx required because caller didn't hand one in. Kept as a method on the facade for grep-symmetry.

## Acceptance Criteria

- [ ] `EventFlowService implements IEventFlow`.
- [ ] `publish()` delegates to `IEventBus.publish()`.
- [ ] Case A (no registry entry for `(event.type, jobType)`): `publishAndStart` writes outbox + starts job; no `bridge_delivery` row written; returns `{ runId }`.
- [ ] Case B (registry has entry): additional `bridge_delivery(status='delivered', wrapper_run_id=null, user_run_id=<runId>)` pre-write.
- [ ] All three DB writes in Case B happen inside one transaction (test asserts with a fail-injected `insertDelivery` mock: `orchestrator.start` side effects rolled back).
- [ ] Later drain attempting to insert same `(event_id, trigger_id)` hits ON CONFLICT DO NOTHING (BRIDGE-4), skips wrapper spawn. Combined integration test in BRIDGE-8.
- [ ] Multi-tenancy gate at function entry (full enforcement lands in BRIDGE-8; structural hook in place here).
- [ ] Registry lookup O(1); no perf concern.

## Testing Strategy

- **Unit** (memory bridge repo + memory orchestrator + memory event bus): Case A and Case B happy paths; rollback-on-failure; tenantId propagation.
- **Case B collision** — memory-backed assertion: after `publishAndStart`, simulate drain by calling `bridgeRepo.insertDelivery` with same `(eventId, triggerId)` → `UniqueConstraintError`. Confirms the downstream BRIDGE-4 dedup will kick in.
- Integration / end-to-end lands in BRIDGE-8.

## Gate/Checkpoint

**GATE before opening PR** — facade dedup semantics against real `bridgeRegistry`. Coordinator reports via `.orchestration-gate-7.md`. User confirms (a) one-tx boundary is correct and (b) Case A/B detection matches registry exactly.

## Open Questions

- [ ] **Protocol `tx` parameter propagation.** If `IEventBus.publish(event)` doesn't already accept `tx?: DrizzleClient`, extending it here is a cross-subsystem modification. Confirm in PR body; update BRIDGE-2 or EVT/JOB spec notes accordingly.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Decision 7, §`publishAndStart` + existing `triggers:` collision
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 7, risk #2 (single-tx requirement)
