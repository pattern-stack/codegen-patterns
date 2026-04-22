# BRIDGE-8 — `BridgeModule.forRoot()` + Multi-Tenancy Enforcement

**Issue:** BRIDGE-8
**Status:** Shipped (2026-04-22)
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-4, BRIDGE-5, BRIDGE-6, BRIDGE-7.
**Blocks:** BRIDGE-9.

## Overview

The NestJS dynamic module that wires the entire bridge subsystem. Provides `BRIDGE_DELIVERY_REPO` (memory or drizzle), `EVENT_FLOW` (always the facade), `BRIDGE_REGISTRY` (from BRIDGE-6's generated file), `BRIDGE_MULTI_TENANT`, `BRIDGE_OUTBOX_DRAIN_HOOK`, and `BRIDGE_MODULE_OPTIONS`. Provides the framework `BridgeDeliveryHandler` as a Nest provider so DI resolves its constructor deps; the `@JobHandler` decorator auto-registers it ONCE in `JOB_HANDLER_REGISTRY` (per-pool routing happens via `job_run.pool='events_<direction>'` set by the drain hook — workers polling each of the three reserved pools dispatch to the same handler class). Boot-time check in `onModuleInit` throws `BridgeReservedPoolsNotPolledError` if `JobWorkerModule` isn't polling all three reserved pools. Multi-tenancy enforced at the three required sites via shared `assertTenantId` helper (JOB-8 / SYNC-6 precedent). End-to-end integration test scaffold lands as a `.skip()`'d placeholder pending fixture work.

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

### Handler registration on three pools (REVISED 2026-04-22)

The pre-implementation plan called for "register the handler three times, one per pool". **That was wrong.** The actual shipped story:

- ONE `@JobHandler('@framework/bridge_delivery', ...)` decoration on `BridgeDeliveryHandler`. The decorator auto-registers the class in `JOB_HANDLER_REGISTRY` at module-load time — there is no per-pool registration API, and there shouldn't be: a handler class is a singleton in DI.
- The framework handler class is reachable from any worker via `JOB_HANDLER_REGISTRY.get('@framework/bridge_delivery')`.
- Per-direction routing happens via `job_run.pool='events_<direction>'` set by `BridgeOutboxDrainHook` (BRIDGE-4). Workers polling each reserved pool independently claim wrappers from THEIR pool and dispatch to the same handler class — the worker filter is on `job_run.pool`, not on `@JobHandler.meta.pool`.
- The reserved-pool validator exemption (BRIDGE-5 added the `@framework/*`-prefix bypass to `JobWorkerOrchestrator.assertNoReservedPoolHandlers`) lets the framework handler legitimately target a reserved pool.

What BRIDGE-8 actually does to ensure all three reserved pools are claimed:
1. Exports `BRIDGE_RESERVED_POOLS` constant — consumers spread it into `JobWorkerModule.forRoot({ pools })` so all three reserved pools are polled.
2. `BridgeModule.onModuleInit` injects `JOB_WORKER_MODULE_OPTIONS` (`@Optional()`), reads `options.pools`, and throws `BridgeReservedPoolsNotPolledError` listing every missing reserved pool. This converts a silent footgun ("wrappers sit pending forever") into a fail-fast at boot.

Cross-link: ADR-023 §`BridgeModule` and subsystem boundaries — the same clarification is recorded with a dated revision note.

### Reserved-pool concurrency default

Set in consumer config, not the module. BRIDGE-9 documents the default of 32 in CONSUMER-SETUP. This PR does not set a default — it trusts whatever pool config the consumer has.

## Acceptance Criteria

- [x] `BridgeModule.forRoot({ backend: 'memory' })` boots in NestJS `Test.createTestingModule`.
- [x] `BridgeModule.forRoot({ backend: 'drizzle' })` boots against a mocked DRIZZLE token in `bridge.module.spec.ts`. Real Docker Postgres boot is exercised transitively by `just test-family` paths that mount the bridge.
- [x] All tokens resolve: `EVENT_FLOW`, `BRIDGE_DELIVERY_REPO`, `BRIDGE_REGISTRY`, `BRIDGE_MULTI_TENANT`, `BRIDGE_MODULE_OPTIONS`, `BRIDGE_OUTBOX_DRAIN_HOOK` (six tokens, not four — corrected from the pre-implementation list).
- [x] ~~`BridgeDeliveryHandler` registered on all three reserved pools.~~ **Replaced** (see §"Handler registration on three pools" above): the handler is registered ONCE via `@JobHandler`; what BRIDGE-8 actually ships is `BRIDGE_RESERVED_POOLS` + a boot-time check that throws `BridgeReservedPoolsNotPolledError` when `JobWorkerModule` isn't polling all three reserved pools.
- [x] Site 1 (`publishAndStart`): `multiTenant=true` + `tenantId=undefined` → `MissingTenantIdError('EventFlowService.publishAndStart')`. Pinned by `event-flow.service.spec.ts`; refactored to use the shared `assertTenantId` helper.
- [x] Site 2 (`BridgeDeliveryHandler.run`): same flag + undefined → error. Pinned by `bridge-delivery-handler.spec.ts`; refactored to use the shared `assertTenantId` helper. Delivery-failed transition is the worker's normal `markFailed` path on uncaught throws.
- [x] Site 3 (`DrizzleBridgeDeliveryRepo.insertDelivery`): same flag + undefined → error BEFORE any SQL write. **NEW** in BRIDGE-8 (BRIDGE-4 didn't include site (c)); pinned by new tests in `bridge.module.spec.ts`. Cross-link: BRIDGE-4 spec gets a follow-up note.
- [x] Explicit `tenantId: null` passes at every site (cross-tenant work). Pinned by all three sites' tests.
- [ ] ~~End-to-end integration (Docker)~~ — placeholder `.skip()`'d in `test/scaffold/tests/bridge-e2e.test.ts`. Setting up a real fanout requires extending the scaffold YAML with a triggered handler + event fixture; that work exceeds BRIDGE-8's scope. Unit-level coverage in `bridge-outbox-drain-hook.spec.ts` (drain → bridge_delivery + wrapper) and `bridge-delivery-handler.spec.ts` (wrapper → user job, parent/trigger threading) already pins the behaviour.
- [ ] ~~`eventFlow.publishAndStart(...)` Case B end-to-end~~ — same fixture dependency, also `.skip()`'d. Unit-level coverage in `event-flow.service.spec.ts` covers Case B against a faked tx + memory-backed repo.
- [x] `just test-all` green (1358 unit + baseline + smoke pass).

## Testing Strategy

- **Unit** (NestJS test harness, memory backend): module boots, tokens resolve, three multi-tenancy sites each covered.
- **Integration** (Docker, `SCAFFOLD_INTEGRATION=1`): full fanout + Case B dedup + tenant threading.

## Gate/Checkpoint

**GATE before opening PR** — multi-tenancy review (security-sensitive). Coordinator reports via `.orchestration-gate-8.md`. User confirms:
- All three sites present.
- Error message shape matches JOB-8 / EVT-6 precedent.
- Explicit-null contract preserved for cross-tenant work.

## Open Questions

- [x] ~~**Handler-registry API surface.** Does `JobsDomainModule` already expose `register(handler, { pool })`?~~ **Resolved 2026-04-22**: question doesn't apply — see §"Handler registration on three pools" above. There is no per-pool registration; routing is by `job_run.pool` and the framework handler is registered once via `@JobHandler` like every other handler.

## Implementation Notes (added in PR per CLAUDE.md living-docs rule)

Discoveries and decisions during implementation that the pre-implementation plan missed:

1. **`assertTenantId` helper extraction.** Sites (a) `EventFlowService.publishAndStart`, (b) `BridgeDeliveryHandler.run`, and (c) `DrizzleBridgeDeliveryRepo.insertDelivery` previously had inline `if (this.multiTenant && tenantId === undefined) throw ...` checks. BRIDGE-8 extracts the check to `runtime/subsystems/bridge/assert-tenant-id.ts` and re-exports from the bridge barrel. Behaviour-preserving — existing BRIDGE-5 / BRIDGE-7 multi-tenancy tests continue to pass without modification, which is the cleanest possible signal that the helper is faithful.

2. **Site (c) added in BRIDGE-8 (not BRIDGE-4).** The BRIDGE-4 PR shipped sites (a) and (b) but missed (c). Adding `@Optional() @Inject(BRIDGE_MULTI_TENANT) multiTenant: boolean = false` to `DrizzleBridgeDeliveryRepo` plus the helper call before any SQL write closes the gap. New tests in `bridge.module.spec.ts` assert the throw fires before any SQL is captured by the `drizzle-orm/pg-proxy` driver. A follow-up note appended to `docs/specs/BRIDGE-4.md` cross-links this completion.

3. **`BRIDGE_RESERVED_POOLS` const + `BridgeReservedPoolsNotPolledError`.** Lives in `runtime/subsystems/bridge/reserved-pools.ts` (own file to keep the `bridge.module.ts` import graph acyclic) and re-exported from the barrel. Consumers spread `...BRIDGE_RESERVED_POOLS` into `JobWorkerModule.forRoot({ pools })`. The boot-time check in `BridgeModule.onModuleInit` injects `JOB_WORKER_MODULE_OPTIONS` `@Optional()` and throws `BridgeReservedPoolsNotPolledError` listing every missing pool. (Skipped when `JobWorkerModule` isn't mounted — e.g. unit tests that mount `BridgeModule` alone.)

4. **`JOB_WORKER_MODULE_OPTIONS` was a module-private symbol.** Promoted to an exported const in `runtime/subsystems/jobs/job-worker.module.ts` so `BridgeModule` can `@Inject` it. Documented at the export site as the supported integration point.

5. **ADR-023 clarification.** §`BridgeModule` and subsystem boundaries was rewritten to drop "registers the framework `BridgeDeliveryHandler` on all three reserved pools" (which was the pre-implementation misconception) in favour of the correct story; a dated revision note was added at the top of the section. Resolved Question 1 in the same ADR was rewritten to match.

6. **Integration test is `.skip()`'d.** See updated AC. The fixture work needed to exercise a real fanout end-to-end is larger than BRIDGE-8 itself; filed as a follow-up so the smoke + family integration suites can pick it up.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §`BridgeModule` and subsystem boundaries, §Multi-tenancy null-tenantId
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 8, risk #3 (3× handler registration), risk #6 (three enforcement sites)
- `docs/specs/JOB-8.md` §Acceptance Criteria — `MissingTenantIdError` precedent
- `docs/specs/EVT-6.md` §Implementation Steps — provider-shape precedent
