# EVT-6 — EventsModule Upgrade: TypedEventBus Provider + Multi-Tenancy Wiring

**Issue:** EVT-6
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-3 (generated TypedEventBus must exist), EVT-5 (Memory backend parity).
**Blocks:** EVT-7 (use-case templates inject TypedEventBus), EVT-8 (scaffold must emit updated module).

## Overview

Wire `TypedEventBus` as an injectable `TYPED_EVENT_BUS` provider in `EventsModule`. Expand `EventsModuleOptions` with `multi_tenant?: boolean`. Add `TYPED_EVENT_BUS` injection token to `events.tokens.ts`. The module remains `global: true` — `TypedEventBus` is available project-wide without per-module imports.

## Context

**What exists.** `EventsModule.forRoot()` provides only `EVENT_BUS`. Application code that wants typed events has to inject `EVENT_BUS` and cast. `TypedEventBus` is a generated class (EVT-3) but nothing wires it into NestJS DI yet.

**What this PR adds.** `TYPED_EVENT_BUS` token + provider. After this PR, use cases can inject either:
- `@Inject(EVENT_BUS)` → `IEventBus` (raw, backwards-compatible)
- `TypedEventBus` (generated injectable, typed) — recommended for generated use cases

Multi-tenancy: adds `EventsModuleOptions.multi_tenant` flag. When enabled, the drain loop and the `publish` path thread `tenantId` through. The exact service-layer changes mirror JOB-8 multi-tenancy for jobs.

## Architecture

```
EventsModule.forRoot({
  backend: 'drizzle',
  pools: ['events_change'],
  multi_tenant: false,
})
  ├── provides EVENT_BUS    → DrizzleEventBus (unchanged path)
  ├── provides TYPED_EVENT_BUS → TypedEventBus (NEW, wraps EVENT_BUS)
  └── provides EVENTS_MULTI_TENANT → false token
  
EventsModule.forRoot({ backend: 'memory' })
  ├── provides EVENT_BUS    → MemoryEventBus
  └── provides TYPED_EVENT_BUS → TypedEventBus (wraps memory bus)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/events/events.tokens.ts` | modify | Add `TYPED_EVENT_BUS`, `EVENTS_MULTI_TENANT` symbols |
| `runtime/subsystems/events/events.module.ts` | modify | Wire TypedEventBus + multi_tenant option |
| `runtime/subsystems/events/index.ts` | modify | Re-export `TypedEventBus`, `TYPED_EVENT_BUS`, `EVENTS_MULTI_TENANT` |

## Interfaces

```ts
// events.tokens.ts
export const EVENT_BUS = Symbol('EVENT_BUS');
export const TYPED_EVENT_BUS = Symbol('TYPED_EVENT_BUS');  // NEW
export const EVENTS_MULTI_TENANT = Symbol('EVENTS_MULTI_TENANT');  // NEW

// events.module.ts
export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis';
  redisUrl?: string;
  pools?: string[];
  multi_tenant?: boolean;  // NEW — default false
}
```

`TypedEventBus` is provided as `useClass: TypedEventBus` (it injects `EVENT_BUS` internally). NestJS resolves the internal injection automatically since `EVENT_BUS` is in the same global module.

## Implementation Steps

1. Add `TYPED_EVENT_BUS` and `EVENTS_MULTI_TENANT` to `events.tokens.ts`.
2. Add `multi_tenant?: boolean` to `EventsModuleOptions`.
3. In `EventsModule.forRoot()`, add two providers:
   - `{ provide: TYPED_EVENT_BUS, useClass: TypedEventBus }` — NestJS handles `@Inject(EVENT_BUS)` injection inside `TypedEventBus`.
   - `{ provide: EVENTS_MULTI_TENANT, useValue: options.multi_tenant ?? false }`.
4. Add `TypedEventBus` to the `providers` array so NestJS can instantiate it. Export `TYPED_EVENT_BUS`.
5. Update `forRootAsync()` to thread the same providers.
6. Multi-tenancy plumbing: `DrizzleEventBus` receives `EVENTS_MULTI_TENANT` token; when `true`, drain queries filter by `tenant_id`. `TypedEventBus.publish()` reads `opts.metadata?.tenantId` and threads through to `bus.publish()`.
7. Unit test: `EventsModule.forRoot({ backend: 'memory' })` boots; `TYPED_EVENT_BUS` resolves; `TypedEventBus.publish<T>()` dispatches through the memory bus.
8. Unit test: `multi_tenant: true` with no `tenantId` in metadata → throws `MissingTenantIdError` (or the events equivalent — check ADR-024 for the agreed exception name).

## Acceptance Criteria

- [ ] `TYPED_EVENT_BUS` token exported from `events.tokens.ts`.
- [ ] `EventsModule.forRoot({ backend: 'memory' })` provides `TYPED_EVENT_BUS` token resolving to `TypedEventBus`.
- [ ] `TypedEventBus` is `global: true` (inherited from module).
- [ ] `EventsModuleOptions.multi_tenant` defaults to `false`.
- [ ] `multi_tenant: false`: no tenant filtering, no `tenantId` parameter required.
- [ ] `multi_tenant: true`: drain loop filters by `tenant_id`; missing `tenantId` in publish throws.
- [ ] Unit test: module boots in NestJS test harness with memory backend; both tokens resolve.

## Testing Strategy

NestJS `Test.createTestingModule` unit test. No Docker needed — memory backend only.

## Open Questions

- **EVT-Q6** (TypedEventBus replaces EVENT_BUS in generated code): resolution affects whether both tokens are exported as first-class symbols in `index.ts` or only `TYPED_EVENT_BUS` is recommended.
- Exact exception class name for missing `tenantId` — follow jobs pattern (`MissingTenantIdError`) or events-specific name?

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Multi-tenancy"
- `docs/specs/JOB-5.md` — module wiring pattern
- `docs/specs/JOB-8.md` — multi-tenancy wiring pattern
- `runtime/subsystems/events/events.module.ts` — current module (start from this)
