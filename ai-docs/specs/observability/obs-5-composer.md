# OBS-5: ObservabilityService composer + module + protocol — Spec

**Issue:** #207 (OBS-5)
**Epic:** #195
**Status:** Draft
**Last Updated:** 2026-04-23
**Depends on:** OBS-2 (#204), OBS-3 (#205), OBS-4 (#206) — all merged to main

## Overview

Ships the core of the observability combiner subsystem: a single `ObservabilityService` that composes the read methods added to `IJobRunService` (OBS-2), `IJobBridge` (OBS-3), `ISyncRunRecorder` + `ICursorStore` (OBS-4) via DI, plus `ObservabilityModule` + protocol + tokens + errors + barrel. Read-only, backend-less combiner — no schema, no `forRoot({ backend })` branching, no memory-vs-drizzle backends. Structurally identical to `BridgeModule` + `EventFlowService` per ADR-025.

Every sibling port injected with `@Optional()` so the subsystem degrades gracefully: missing sibling → empty shape, not boot failure. `tenantId` passes through verbatim to the owning port — observability never re-implements tenant filtering.

## Architecture

```
consumer use case / reporter
           │
           ▼
   ┌─────────────────────┐
   │ ObservabilityService│  @Injectable — implements IObservability
   └──┬────┬────┬────┬───┘
      │    │    │    │   (all @Optional — missing port → empty shape)
      │    │    │    │
      ▼    ▼    ▼    ▼
 JOB_RUN_   BRIDGE_   SYNC_RUN_   SYNC_CURSOR_
 SERVICE    DELIVERY_ RECORDER    STORE
            REPO
 (jobs)    (bridge)   (sync)      (sync)
```

Consumer wires sibling modules BEFORE `ObservabilityModule.forRoot()`. ObservabilityModule has NO `imports` of sibling modules — consumes their tokens via DI exactly like `BridgeModule`.

## Files

| File | Action | Purpose |
|---|---|---|
| `runtime/subsystems/observability/observability.protocol.ts` | create | `IObservability` port + re-export of composed sibling types |
| `runtime/subsystems/observability/observability.service.ts` | create | `ObservabilityService` — single class, delegates to sibling ports |
| `runtime/subsystems/observability/observability.module.ts` | create | `ObservabilityModule.forRoot(options?)`, `global: true`, combiner docstring |
| `runtime/subsystems/observability/observability.tokens.ts` | create | `OBSERVABILITY`, `OBSERVABILITY_MODULE_OPTIONS` string constants |
| `runtime/subsystems/observability/observability-errors.ts` | create | `ObservabilityError` base class (reserved for future extension) |
| `runtime/subsystems/observability/index.ts` | create | Barrel — protocol + composed types + tokens + module + errors. Does NOT export service class. |
| `runtime/subsystems/observability/__tests__/observability.service.spec.ts` | create | Service unit tests (memory-backend composition + empty-port degradation) |
| `runtime/subsystems/observability/__tests__/observability.module.spec.ts` | create | Module wiring tests via Nest TestingModule |

## Interfaces

### `observability.protocol.ts`

```typescript
import type { PoolStatusCount, JobRunFailure } from '../jobs/job-run-service.protocol';
import type { StatusHistogram } from '../bridge/bridge.protocol';
import type { SyncRunSummary } from '../sync/sync-run-recorder.protocol';
import type { CursorSnapshot } from '../sync/sync-cursor-store.protocol';

/**
 * IObservability — read-only composer port (ADR-025 combiner subsystem).
 *
 * Every method:
 *   - Accepts an optional `tenantId` passed verbatim to the owning sibling
 *     port. Observability NEVER re-implements tenant filtering.
 *     undefined = "not provided" (sibling applies default), null = cross-tenant,
 *     string = single-tenant scope.
 *   - Returns an empty shape (not throws) if the owning sibling port is
 *     absent in the consumer's DI container.
 */
export interface IObservability {
  /** Delegates to IJobRunService.countByPoolAndStatus. Empty array when jobs absent. */
  getPoolDepths(tenantId?: string | null): Promise<PoolStatusCount[]>;

  /** Delegates to IJobRunService.listRecentFailed. Empty array when jobs absent. */
  getRecentFailedJobs(limit: number, tenantId?: string | null): Promise<JobRunFailure[]>;

  /** Delegates to IJobBridge.getStatusHistogram. Zeroed histogram when bridge absent. */
  getBridgeDeliveryHistogram(windowHours: number, tenantId?: string | null): Promise<StatusHistogram>;

  /** Delegates to ISyncRunRecorder.listRecent. Empty array when sync recorder absent. */
  getRecentSyncRuns(limit: number, subscriptionId?: string, tenantId?: string | null): Promise<SyncRunSummary[]>;

  /** Delegates to ICursorStore.listAll. Empty array when cursor store absent. */
  getCursors(tenantId?: string | null): Promise<CursorSnapshot[]>;
}

export type { PoolStatusCount, JobRunFailure, StatusHistogram, SyncRunSummary, CursorSnapshot };
```

### `observability.tokens.ts`

```typescript
/**
 * String constants (not Symbols) — matches events/bridge/sync convention.
 */
export const OBSERVABILITY = 'OBSERVABILITY' as const;
export const OBSERVABILITY_MODULE_OPTIONS = 'OBSERVABILITY_MODULE_OPTIONS' as const;
```

### `observability-errors.ts`

```typescript
/**
 * Base for observability-specific errors.
 * Phase-1 methods do not throw — they degrade to empty shapes.
 * This class exists so future extensions have a named base without churning the barrel.
 */
export class ObservabilityError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ObservabilityError';
  }
}
```

### `observability.service.ts`

```typescript
import { Inject, Injectable, Optional } from '@nestjs/common';

import { JOB_RUN_SERVICE } from '../jobs/jobs-domain.tokens';
import type { IJobRunService, PoolStatusCount, JobRunFailure } from '../jobs/job-run-service.protocol';

import { BRIDGE_DELIVERY_REPO } from '../bridge/bridge.tokens';
import type { IJobBridge, StatusHistogram } from '../bridge/bridge.protocol';

import { SYNC_RUN_RECORDER, SYNC_CURSOR_STORE } from '../sync/sync.tokens';
import type { ISyncRunRecorder, SyncRunSummary } from '../sync/sync-run-recorder.protocol';
import type { ICursorStore, CursorSnapshot } from '../sync/sync-cursor-store.protocol';

import type { IObservability } from './observability.protocol';

/**
 * ObservabilityService — IObservability combiner implementation.
 *
 * Composes read methods across jobs / bridge / sync via DI. Owns no state,
 * no schema, no SQL. Every method is a one-liner delegation to the
 * corresponding sibling port; missing ports return empty shapes.
 *
 * Multi-tenancy: tenantId is passed VERBATIM to the owning port. Observability
 * never re-implements tenant filtering. See ADR-025 and `.claude/skills/observability/SKILL.md`.
 */
@Injectable()
export class ObservabilityService implements IObservability {
  private static readonly EMPTY_HISTOGRAM: StatusHistogram = {
    pending: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
  };

  constructor(
    @Optional() @Inject(JOB_RUN_SERVICE) private readonly jobRuns?: IJobRunService,
    @Optional() @Inject(BRIDGE_DELIVERY_REPO) private readonly bridge?: IJobBridge,
    @Optional() @Inject(SYNC_RUN_RECORDER) private readonly syncRuns?: ISyncRunRecorder,
    @Optional() @Inject(SYNC_CURSOR_STORE) private readonly cursors?: ICursorStore,
  ) {}

  async getPoolDepths(tenantId?: string | null): Promise<PoolStatusCount[]> {
    if (!this.jobRuns) return [];
    return this.jobRuns.countByPoolAndStatus(tenantId);
  }

  async getRecentFailedJobs(limit: number, tenantId?: string | null): Promise<JobRunFailure[]> {
    if (!this.jobRuns) return [];
    return this.jobRuns.listRecentFailed(limit, tenantId);
  }

  async getBridgeDeliveryHistogram(windowHours: number, tenantId?: string | null): Promise<StatusHistogram> {
    if (!this.bridge) return ObservabilityService.EMPTY_HISTOGRAM;
    return this.bridge.getStatusHistogram(windowHours, tenantId);
  }

  async getRecentSyncRuns(limit: number, subscriptionId?: string, tenantId?: string | null): Promise<SyncRunSummary[]> {
    if (!this.syncRuns) return [];
    return this.syncRuns.listRecent(limit, subscriptionId, tenantId);
  }

  async getCursors(tenantId?: string | null): Promise<CursorSnapshot[]> {
    if (!this.cursors) return [];
    return this.cursors.listAll(tenantId);
  }
}
```

### `observability.module.ts`

```typescript
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { OBSERVABILITY, OBSERVABILITY_MODULE_OPTIONS } from './observability.tokens';
import { ObservabilityService } from './observability.service';

/**
 * Reserved for phase 2 — OBS-6 extends with a `reporters` field for the
 * relocated BridgeMetricsReporter's interval + enable flag. Empty in phase 1.
 */
export interface ObservabilityModuleOptions {
  // Intentionally empty in phase 1. See OBS-6.
}

/**
 * ObservabilityModule — combiner subsystem (ADR-025) that composes
 * jobs / bridge / sync read ports into a single IObservability facade.
 *
 * Owned by none of the sibling subsystems; consumes their tokens via DI.
 * Sibling subsystems do not know observability exists. Mirrors BridgeModule:
 * global: true, no sibling imports, @Optional() on every injected token so
 * missing siblings degrade to empty results instead of boot failure.
 *
 * Unlike ADR-008 infrastructure subsystems, there is NO `backend` option —
 * observability has no schema. The backend is whatever the siblings use.
 *
 * Consumer wiring (sibling modules BEFORE this one, same rule as Bridge):
 *
 * ```ts
 * @Module({
 *   imports: [
 *     EventsModule.forRoot({ backend: 'drizzle' }),
 *     JobsDomainModule.forRoot({ backend: 'drizzle' }),
 *     BridgeModule.forRoot({ backend: 'drizzle' }),
 *     SyncModule.forRoot({ ... }),
 *     ObservabilityModule.forRoot(),
 *   ],
 * })
 * class AppModule {}
 * ```
 */
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: OBSERVABILITY_MODULE_OPTIONS, useValue: options },
      ObservabilityService,
      { provide: OBSERVABILITY, useExisting: ObservabilityService },
    ];

    return {
      module: ObservabilityModule,
      global: true,
      providers,
      exports: [OBSERVABILITY, OBSERVABILITY_MODULE_OPTIONS],
    };
  }
}
```

### `index.ts`

```typescript
/**
 * Observability combiner subsystem public API (ADR-025).
 * Re-exports protocol, composed types, tokens, module, errors.
 * Does NOT export ObservabilityService — consumers inject OBSERVABILITY token.
 */

export type {
  IObservability,
  PoolStatusCount,
  JobRunFailure,
  StatusHistogram,
  SyncRunSummary,
  CursorSnapshot,
} from './observability.protocol';

export { OBSERVABILITY, OBSERVABILITY_MODULE_OPTIONS } from './observability.tokens';
export { ObservabilityModule, type ObservabilityModuleOptions } from './observability.module';
export { ObservabilityError } from './observability-errors';
```

## Implementation Steps

1. Create tokens (`observability.tokens.ts`) — string constants matching bridge/events/sync convention.
2. Create error base (`observability-errors.ts`) — `ObservabilityError extends Error` with optional cause.
3. Create protocol (`observability.protocol.ts`) — import composed types from sibling protocols, declare `IObservability`, re-export types for the barrel.
4. Create service (`observability.service.ts`) — `@Injectable()` with four `@Optional() @Inject(...)` constructor params. Five one-line delegation methods with nullish guards.
5. Create module (`observability.module.ts`) — `@Module({})` class with static `forRoot()`. `global: true`, no `imports`. Providers bind `OBSERVABILITY` token to service via `useExisting`.
6. Create barrel (`index.ts`) — re-export protocol types, tokens, module + options, errors. Do NOT export service class.
7. Write service unit tests — use memory backends of jobs/bridge/sync via Nest TestingModule. Seed fixture data; assert composed results; assert empty-shape return on missing ports; verify `tenantId` passthrough via spy/mock.
8. Write module wiring tests — boot with all siblings, no siblings, partial siblings. Verify `@Optional()` degradation.

## Testing Strategy

- **Unit (service spec):** every method with present + absent siblings; `tenantId` passthrough; empty-shape fallbacks.
- **Unit (module spec):** Nest TestingModule composition; end-to-end through DI.
- **Reuse memory backends** that shipped in OBS-2/3/4 — no new fakes.
- **No integration tests** in this PR — OBS-8 handles smoke/baseline. Composer is backend-agnostic by construction.
- **Target:** 15–20 focused tests.

## Open Questions

- [x] **OBS-2/3/4 merge status** — confirmed merged on main (commits `0887a19`, `1222b2e`, `70d1932`). Epic branch rebased onto main; all port extensions + types are available.
- [ ] **Sync memory backend for tests.** OBS-4 spec noted sync might not ship dedicated memory backends. Check whether `MemoryRunRecorder` / `MemoryCursorStore` now exist post-OBS-4; if not, write inline fakes in the spec file.
- [ ] **`SYNC_CURSOR_STORE` token name.** Verify the exact export name (`SYNC_CURSOR_STORE` vs `CURSOR_STORE`) by reading `runtime/subsystems/sync/sync.tokens.ts` or equivalent.
- [ ] **`ObservabilityModuleOptions` empty-interface lint rule.** If `@typescript-eslint/no-empty-interface` is enforced, switch to `export type ObservabilityModuleOptions = Record<string, never>` or add a phantom reserved field.
- [ ] **Barrel exporting `ObservabilityService`.** Spec says no (keeps the service swappable, consumers always inject the token). Bridge's barrel DOES export `EventFlowService` — but bridge has multiple verbs and extension surface. Observability has neither. Keep hidden unless OBS-6 requires it for reporter wiring.

## References

- ADR-025: `docs/adrs/ADR-025-combiner-subsystems.md`
- Skill: `.claude/skills/observability/SKILL.md`
- Locked decisions: `.claude/specs/epic-195-architecture-decisions.md`
- Plan: `.claude/specs/epic-195-plan.md` §OBS-5
- Structural precedents:
  - `runtime/subsystems/bridge/bridge.module.ts`
  - `runtime/subsystems/bridge/event-flow.service.ts`
  - `runtime/subsystems/bridge/bridge.protocol.ts`
  - `runtime/subsystems/bridge/bridge.tokens.ts`
  - `runtime/subsystems/bridge/index.ts`
- Composed ports (now on main):
  - `runtime/subsystems/jobs/job-run-service.protocol.ts` + `jobs-domain.tokens.ts`
  - `runtime/subsystems/bridge/bridge.protocol.ts` + `bridge.tokens.ts`
  - `runtime/subsystems/sync/sync-run-recorder.protocol.ts` + `sync-cursor-store.protocol.ts` + `sync.tokens.ts`
