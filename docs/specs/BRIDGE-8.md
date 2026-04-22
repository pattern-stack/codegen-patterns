# BRIDGE-8 — `BridgeModule.forRoot()` + Multi-Tenancy Enforcement

**Issue:** BRIDGE-8
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-4, BRIDGE-5, BRIDGE-6, BRIDGE-7.
**Blocks:** BRIDGE-9.

## Overview

The NestJS dynamic module that wires the entire bridge subsystem. Imports `JobsDomainModule` + `EventsModule`. Provides `BRIDGE_DELIVERY_REPO` (memory or drizzle), `EVENT_FLOW` (always the facade), `BRIDGE_REGISTRY` (from BRIDGE-6's generated file), and `BRIDGE_MULTI_TENANT`. Registers `BridgeDeliveryHandler` three times — one instance per reserved `events_*` pool — following the EVT-6 `TYPED_EVENT_BUS` provider shape. Multi-tenancy enforced at the three required sites via shared `assertTenantId` helper (JOB-8 / SYNC-6 precedent). End-to-end integration test lands here.

## Context

**What exists.** All the pieces (schema, protocols, repo backends, handler, codegen, facade). Nothing wires them together.

**What this PR adds.** The module. After this PR, `BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false })` in `AppModule` makes the full bridge operational.

## Architecture

```
BridgeModule.forRoot({ backend, multiTenant })  [global: true]
  imports: [JobsDomainModule, EventsModule]
  providers:
    - BRIDGE_MODULE_OPTIONS     useValue: opts
    - BRIDGE_MULTI_TENANT       useValue: opts.multiTenant ?? false
    - BRIDGE_REGISTRY           useValue: import from generated/registry.ts
    - BRIDGE_DELIVERY_REPO      backend === 'drizzle' ? DrizzleBridgeDeliveryRepo : MemoryBridgeDeliveryRepo
    - EVENT_FLOW                useExisting: EventFlowService
    - EventFlowService          class
    - BridgeDeliveryHandler     class (registered 3×, one per pool — see below)
  exports: all tokens

Handler registration (mirrors EVT-6 TYPED_EVENT_BUS provider shape):
  - One BridgeDeliveryHandler class declaration
  - Three factory providers, one per reserved pool, each registering
    the same class in the @JobHandler registry under pool=events_inbound / events_change / events_outbound.
  - The registration happens via a module OnModuleInit that calls
    jobsHandlerRegistry.register(handler, { pool }) three times.

Multi-tenancy enforcement — three sites, shared assertTenantId helper:
  1. EventFlowService.publishAndStart entry (before outbox insert)
  2. BridgeDeliveryHandler.handle entry (before reading delivery)
  3. DrizzleBridgeDeliveryRepo.insertDelivery before write
  Each site: multiTenant && tenantId === undefined → throw MissingTenantIdError(siteName).
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge.module.ts` | create | NestJS dynamic module |
| `runtime/subsystems/bridge/assert-tenant-id.ts` | create | Shared helper |
| `runtime/subsystems/bridge/event-flow.service.ts` | modify | Call `assertTenantId('publishAndStart', ...)` at entry |
| `runtime/subsystems/bridge/bridge-delivery-handler.ts` | modify | Call `assertTenantId('BridgeDeliveryHandler', ...)` at entry |
| `runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts` | modify | Call `assertTenantId('insertDelivery', ...)` before write |
| `src/__tests__/runtime/subsystems/bridge.module.spec.ts` | create | NestJS Test.createTestingModule harness |
| `test/scaffold/tests/bridge-e2e.test.ts` | create | Docker end-to-end |
| `runtime/subsystems/bridge/index.ts` | modify | Re-export module |

## Implementation Notes

### Multi-tenancy sites (all three required — do not skip any)

Per ADR-023 §Multi-tenancy null-tenantId + Phase 2 plan risk #6:

1. **`EventFlowService.publishAndStart` entry.** First line of the method; before any DB write. Error message: `"Missing tenantId at EventFlowService.publishAndStart when multiTenant=true. Pass opts.tenantId explicitly (including null for cross-tenant work)."`
2. **`BridgeDeliveryHandler.handle` entry.** First line inside `handle()`. Pulls resolved `tenantId` from `delivery.tenantId` (which the drain wrote from `event.metadata.tenantId`). If `multiTenant===true && tenantId===undefined` → `MissingTenantIdError('BridgeDeliveryHandler')`. The error transitions delivery to `failed`.
3. **`DrizzleBridgeDeliveryRepo.insertDelivery` before write.** Last-line defense. Even if callers skipped sites 1 and 2, a direct call to the repo catches it.

Shared helper `assertTenantId(site, multiTenant, tenantId)`:
```ts
if (multiTenant && tenantId === undefined) throw new MissingTenantIdError(site)
// explicit null passes
```

Error shape (message, fields, stack-friendliness) exactly matches `jobs-errors.ts/MissingTenantIdError` and `events-errors.ts/MissingTenantIdError`. Precedent: JOB-8 §Acceptance Criteria.

### Handler registration on three pools

EVT-6 shipped three providers for `TYPED_EVENT_BUS` using `useExisting`. BRIDGE-8 needs three *live* `@JobHandler` registrations for the same class, one per pool. The approach:

- Declare `BridgeDeliveryHandler` as a class provider.
- In `BridgeModule.onModuleInit`, call `jobsHandlerRegistry.register(handlerInstance, { pool: 'events_inbound' })` three times (one per reserved pool).
- `JobsDomainModule` must already expose a handler-registry port; if not, the surface added here is a narrow `register(handler, overrides)` method. Confirm in PR body.

### Reserved-pool concurrency default

Set in consumer config, not the module. BRIDGE-9 documents the default of 32 in CONSUMER-SETUP. This PR does not set a default — it trusts whatever pool config the consumer has.

## Acceptance Criteria

- [ ] `BridgeModule.forRoot({ backend: 'memory' })` boots in NestJS `Test.createTestingModule`.
- [ ] `BridgeModule.forRoot({ backend: 'drizzle' })` boots against Docker Postgres.
- [ ] All tokens resolve: `EVENT_FLOW`, `BRIDGE_DELIVERY_REPO`, `BRIDGE_REGISTRY`, `BRIDGE_MULTI_TENANT`.
- [ ] `BridgeDeliveryHandler` registered on all three reserved pools.
- [ ] Site 1 (`publishAndStart`): `multiTenant=true` + `tenantId=undefined` → `MissingTenantIdError('EventFlowService.publishAndStart')`.
- [ ] Site 2 (`BridgeDeliveryHandler.handle`): same flag + undefined → error; delivery transitions to `failed`.
- [ ] Site 3 (`DrizzleBridgeDeliveryRepo.insertDelivery`): same flag + undefined → error before any SQL write.
- [ ] Explicit `tenantId: null` passes at every site (cross-tenant work).
- [ ] End-to-end integration (Docker): `eventFlow.publish({ type: 'user.created', ... })` → drain writes delivery + wrapper → wrapper handler runs → user job row has `parent_run_id=<wrapper>.id`, `trigger_source='event'`, `trigger_ref=<event.id>`, `tenant_id` threaded end-to-end.
- [ ] `eventFlow.publishAndStart(...)` Case B end-to-end: eager run + pre-write delivery + drain skips. Final state: one user job row, status delivered.
- [ ] `just test-all` green.

## Testing Strategy

- **Unit** (NestJS test harness, memory backend): module boots, tokens resolve, three multi-tenancy sites each covered.
- **Integration** (Docker, `SCAFFOLD_INTEGRATION=1`): full fanout + Case B dedup + tenant threading.

## Gate/Checkpoint

**GATE before opening PR** — multi-tenancy review (security-sensitive). Coordinator reports via `.orchestration-gate-8.md`. User confirms:
- All three sites present.
- Error message shape matches JOB-8 / EVT-6 precedent.
- Explicit-null contract preserved for cross-tenant work.

## Open Questions

- [ ] **Handler-registry API surface.** Does `JobsDomainModule` already expose `register(handler, { pool })`? If not, the thin surface added here needs a cross-reference note in `jobs/SKILL.md`. Implementer confirms and, if adding the method, files a small follow-up issue to land it upstream in the jobs subsystem.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §`BridgeModule` and subsystem boundaries, §Multi-tenancy null-tenantId
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 8, risk #3 (3× handler registration), risk #6 (three enforcement sites)
- `docs/specs/JOB-8.md` §Acceptance Criteria — `MissingTenantIdError` precedent
- `docs/specs/EVT-6.md` §Implementation Steps — provider-shape precedent
