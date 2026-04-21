# EVT-6 — EventsModule Upgrade: TypedEventBus Provider + Multi-Tenancy Wiring

**Issue:** EVT-6
**Status:** Implemented
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-3 (generated TypedEventBus must exist), EVT-5 (Memory backend parity).
**Blocks:** EVT-7 (use-case templates inject TypedEventBus), EVT-8 (scaffold must emit updated module).

## Overview

Wire `TypedEventBus` as an injectable `TYPED_EVENT_BUS` provider in `EventsModule`. Expand `EventsModuleOptions` with `multiTenant?: boolean`. Both the `TYPED_EVENT_BUS` and `EVENTS_MULTI_TENANT` injection tokens live in `events.tokens.ts`. The module remains `global: true` — `TypedEventBus` is available project-wide without per-module imports.

## Context

**What exists before this PR.** `EventsModule.forRoot()` provides only `EVENT_BUS`. Application code that wants typed events has to inject `EVENT_BUS` and cast. `TypedEventBus` is a generated class (EVT-3) but nothing wires it into NestJS DI yet. The `TYPED_EVENT_BUS` token was already declared by EVT-3 with a "Provider registration lands in EVT-6" note; this PR lands it.

**What this PR adds.** `TYPED_EVENT_BUS` wiring + `EVENTS_MULTI_TENANT` token/provider + publish-side tenant enforcement inside `TypedEventBus`. After this PR, use cases inject either:

- `@Inject(EVENT_BUS)` → `IEventBus` (raw port)
- `TypedEventBus` (generated injectable, typed) — recommended for generated use cases

Multi-tenancy: `EventsModuleOptions.multiTenant` (camelCase; EVT-4 placeholder) is wired through to `TypedEventBus`. Publish-side enforcement is all this PR ships — see Implementation Notes §"Drain-side tenancy deferred".

## Architecture

```
EventsModule.forRoot({
  backend: 'drizzle',
  pools: ['events_change'],
  multiTenant: false,
})
  ├── provides EVENT_BUS            → DrizzleEventBus
  ├── provides TypedEventBus        → TypedEventBus (class)
  ├── provides TYPED_EVENT_BUS      → useExisting: TypedEventBus
  └── provides EVENTS_MULTI_TENANT  → useValue: false

EventsModule.forRoot({ backend: 'memory' })
  ├── provides EVENT_BUS            → MemoryEventBus
  ├── provides TypedEventBus        → TypedEventBus (class)
  ├── provides TYPED_EVENT_BUS      → useExisting: TypedEventBus
  └── provides EVENTS_MULTI_TENANT  → useValue: false
```

`TYPED_EVENT_BUS` is a `useExisting` alias for the `TypedEventBus` class. This makes `moduleRef.get(TYPED_EVENT_BUS)` and `moduleRef.get(TypedEventBus)` return the same instance.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/events/events.tokens.ts` | modify | Add `EVENTS_MULTI_TENANT`. `TYPED_EVENT_BUS` already shipped in EVT-3. |
| `runtime/subsystems/events/events.module.ts` | modify | Wire `TypedEventBus`, `TYPED_EVENT_BUS`, `EVENTS_MULTI_TENANT` in all three `forRoot` branches + `forRootAsync`. |
| `runtime/subsystems/events/events-errors.ts` | create | `MissingTenantIdError` (mirrors jobs-errors.ts). |
| `runtime/subsystems/events/generated/bus.ts` | modify | `TypedEventBus` constructor now also injects `EVENTS_MULTI_TENANT`; `publish()` throws `MissingTenantIdError` when `multiTenant === true` and `tenantId` absent. |
| `runtime/subsystems/events/index.ts` | modify | Re-export `EVENTS_MULTI_TENANT`, `MissingTenantIdError`. |
| `src/cli/shared/event-codegen-generator.ts` | modify | Emit the updated `TypedEventBus` constructor + multi-tenant check. |
| `test/baseline/runtime/subsystems/events/generated/bus.ts` | modify | Baseline snapshot refresh matching the new generator output. |
| `src/__tests__/runtime/subsystems/events-module.spec.ts` | create | NestJS test harness coverage (`Test.createTestingModule`). |
| `src/__tests__/cli/event-codegen-generator.test.ts` | modify | Assertions updated for new imports + multi-tenant check. |

## Interfaces

```ts
// events.tokens.ts — existing + new
export const EVENT_BUS = 'EVENT_BUS' as const;
export const TYPED_EVENT_BUS = 'TYPED_EVENT_BUS' as const;      // shipped in EVT-3
export const EVENTS_MULTI_TENANT = 'EVENTS_MULTI_TENANT' as const; // NEW
export const EVENTS_MODULE_OPTIONS = 'EVENTS_MODULE_OPTIONS' as const;
export const REDIS_URL = Symbol('REDIS_URL');

