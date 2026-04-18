# JOB-5 — `JobsDomainModule.forRoot()` + `JobWorkerModule.forRoot()` with Pool Config Loader

**Issue:** JOB-5
**Status:** Draft
**Last Updated:** 2026-04-18
**Depends on:** JOB-2, JOB-3, JOB-4
**Unblocks:** JOB-6 (templates), JOB-8 (multi-tenancy + upgrade + docs)

## Overview

Two NestJS `DynamicModule` factories plus a shared pool config loader. `JobsDomainModule` is the service module (any app process imports it to access the three protocol tokens). `JobWorkerModule` additionally boots worker claim loops, scans the `@JobHandler` registry, upserts `Job` rows from decorator metadata, and runs the boot-time validator. The pool config loader parses `codegen.config.yaml: jobs.pools`, applies framework defaults, validates reserved-pool assignment.

## Architecture

```
AppModule
  ├── JobsDomainModule.forRoot({ backend: 'drizzle' })           [global: true]
  │     provides JOB_ORCHESTRATOR, JOB_RUN_SERVICE, JOB_STEP_SERVICE
  │
  └── JobWorkerModule.forRoot({ mode: 'embedded', pools?: [...] })
        imports JobsDomainModule internally
        on init: loadPoolConfig → scan registry → validate reserved → upsert Job rows
                 → runBootValidator (Drizzle only) → start N JobWorkers
        on destroy: gracefulStop each worker

HandlerRegistry   (module-local Map, populated by @JobHandler at class-eval time)
PoolConfigLoader  (reads codegen.config.yaml: jobs.pools; applies 5 framework defaults)
```

## Files

| File | Action | Purpose |
|---|---|---|
| `runtime/subsystems/jobs/jobs-domain.module.ts` | create | `JobsDomainModule.forRoot()` — token wiring, global |
| `runtime/subsystems/jobs/job-worker.module.ts` | create | `JobWorkerModule.forRoot()` — lifecycle, validator, registry scan |
| `runtime/subsystems/jobs/pool-config.loader.ts` | create | Read `codegen.config.yaml: jobs.pools`; merge defaults |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export modules + types |
| `runtime/subsystems/jobs/__tests__/jobs-domain.module.test.ts` | create | Nest harness; memory backend; token resolution |
| `runtime/subsystems/jobs/__tests__/job-worker.module.test.ts` | create | Validator failure, reserved-pool violation, handler upsert |

## Interfaces

```typescript
// pool-config.loader.ts
export interface PoolDefinition {
  queue: string;          // e.g. 'jobs-batch'
  concurrency: number;
  reserved: boolean;
  description?: string;
}
export type PoolConfig = Map<string, PoolDefinition>;
export function loadPoolConfig(configPath?: string): PoolConfig;

const FRAMEWORK_POOLS: Record<string, PoolDefinition> = {
  events_inbound:  { queue: 'jobs-events-inbound',  concurrency: 20, reserved: true  },
  events_change:   { queue: 'jobs-events-change',   concurrency: 30, reserved: true  },
  events_outbound: { queue: 'jobs-events-outbound', concurrency: 10, reserved: true  },
  interactive:     { queue: 'jobs-interactive',     concurrency: 20, reserved: false },
  batch:           { queue: 'jobs-batch',           concurrency: 5,  reserved: false },
};

// jobs-domain.module.ts
export interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory';
}
export class JobsDomainModule {
  static forRoot(opts: JobsDomainModuleOptions): DynamicModule;
}

// job-worker.module.ts
export interface JobWorkerModuleOptions {
  mode: 'embedded' | 'standalone';
  backend?: 'drizzle' | 'memory';  // threads into internal JobsDomainModule import
  pools?: string[];
  shutdownTimeoutMs?: number;      // default 30_000
}
export class JobWorkerModule implements OnModuleInit, OnModuleDestroy {
  static forRoot(opts: JobWorkerModuleOptions): DynamicModule;
}

// Boot validator error classes
export class BootValidationError extends Error { missingHandlers: string[]; }
export class ReservedPoolViolationError extends Error { offenders: Array<{ handlerClass: string; pool: string }>; }
```

## Implementation Steps

### 1. `pool-config.loader.ts`

