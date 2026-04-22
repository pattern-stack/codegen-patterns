# BRIDGE-2 — Protocols `IJobBridge` + `IEventFlow` and DI Tokens

**Issue:** BRIDGE-2
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-1.
**Blocks:** BRIDGE-3, BRIDGE-4, BRIDGE-5, BRIDGE-7, BRIDGE-8.

## Overview

Define the two public protocols, the DI tokens, and the errors module. This is the stable public API surface — every subsequent BRIDGE issue imports from these files. No implementations yet.

## Context

**What exists.** `runtime/subsystems/bridge/bridge-delivery.schema.ts` + barrel (from BRIDGE-1). No service layer.

**What this PR adds.** `IJobBridge` (repo-shaped ledger ops), `IEventFlow` (dev-facing facade from ADR-023 §Decision 7), injection tokens, and `MissingTenantIdError`. After this PR, both memory (BRIDGE-3) and Drizzle (BRIDGE-4) backends can be implemented against the same contract.

## Architecture

```
bridge.protocol.ts
  ├── IJobBridge (ledger repo)
  │     insertDelivery(row, tx?): Promise<void>            // throws on UNIQUE conflict
  │     findDelivery(eventId, triggerId): Promise<BridgeDeliveryRecord | null>
  │     markDelivered(id, userRunId, tx?): Promise<void>
  │     markSkipped(id, reason, tx?): Promise<void>
  │     markFailed(id, error, tx?): Promise<void>
  │
  └── IEventFlow (developer facade — ADR-023 §Decision 7)
        publish<T>(event): Promise<void>
        publishAndStart<T, J>(event, jobType, input, opts?): Promise<{ runId: string }>

bridge.tokens.ts
  BRIDGE_DELIVERY_REPO   = 'BRIDGE_DELIVERY_REPO'   as const
  EVENT_FLOW             = 'EVENT_FLOW'             as const
  BRIDGE_MULTI_TENANT    = 'BRIDGE_MULTI_TENANT'    as const
  BRIDGE_MODULE_OPTIONS  = 'BRIDGE_MODULE_OPTIONS'  as const
  BRIDGE_REGISTRY        = 'BRIDGE_REGISTRY'        as const  // injected by BRIDGE-8

bridge-errors.ts
  MissingTenantIdError   (shape mirrors jobs-errors / events-errors)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge.protocol.ts` | create | `IJobBridge` + `IEventFlow` interfaces |
| `runtime/subsystems/bridge/bridge.tokens.ts` | create | DI tokens |
| `runtime/subsystems/bridge/bridge-errors.ts` | create | `MissingTenantIdError` |
| `runtime/subsystems/bridge/index.ts` | modify | Re-export protocols, tokens, errors |

## Interfaces

`IEventFlow` signature is ADR-023 §Decision 7 verbatim (two verbs: `publish`, `publishAndStart`). `publishAndStart.opts` includes `parentRunId?: string` and `tenantId?: string | null` — explicit `null` opts into cross-tenant work, per JOB-8 contract.

`IJobBridge` is a thin repo contract. The framework handler (BRIDGE-5) calls these methods; the outbox drain (BRIDGE-4) calls `insertDelivery` inside its per-event tx; the facade (BRIDGE-7) calls `insertDelivery` for Case B pre-writes.

## Implementation Steps

1. Create `bridge.protocol.ts` with both interfaces and inline JSDoc citing ADR-023 §Decision 7 for `IEventFlow`.
2. Create `bridge.tokens.ts` using `as const` string tokens (matches events subsystem convention per EVT-6 §Implementation Notes).
3. Create `bridge-errors.ts` with `MissingTenantIdError(callSite: string)` — same shape as `runtime/subsystems/jobs/jobs-errors.ts`.
4. Re-export everything from `index.ts`.
5. Type-level test compiling a stub `class X implements IJobBridge` asserts interface shape.

## Acceptance Criteria

- [ ] `IEventFlow.publish<T extends EventType>(event: TypedEvent<T>): Promise<void>` declared.
- [ ] `IEventFlow.publishAndStart<T, J>(event, jobType, input, opts?)` declared with `opts.parentRunId?` and `opts.tenantId?: string | null`.
- [ ] `IJobBridge` has five methods: `insertDelivery`, `findDelivery`, `markDelivered`, `markSkipped`, `markFailed`. All accept optional `tx` last-arg.
- [ ] Tokens are string-valued `as const`.
- [ ] `MissingTenantIdError` exported; constructor takes the call-site name; error message names that site.
- [ ] Type-level test compiles without casts.

## Testing Strategy

- Type-level compile test in `src/__tests__/runtime/subsystems/bridge-protocol.spec.ts` — stub implementations.

## Gate/Checkpoint

None.

## Open Questions

None. Token-shape (string vs Symbol) resolved by EVT-6 precedent.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §Decision 7 (`IEventFlow`), §Schema (`IJobBridge` inferred)
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 2
- `docs/specs/EVT-6.md` §Implementation Notes — token shape rationale
- `docs/specs/JOB-8.md` — `MissingTenantIdError` shape
