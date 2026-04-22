# BRIDGE-5 — Framework `BridgeDeliveryHandler`

**Issue:** BRIDGE-5
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-2, BRIDGE-3, BRIDGE-4.
**Blocks:** BRIDGE-8.

## Overview

The framework-owned `@JobHandler` class that runs on all three reserved `events_*` pools. Its job: dequeue a `bridge_delivery`, evaluate its `when:` predicate, call `IJobOrchestrator.start(...)` for the user job, and transition the ledger. Step-memoized so replays are safe.

## Context

**What exists.** After BRIDGE-4, the outbox drain writes `bridge_delivery` + wrapper `job_run` rows. Those wrapper rows are `type='@framework/bridge_delivery'` and sit in `events_<direction>` pools waiting for a handler. Nothing claims them yet.

**What this PR adds.** The handler that claims them. Three instances registered on the three reserved pools (BRIDGE-8 does the wiring; this PR ships the class).

## Architecture

```
BridgeDeliveryHandler
  @JobHandler({ type: '@framework/bridge_delivery', ... })
  handle(ctx) {
    const { deliveryId } = ctx.input;
    const delivery = await repo.findDelivery(...);
    const entry = bridgeRegistry[delivery.eventType]?.find(t => t.triggerId === delivery.triggerId);

    if (!entry) {
      return repo.markSkipped(delivery.id, 'trigger_unregistered');
    }

    const event = await eventStore.fetch(delivery.eventId);
    if (entry.when && !entry.when(event)) {
      return repo.markSkipped(delivery.id, 'predicate_false');
    }

    // Step-memoized spawn: replays are idempotent
    const { runId } = await ctx.step('spawn_user_run', async () => {
      return orchestrator.start(entry.jobType, entry.map(event), {
        parentRunId: ctx.run.id,
        triggerSource: 'event',
        triggerRef: delivery.eventId,
        tenantId: delivery.tenantId,
      });
    });

    await repo.markDelivered(delivery.id, runId);
  }
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge-delivery-handler.ts` | create | Framework handler class |
| `src/__tests__/runtime/subsystems/bridge-delivery-handler.spec.ts` | create | Unit (memory backends) |
| `test/scaffold/tests/bridge-handler.test.ts` | create | Docker integration (full fanout chain) |
| `runtime/subsystems/bridge/index.ts` | modify | Re-export |

## Implementation Steps

1. Declare `BridgeDeliveryHandler extends JobHandlerBase<{ deliveryId: string }>` with `@JobHandler({ type: '@framework/bridge_delivery', retry: { maxAttempts: 3 }, ... })`.
2. Inject `IJobBridge` (BRIDGE_DELIVERY_REPO), `IJobOrchestrator` (JOB_ORCHESTRATOR), `BRIDGE_REGISTRY`, event-fetch port (use `IEventBus` or a dedicated fetch interface — if none exists, add a `findEventById` method on `IJobBridge` or a small new port; flag as open question).
3. Handler body as per Architecture. Wrap the `orchestrator.start` call inside `ctx.step('spawn_user_run', ...)` for replay idempotency (memoization comes from JOB-3 step infrastructure).
4. Error handling: any throw inside `ctx.step` → wrapper's retry policy triggers. On final exhaustion, wrapper transitions to `failed`; handler catches and calls `repo.markFailed(delivery.id, error)`.
5. Unit tests against memory backends cover: happy path, unknown trigger (`skip_reason='trigger_unregistered'`), predicate false (`skip_reason='predicate_false'`), start throws → wrapper retries → final failure → `markFailed`, replay-after-success (step memo returns cached result, no double-spawn).
6. Docker integration test: full fanout — publish event → drain writes delivery + wrapper → wrapper claimed by worker → handler runs → user job row exists with correct `parent_run_id`, `trigger_source='event'`, `trigger_ref=<event.id>`.

## Acceptance Criteria

- [ ] `BridgeDeliveryHandler` declared with `@JobHandler({ type: '@framework/bridge_delivery' })`.
- [ ] Unknown `trigger_id` → `markSkipped(id, 'trigger_unregistered')`. (ADR-023 §Trigger rename or removal.)
- [ ] `when:` returning false → `markSkipped(id, 'predicate_false')`.
- [ ] Successful `orchestrator.start` → `markDelivered(id, userRunId)` with `delivered_at` stamped.
- [ ] Spawn wrapped in `ctx.step('spawn_user_run', ...)` for replay safety.
- [ ] Exhausted retry → `markFailed(id, error)` with JSON error payload.
- [ ] Integration: user job row has `parent_run_id` = wrapper id, `trigger_source='event'`, `trigger_ref` = event id.
- [ ] Tenant threading: `delivery.tenantId` propagates to `orchestrator.start(..., { tenantId })`.

## Testing Strategy

- **Unit** (memory bridge repo + memory orchestrator): all branches.
- **Integration** (Docker, gated): full chain including wrapper claim by real `JobWorker`.

## Gate/Checkpoint

None.

## Open Questions

- [ ] **Event-fetch port.** The handler needs to re-fetch the `domain_events` row to re-run `when:` / `map:` at claim time (event arguments to those callbacks must be authoritative, not cached from drain time). No existing `IEventBus` method returns a single event by id. Options: (a) extend `IEventBus` with `findById(eventId)`, (b) add to `IJobBridge`, (c) inject a new narrow port. Implementer picks one and updates BRIDGE-2 spec if a new method is added. Flag in PR body.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Decision 2 (flow diagram), §Trigger rename or removal
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 5
- `docs/specs/JOB-3.md` — `ctx.step` memoization semantics