- Define `FRAMEWORK_POOLS` with all five defaults.
- `loadPoolConfig(configPath?)`: read `${process.cwd()}/codegen.config.yaml` (or `configPath` if passed) via `fs.readFileSync` + `yaml.parse`.
- Apply defaults first; merge user-defined pools from `raw.jobs?.pools ?? {}`.
- User config can override `concurrency` and `description` on non-reserved defaults. User CANNOT override `reserved: true` on framework pools (loader silently preserves).
- User-defined pools cannot set `reserved: true` (reserved is framework-only).
- Return `Map<string, PoolDefinition>`. Cache in module scope after first call.

### 2. `jobs-domain.module.ts`

Mirrors `EventsModule.forRoot()` shape exactly:

```typescript
@Module({})
export class JobsDomainModule {
  static forRoot(opts: JobsDomainModuleOptions): DynamicModule {
    const backendClasses = opts.backend === 'memory'
      ? { orch: MemoryJobOrchestrator, run: MemoryJobRunService, step: MemoryJobStepService }
      : { orch: DrizzleJobOrchestrator, run: DrizzleJobRunService, step: DrizzleJobStepService };

    const providers: Provider[] = [
      { provide: JOB_ORCHESTRATOR, useClass: backendClasses.orch },
      { provide: JOB_RUN_SERVICE,  useClass: backendClasses.run },
      { provide: JOB_STEP_SERVICE, useClass: backendClasses.step },
    ];

    // In memory mode, also provide MemoryJobStore as a useValue singleton
    if (opts.backend === 'memory') {
      providers.push({ provide: MemoryJobStore, useValue: new MemoryJobStore() });
    }

    return {
      module: JobsDomainModule,
      global: true,
      providers,
      exports: [JOB_ORCHESTRATOR, JOB_RUN_SERVICE, JOB_STEP_SERVICE],
    };
  }
}
```

### 3. `job-worker.module.ts`

- `forRoot(opts)` returns `DynamicModule` that `imports: [JobsDomainModule.forRoot({ backend: opts.backend ?? 'drizzle' })]`.
- Declare a `JobWorkerOrchestrator` injectable (name avoids collision) that holds `OnModuleInit`/`OnModuleDestroy` hooks. Register as provider.
- **`onModuleInit` sequence (order critical):**
  1. `loadPoolConfig()` → `PoolConfig`
  2. `HandlerRegistry.getAll()` → registered entries
  3. **Reserved-pool validation:** walk entries; if any `meta.pool` matches a `reserved: true` pool, collect offenders; if non-empty, throw `ReservedPoolViolationError` listing class names
  4. Inject `JOB_ORCHESTRATOR`; call `orchestrator.upsertJobRows(entries, poolConfig)` (method defined on orchestrator protocol; Drizzle uses `ON CONFLICT DO UPDATE` per JOB-3 OQ-3; memory mode populates `store.jobs`)
  5. **Boot validator (Drizzle only):** if `backend !== 'memory'`, call `runBootValidator(orchestrator, entries)` — query all `Job` rows; for each row with no matching registry entry, accumulate; if any, throw `BootValidationError`
  6. Resolve active pool list: `opts.pools ?? allNonReservedPoolNames(poolConfig)`
  7. For each active pool: instantiate `JobWorker(pool, poolConfig.get(pool), orchestrator)`; call `worker.start()`; store in instance array
- **`onModuleDestroy`:** for each stored worker, `await worker.gracefulStop(opts.shutdownTimeoutMs ?? 30_000)`.
- Module `exports: []` — it's an actor module.

### 4. Handler registry access surface

`@JobHandler` decorator (defined in JOB-2) populates module-local `Map` at class-evaluation time. JOB-5 adds read helpers:

```typescript
export namespace HandlerRegistry {
  export function getAll(): HandlerRegistryEntry[];
  export function get(type: string): HandlerRegistryEntry | undefined;
}
```

### 5. `index.ts`

Re-export `JobsDomainModule`, `JobsDomainModuleOptions`, `JobWorkerModule`, `JobWorkerModuleOptions`, `loadPoolConfig`, `PoolConfig`, `PoolDefinition`, error classes. Don't remove existing executor-layer exports.

## Pool → Queue Binding