// events.module.ts
export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis';
  redisUrl?: string;
  pools?: string[];
  multiTenant?: boolean; // default false
}
```

## Implementation Steps

1. Add `EVENTS_MULTI_TENANT` token to `events.tokens.ts` (string-valued — see Implementation Notes).
2. Create `events-errors.ts` with `MissingTenantIdError`, mirroring `jobs-errors.ts` style.
3. Update `TypedEventBus` constructor in `runtime/subsystems/events/generated/bus.ts` AND the generator in `src/cli/shared/event-codegen-generator.ts` to inject `EVENTS_MULTI_TENANT` as a second constructor arg. Refresh the baseline snapshot.
4. In `TypedEventBus.publish`:
   - Read `tenantId` from `opts?.metadata?.['tenantId']`.
   - If `this.multiTenant && tenantId == null` → throw `MissingTenantIdError(type)`.
   - Otherwise fall through; `metadata` spreads `opts.metadata` first, so tenantId persists into the outbox (EVT-4 already writes `metadata.tenantId` into `domain_events.tenant_id`).
5. In `EventsModule.forRoot()`, register three new providers across every branch (drizzle / memory / redis) and in `forRootAsync`:
   - `TypedEventBus` (the class itself)
   - `{ provide: TYPED_EVENT_BUS, useExisting: TypedEventBus }`
   - `{ provide: EVENTS_MULTI_TENANT, useValue: options.multiTenant ?? false }`
   Export `TYPED_EVENT_BUS` and `EVENTS_MULTI_TENANT` alongside `EVENT_BUS`.
6. NestJS unit tests in `src/__tests__/runtime/subsystems/events-module.spec.ts` (see Testing Strategy).

## Implementation Notes

**Drain-side tenancy deferred.** The original spec described "`DrizzleEventBus` receives `EVENTS_MULTI_TENANT` token; when true, drain queries filter by tenant_id." That remains architecturally unclear — ADR-024 §Multi-tenancy is non-specific about *where* the tenant context comes from at drain time (per-process env? per-request ALS? a scheduler?). Publish-side enforcement (`TypedEventBus` throws when required tenantId is absent) is sufficient to guarantee every outbox row has a tenantId when the module opts in; drain-side filtering can ship once the tenant-context model is settled. Tracked as a follow-up.

**Token naming divergence from jobs.** `EVENTS_MULTI_TENANT` is a string (`'EVENTS_MULTI_TENANT' as const`); `JOBS_MULTI_TENANT` in the jobs subsystem is a `Symbol`. The events subsystem chose string constants from the start (see `EVENT_BUS`, `EVENTS_MODULE_OPTIONS`) so tokens match by value across import boundaries; keeping the whole `events.tokens.ts` consistent on that choice beats uniformity with jobs. Documented inline in `events.tokens.ts`.

**camelCase option name.** EVT-4 landed `multiTenant?: boolean` (camelCase) on `EventsModuleOptions`. Earlier spec drafts said `multi_tenant`; the TypeScript reality is camelCase and stays that way.

**`TYPED_EVENT_BUS` pre-shipped.** EVT-3 already added `TYPED_EVENT_BUS` to `events.tokens.ts` with a "Provider registration lands in EVT-6" JSDoc. This PR lands the provider — no token changes.

## Acceptance Criteria

- [x] `EVENTS_MULTI_TENANT` token exported from `events.tokens.ts`.
- [x] `MissingTenantIdError` exported from `runtime/subsystems/events/events-errors.ts` and re-exported from the package barrel.
- [x] `EventsModule.forRoot({ backend: 'memory' })` provides `TYPED_EVENT_BUS` token resolving to a `TypedEventBus` instance.
- [x] `EventsModule` is `global: true` (DynamicModule shape + cross-module resolution verified in tests).
- [x] `EventsModuleOptions.multiTenant` defaults to `false`; `EVENTS_MULTI_TENANT` provider reflects resolved value.
- [x] `multiTenant: false`: no tenantId required; `TypedEventBus.publish` succeeds without metadata.
- [x] `multiTenant: true`: missing tenantId in publish throws `MissingTenantIdError`; provided tenantId is preserved on `event.metadata`.
- [x] `forRootAsync` path wires the same providers from an async factory.
- [x] Unit test: module boots in NestJS test harness with memory backend; both tokens resolve.
- [x] Generator output (`buildBusContent`) + runtime file + baseline snapshot all byte-identical.
- [ ] ~Drain loop filters by tenant_id when `multiTenant: true`.~ **Deferred** — see Implementation Notes §"Drain-side tenancy deferred".

## Testing Strategy

NestJS `Test.createTestingModule` unit tests covering memory backend. No Docker needed. The Drizzle and Redis branches are asserted at the `DynamicModule` shape level (providers array + exports list) without compiling — compiling them would require pulling in a real Drizzle client / Redis connection. Their runtime wiring is exercised by `just test-family` / `just test-integration`.

## Open Questions

- **EVT-Q6** (TypedEventBus replaces EVENT_BUS in generated code): unresolved. Does not block EVT-6. The `EVENT_BUS` token remains exported; typed callers inject `TypedEventBus` (or `TYPED_EVENT_BUS`), untyped callers still have the raw port.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Multi-tenancy"
- `docs/specs/JOB-5.md` — module wiring pattern
- `docs/specs/JOB-8.md` — multi-tenancy wiring pattern (jobs analog)
- `runtime/subsystems/events/events.module.ts` — updated module
- `runtime/subsystems/jobs/jobs-errors.ts` — error-class style mirror
