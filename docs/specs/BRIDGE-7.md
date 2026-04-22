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

- [x] `EventFlowService implements IEventFlow`.
- [x] `publish()` delegates to `IEventBus.publish()`. Optional `tx?` threaded through (matches `IEventFlow.publish` BRIDGE-2 signature).
- [x] Case A (no registry entry for `(event.type, jobType)`): `publishAndStart` writes outbox + starts job; no `bridge_delivery` row written; returns `{ runId }`. Pinned by 2 tests (registry-with-different-jobType + empty-registry).
- [x] Case B (registry has entry): pre-write `bridge_delivery(status='delivered', wrapper_run_id=null, user_run_id=<runId>)` for **EVERY matching trigger** (lead decision 2026-04-22 — `filter()` not `find()` so duplicate-trigger registries don't double-spawn).
- [x] All three DB writes in Case B happen inside one transaction. Pinned by call-ordering test (`bus.publish` → `orchestrator.start` → `repo.insertDelivery`) + rollback test (`insertDelivery` throw → tx callback marked rolled back; throw propagates).
- [x] Later drain attempting to insert same `(event_id, trigger_id)` is dedup'd. Pinned by memory-backend `UniqueConstraintError` test (BRIDGE-3 fidelity simulates BRIDGE-4 ON CONFLICT). End-to-end integration in BRIDGE-8.
- [x] Multi-tenancy gate at function entry: throws `MissingTenantIdError('EventFlowService.publishAndStart')` when `multiTenant=true && opts?.tenantId === undefined`. Pinned by 3 tests (throw, explicit-null pass-through, explicit-string pass-through to BOTH eager start AND bridge_delivery).
- [x] Registry lookup is `Map<eventType, BridgeTriggerEntry[]>` keyed read + linear scan over typically-1–5 entries. Effectively O(1) at consumer scale.

## Testing Strategy

- **Unit** (memory bridge repo + memory orchestrator + memory event bus): Case A and Case B happy paths; rollback-on-failure; tenantId propagation.
- **Case B collision** — memory-backed assertion: after `publishAndStart`, simulate drain by calling `bridgeRepo.insertDelivery` with same `(eventId, triggerId)` → `UniqueConstraintError`. Confirms the downstream BRIDGE-4 dedup will kick in.
- Integration / end-to-end lands in BRIDGE-8.

## Gate/Checkpoint

**GATE before opening PR** — facade dedup semantics against real `bridgeRegistry`. Coordinator reports via `.orchestration-gate-7.md`. User confirms (a) one-tx boundary is correct and (b) Case A/B detection matches registry exactly.

## Open Questions

- [x] **Protocol `tx` parameter propagation — RESOLVED.** `IEventBus.publish(event, tx?)` already accepts `tx` (EVT-4). `IJobBridge.insertDelivery(row, tx?)` already accepts `tx` (BRIDGE-2). `IJobOrchestrator.start(type, input, opts?)` did NOT — extended to `start(type, input, opts?, tx?)` in this PR (lead-approved option (a) at GATE 3). Drizzle backend uses `client = tx ?? this.db` (standard pattern); memory backend ignores. JOB-3 spec updated with appended Implementation Note.

## Implementation Notes (added in PR per CLAUDE.md living-docs rule)

**Same-tx invariant — three writes, one tx.** `db.transaction(async tx => { eventBus.publish(event, tx); orchestrator.start(jobType, input, opts, tx); for (m of matchingTriggers) bridgeRepo.insertDelivery({...}, tx); })`. A throw anywhere in the body propagates and rolls back all three writes; the bridge `UNIQUE (event_id, trigger_id)` makes the next-cycle drain re-claim idempotent.

**Pre-write ALL matching triggers (lead decision 2026-04-22, GATE 3 ask 2).** The facade uses `registry.filter(t => t.jobType === jobType)`, not `find()`. Rationale: duplicate `(event, jobType)` pairs in the registry would otherwise leave one trigger un-pre-written, the drain would spawn a wrapper for that triggerId, and the wrapper handler would call `orchestrator.start` for the same `(event, jobType)` → double-spawn. With filter+loop, every matching trigger is pre-written so the drain's ON CONFLICT skips them all. BRIDGE-6 codegen now also rejects duplicates at build time (see BRIDGE-6 follow-up below) — belt+suspenders.

**`IJobOrchestrator.start` extended with optional `tx?` (lead decision 2026-04-22, GATE 3 ask 1).** Cross-subsystem modification: `runtime/subsystems/jobs/job-orchestrator.protocol.ts` interface signature gained a fourth optional parameter; `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` uses `client = (tx ?? this.db) as DrizzleClient` for every read/write inside `start()` (the existing pattern from `DrizzleEventBus.publish` and `DrizzleBridgeDeliveryRepo`); memory backend accepts the parameter as `_tx?: unknown` and ignores it (its "atomic" boundary is a process-wide mutex). No behaviour change for existing callers — `tx` defaults to `undefined`. JOB-3 spec updated with an appended Implementation Note.

**BRIDGE-6 follow-up — codegen `DuplicateTriggerError` (lead decision 2026-04-22, GATE 3 ask 3).** Same-PR patch to `src/cli/shared/bridge-registry-generator.ts`: new `validateNoDuplicateTriggers(triggers)` that throws `DuplicateTriggerError` on the first `(event, jobType)` pair that appears twice. Hooked into `generateBridgeRegistry` before `validateAgainstEventRegistry`. Error message lists every offending occurrence with file + line + triggerId so authors can pick which one to remove. BRIDGE-6 spec Implementation Notes updated.

**Multi-tenancy gate at entry, not inside tx.** Throw before `db.transaction(...)` so the failure surfaces at the call site, not via "tx aborted with error: MissingTenantIdError". Same precedent as `BridgeDeliveryHandler.run` (BRIDGE-5).

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Decision 7, §`publishAndStart` + existing `triggers:` collision
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 7, risk #2 (single-tx requirement)