Each pool maps to a distinct queue name passed to `IJobQueue.enqueue('job_run_tick', { runId }, { queue: poolDef.queue })`. `concurrency` passed to `JobWorker` as max parallel in-flight ticks — worker tracks active promises and skips `claimNext` at capacity.

Defaults:

| Pool | queue | concurrency |
|---|---|---|
| events_inbound | jobs-events-inbound | 20 |
| events_change | jobs-events-change | 30 |
| events_outbound | jobs-events-outbound | 10 |
| interactive | jobs-interactive | 20 |
| batch | jobs-batch | 5 |

User-defined `agents: { queue: 'jobs-agents', concurrency: 3 }` in config becomes a sixth entry. `JobWorker` created when `agents` is in `opts.pools` (or `opts.pools` omitted).

## Testing Strategy

**Unit (`just test-unit`, no Docker):**
- `JobsDomainModule.forRoot({ backend: 'memory' })` boots in `Test.createTestingModule`; all three tokens resolve
- `JobWorkerModule` boots with well-formed handler registry (memory backend)
- `ReservedPoolViolationError` thrown for handler with `pool: 'events_change'`; error lists offender class
- `BootValidationError` thrown when mock orchestrator returns orphaned `Job` row (with `'orphaned_type'` not in registry)
- `loadPoolConfig()` with no file returns five framework defaults
- User pool merging: custom pool added; framework defaults preserved
- User cannot flip `reserved: false` on framework pool (loader ignores)

**Integration (Docker Postgres, `just test-family`):**
- `JobWorkerModule` with `backend: 'drizzle'`: handler upsert creates `Job` row; second boot idempotent (`updated_at` bumped)
- Validator passes after upsert; fails if row injected manually without matching handler

**Horizontal scale (flagged, not tested in Phase 1):** multiple instances racing on upsert — see OQ-3 resolution below.

## Acceptance Criteria

- `JobsDomainModule.forRoot({ backend })` wires three tokens; `global: true`; ADR-008 factory pattern
- `JobWorkerModule.forRoot({ mode, pools? })` starts one `JobWorker` per active pool on init; stops on destroy
- Boot validator: missing handler → `BootValidationError` with missing type names listed
- `@JobHandler` classes upsert into `job` table on init; missing handler (source removed) logs warning (prune → Phase 6)
- Reserved-pool enforcement: user `@JobHandler` targeting `reserved: true` → `ReservedPoolViolationError` at init with class names
- Validator skipped when `backend: 'memory'`
- `loadPoolConfig` applies all five framework defaults when config absent; merges user pools; cannot flip `reserved: true`

## Open Questions (resolved)

**OQ-3 (reiterated from JOB-3) — Job row upsert under horizontal scale.** Use `ON CONFLICT (type) DO UPDATE SET pool=EXCLUDED.pool, retry_policy=EXCLUDED.retry_policy, updated_at=now()`. Last-writer-wins. Safe because same binary = identical metadata. Rejecting `DO NOTHING` (stale rows under rolling deploy) and advisory locks (latency + leak risk).

**Validator in memory mode.** Skipped entirely. Memory-mode tests do not fail validator even with deliberately unregistered types (tests own in-memory state).

**Backend threading.** `JobWorkerModuleOptions.backend` explicit (default `'drizzle'`). `JobWorkerModule` imports `JobsDomainModule.forRoot({ backend: opts.backend ?? 'drizzle' })` internally.

**`loadPoolConfig` runtime vs. codegen-time.** Runs at server boot in consumer app; reads `codegen.config.yaml` from `process.cwd()`. Tests can override via `configPath` parameter.

## Scope Boundary

- **JOB-6** owns standalone `worker.ts` entrypoint
- **JOB-8** owns `tenant_id` filter threading (this module's `forRoot` signature stays stable)
- `@JobHandler` decorator definition: JOB-2 (consumed here)
- BullMQ-native claim: executor layer; `JobsModule` (not `JobsDomainModule`) unchanged

## References

- ADR-022 "Pools", "Worker lifecycle", "Registration — static codegen"
- ADR-008 — Protocol → Backend → Factory
- `runtime/subsystems/events/events.module.ts` — module factory pattern
- `runtime/subsystems/jobs/jobs.module.ts` — existing executor-layer factory
- JOB-1 schema, JOB-2 protocols, JOB-3 Drizzle backends, JOB-4 memory backends
