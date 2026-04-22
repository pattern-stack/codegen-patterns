# BRIDGE-5 — Framework `BridgeDeliveryHandler`

**Issue:** BRIDGE-5
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-2, BRIDGE-3. (BRIDGE-4 dependency dropped — see Implementation Notes; BRIDGE-5 now ships before BRIDGE-4 per the 2026-04-22 resequence.)
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

- [x] `BridgeDeliveryHandler` declared with `@JobHandler('@framework/bridge_delivery', { pool: 'events_change', retry, replayFrom })`.
- [x] Unknown `trigger_id` → `markSkipped(id, 'trigger_unregistered')`. (ADR-023 §Trigger rename or removal.)
- [x] `when:` returning false → `markSkipped(id, 'predicate_false')`.
- [x] Successful `orchestrator.start` → `markDelivered(id, userRunId)` with `delivered_at` stamped.
- [x] Spawn wrapped in `ctx.step('spawn_user_run', ...)` for replay safety.
- [~] Exhausted retry → `markFailed(id, error)` — DEFERRED: requires JobWorker integration. The handler propagates throws so the worker's retry policy fires; the `markFailed` path is wired in BRIDGE-8 module init alongside the failure-handler hook.
- [~] Integration: user job row has `parent_run_id` = wrapper id, `trigger_source='event'`, `trigger_ref` = event id. — DEFERRED to BRIDGE-4 (drain integration test) / BRIDGE-8 (full module wiring). Unit tests pin the call shape: `orchestrator.start(jobType, input, { parentRunId: ctx.run.id, triggerSource: 'event', triggerRef: delivery.eventId, tenantId: delivery.tenantId })`.
- [x] Tenant threading: `delivery.tenantId` propagates to `orchestrator.start(..., { tenantId })`. `multiTenant=true` + `tenantId === undefined` throws `MissingTenantIdError('BridgeDeliveryHandler.run')`.

## Testing Strategy

- **Unit** (memory bridge repo + memory orchestrator): all branches.
- **Integration** (Docker, gated): full chain including wrapper claim by real `JobWorker`.

## Gate/Checkpoint

None.

## Open Questions

- [x] **Event-fetch port — RESOLVED.** Picked option (a): extended `IEventBus` with `findById(eventId): Promise<DomainEvent | null>`. `MemoryEventBus` searches its `publishedEvents` log; `DrizzleEventBus` runs `SELECT … WHERE id = ? LIMIT 1`; `RedisEventBus` returns `null` and warns once (Pub/Sub has no history; bridge usage of Redis backend is unsupported). Touches three files in events/ but is a small, scoped addition.

## Implementation Notes (added in PR per CLAUDE.md living-docs rule)

**`run` not `handle`.** The spec uses `handle(ctx)` in the Architecture sketch. The actual `JobHandlerBase` abstract method is `run(ctx)` (see `runtime/subsystems/jobs/job-handler.base.ts`). Implementation uses the real method name.

**`@JobHandler` signature.** The spec sketches `@JobHandler({ type: '@framework/bridge_delivery', ... })`. The actual decorator is `@JobHandler<TInput>(type: string, meta: JobHandlerMeta<TInput>)`. Implementation uses `@JobHandler<BridgeDeliveryInput>('@framework/bridge_delivery', { pool: 'events_change', retry: { attempts: 3, backoff: 'exponential', baseMs: 250 }, replayFrom: 'last_step' })`.

**One `@JobHandler` registration, three pools at runtime.** The spec called for "three instances, one per reserved pool." That isn't possible with the existing decorator (`JOB_HANDLER_REGISTRY` is keyed by job type, must be unique). Resolution: ONE registration with `pool: 'events_change'`. Wrapper `job_run` rows get their pool set per-row by the drain (`pool: events_<direction>`); workers polling each of `events_inbound`, `events_change`, `events_outbound` independently claim wrappers from their own pool and dispatch to the same handler class. The metadata pool is just a default for orphan-claim semantics; the row pool is what matters for routing.

**Reserved-pool validator exemption.** `assertNoReservedPoolHandlers` in `runtime/subsystems/jobs/job-worker.module.ts` previously rejected ANY `@JobHandler` targeting a reserved pool. Added a one-line exemption: `if (entry.type.startsWith('@framework/')) continue;`. The validator's job is keeping USER handlers out of reserved pools; the framework handler legitimately belongs there. ADR-022's reservation rule is preserved for user handlers.

**`BridgeRegistry` / `BridgeTriggerEntry` types added to `bridge.protocol.ts`.** The codegen-emitted registry's TYPE definition has to live somewhere both BRIDGE-5 (consumes it) and BRIDGE-6 (emits the value) can import from. Putting it in the protocol file keeps "shape vs value" cleanly split: types live in `bridge.protocol.ts`, the value lands in `bridge/generated/registry.ts` (BRIDGE-6).

**`IJobBridge.findDeliveryById(id)` added.** The wrapper input only carries `deliveryId`. The existing `findDelivery(eventId, triggerId)` is the canonical idempotency-key lookup but doesn't help here. Added a primary-key lookup to the protocol and the memory backend; BRIDGE-4 will implement the Drizzle version.

**Plan doc updated.** `docs/specs/BRIDGE-PHASE-2-PLAN.md` rows 4 and 5 carry a "Resequence" note; new "Resequence" subsection explains why BRIDGE-5 ships before BRIDGE-4 implementation-order-wise.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Decision 2 (flow diagram), §Trigger rename or removal
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 5
- `docs/specs/JOB-3.md` — `ctx.step` memoization semantics
