# JOB-5 — `JobsDomainModule.forRoot()` + `JobWorkerModule.forRoot()` with Pool Config Loader

**Issue:** JOB-5
**Status:** Implemented
**Last Updated:** 2026-04-19
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
| `runtime/subsystems/jobs/job-handler.base.ts` | modify | Add `HandlerRegistry` namespace + `HandlerRegistryEntry` (read facade over the existing `JOB_HANDLER_REGISTRY` map) |
| `runtime/subsystems/jobs/jobs-errors.ts` | modify | Add `BootValidationError` + `ReservedPoolViolationError` |
| `runtime/subsystems/jobs/job-orchestrator.protocol.ts` | modify | Add `upsertJobRows(entries, poolConfig)` to `IJobOrchestrator` (see "Implementation note: orchestrator protocol extension" below) |
| `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` | modify | Implement `upsertJobRows` with hash-gated `ON CONFLICT DO UPDATE … WHERE` |
| `runtime/subsystems/jobs/job-orchestrator.memory-backend.ts` | modify | Implement `upsertJobRows` (delegates to existing `registerHandler`) |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export modules + types |
| `src/__tests__/runtime/subsystems/jobs-domain.module.spec.ts` | create | Nest harness; memory backend; token resolution. **Note:** placed under `src/__tests__/runtime/subsystems/` (not `runtime/**/__tests__/`) to match the JOB-4 path correction — `tsconfig.build.json` excludes `runtime/**/__tests__/**` and `just test-unit` only globs `src/__tests__/`. |
| `src/__tests__/runtime/subsystems/job-worker.module.spec.ts` | create | Validator failure, reserved-pool violation, handler upsert, memory-mode validator skip, pool config loader behaviour |

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
export interface DrizzleBackendExtensions {
  /** Use Postgres LISTEN/NOTIFY to wake the polling loop. Default false. */
  listenNotify?: boolean;
  /** Polling interval when LISTEN/NOTIFY is off (ms). Default 1000. */
  pollIntervalMs?: number;
}

// Future shape — Phase 6+, included here so the type system reserves the slot.
// export interface BullMqBackendExtensions {
//   bullBoard?: { enabled: boolean; mountPath?: string };
//   redisUrl?: string;
// }

export interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory';
  /**
   * Backend-specific extensions. Only the matching backend's extensions are
   * read at boot; non-matching keys are ignored (with a config-validator warning).
   * This is the core/extension protocol surface — see CLAUDE.md.
   */
  extensions?: {
    drizzle?: DrizzleBackendExtensions;
    // bullmq?: BullMqBackendExtensions;   // Phase 6+
  };
  multiTenant?: boolean;                    // JOB-8
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
  4. Inject `JOB_ORCHESTRATOR`; call `orchestrator.upsertJobRows(entries, poolConfig)` (method defined on orchestrator protocol; Drizzle uses `ON CONFLICT (type) DO UPDATE` **gated by a metadata content hash** per Q3 resolution 2026-04-19 — `UPDATE` branch runs only when stored hash ≠ computed hash; `version` bumps only on real change; memory mode populates `store.jobs`)
  5. **Boot validator (Drizzle only):** if `backend !== 'memory'`, call `runBootValidator(orchestrator, entries)` — query all `Job` rows; for each row with no matching registry entry, accumulate; if any, throw `BootValidationError`. Skipped entirely in memory mode per Q4 resolution 2026-04-19.
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

Re-export `JobsDomainModule`, `JobsDomainModuleOptions`, `JobWorkerModule`, `JobWorkerModuleOptions`, `loadPoolConfig`, `PoolConfig`, `PoolDefinition`, error classes. (No legacy executor-layer exports remain — JOB-1 deletes the entire `IJobQueue` surface.)

## Pool → Queue Binding

Each pool gets one `JobWorker` instance. The worker polls `job_run` for rows where `pool = poolDef.queue` (the `queue` field is reused as the pool's identifier on the `job_run` row — naming preserved for parity with future BullMQ backend mapping). `concurrency` passed to `JobWorker` as max parallel in-flight runs — worker tracks active promises and skips `claimNext` at capacity. No tick messages, no `IJobQueue`.

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

- [x] `JobsDomainModule.forRoot({ backend })` wires three tokens; `global: true`; ADR-008 factory pattern
- [x] `JobWorkerModule.forRoot({ mode, pools? })` starts one `JobWorker` per active pool on init; stops on destroy (production: real `JobWorker` constructed positionally with `DRIZZLE`, `JOB_ORCHESTRATOR`, `JOB_RUN_SERVICE`, `JOB_STEP_SERVICE`, `JobWorkerOptions`; tests: `workerFactory` escape hatch returns a stub)
- [x] Boot validator (Drizzle only): missing handler → `BootValidationError` with missing type names listed; skipped entirely when `backend: 'memory'` (Q4 resolved 2026-04-19 — no DB rows in memory mode)
- [x] `@JobHandler` classes upsert into `job` table on init using `ON CONFLICT (type) DO UPDATE` **gated by a metadata content hash** (Q3 resolved 2026-04-19); the `UPDATE` branch executes only when the stored hash differs from the computed hash; `version` column bumps only on a real metadata change; concurrent boots with identical content are idempotent no-ops; handler removed from source surfaces as `BootValidationError.missingHandlers` (operator decides whether to prune; explicit prune command → Phase 6)
- [x] Reserved-pool enforcement: user `@JobHandler` targeting `reserved: true` → `ReservedPoolViolationError` at init with class names
- [x] `loadPoolConfig` applies all five framework defaults when config absent; merges user pools; cannot flip `reserved: true`

## Implementation Notes (post-implementation, 2026-04-19)

### Orchestrator protocol extension — `upsertJobRows`

JOB-5 added a third method to `IJobOrchestrator`:

```ts
upsertJobRows(
  entries: JobUpsertEntry[],
  poolConfig: ReadonlyMap<string, JobPoolDef>,
): Promise<{ orphaned: string[] }>;
```

Both backends implement it:

- **Drizzle**: hash-gated `INSERT … ON CONFLICT (type) DO UPDATE … WHERE` (see below). Returns the orphan list via a single `SELECT type FROM job WHERE type NOT IN (…)`.
- **Memory**: delegates each entry to the existing `MemoryJobOrchestrator.registerHandler` and always returns `{ orphaned: [] }` — there are no DB rows to validate (Q4).

Why `upsertJobRows` lives on the orchestrator (vs. a separate "registry service"):
the work is scoped to job-table mutation, the orchestrator already owns the
job-row read/write surface, and this avoids a second injection token for what
boils down to one call per process. Keeps the protocol compact.

### Hash gating — SQL `IS DISTINCT FROM` per field (no extra column)

Implemented as a single `INSERT … ON CONFLICT (type) DO UPDATE … SET … WHERE
<field> IS DISTINCT FROM EXCLUDED.<field> OR …` covering every Q3 field
(`pool`, `retry_policy::text`, `timeout_ms`, `concurrency_key_template`,
`collision_mode`, `dedupe_key_template`, `dedupe_window_ms`,
`priority_default`, `replay_from`, `scope_entity_type`). The `WHERE` clause
on `DO UPDATE` is the gate — when every field matches, the `UPDATE` is
skipped entirely; `version` and `updated_at` are never touched.

Chose this over a stored hash column to avoid a JOB-1 schema migration. The
SQL is a single statement, atomic against concurrent boots: PG's `INSERT …
ON CONFLICT` with `WHERE` semantics rules out the read-modify-write race.

### Reserved-pool ordering

Validation runs **before** the upsert (step 3 of the spec sequence). If the
user points a handler at `events_*`, the boot fails before any DB mutation —
no half-written `job` row to clean up.

### `MemoryJobOrchestrator.start()` — equivalent of validator in memory mode

Per Q4, the boot validator is skipped in memory mode. The equivalent
protection is `MemoryJobOrchestrator.start()` throwing **`JobTypeNotFoundError`**
synchronously when called with an unregistered `type`. (The original spec
mentioned `UnknownJobTypeError`; the actual exported class is
`JobTypeNotFoundError` from JOB-3.)

### `JobWorker` instantiation

The worker module spawns N `JobWorker` instances from a single options shape,
which doesn't fit Nest's "one provider per token" model. We instantiate
`JobWorker` outside the container and pass dependencies positionally
(`new JobWorker(db, orchestrator, runService, stepService, options)`). The
constructor's `@Inject` decorators remain in place for the standalone
worker.ts entrypoint that JOB-6 ships — same class, two callsites.

The `DRIZZLE` provider is injected as `@Optional()` on `JobWorkerOrchestrator`
so memory-mode test modules compile without supplying a Drizzle client.
Memory-mode tests pass `workerFactory` to inject a stub worker; production
deployments use the real `JobWorker`.

### Caching the pool config loader

`loadPoolConfig(configPath?)` caches by absolute resolved path. Cache reset
helper `_resetPoolConfigCacheForTests()` is exported but not re-exported
from `index.ts` — test-only API.

## Open Questions (resolved)

**Q3 — `job` table upsert under horizontal scale. Resolved 2026-04-19.** `ON CONFLICT (type) DO UPDATE` gated by a metadata content hash. Compute `hash(metadata)` per handler at boot (include `pool`, `retry_policy`, `timeout_ms`, `concurrency_key_template`, `collision_mode`, `dedupe_key_template`, `dedupe_window_ms`, `priority_default`, `replay_from`, `scope_entity_type`). The `UPDATE` branch runs only when the hash differs from what is stored. `version` column bumps only on a real metadata change — concurrent boots with identical metadata are idempotent no-ops. `DO NOTHING` rejected: under a rolling deploy, old-version instance A would leave a stale row that new-version instance B cannot overwrite. Advisory locks rejected: latency + leak risk.

**Q4 — Validator in memory mode. Resolved 2026-04-19.** Skip the validator entirely when `backend: 'memory'`. There are no DB rows in memory mode; the check is meaningless. The validator is exercised by integration tests against real Postgres.

**Backend threading.** `JobWorkerModuleOptions.backend` explicit (default `'drizzle'`). `JobWorkerModule` imports `JobsDomainModule.forRoot({ backend: opts.backend ?? 'drizzle' })` internally.

**`loadPoolConfig` runtime vs. codegen-time.** Runs at server boot in consumer app; reads `codegen.config.yaml` from `process.cwd()`. Tests can override via `configPath` parameter.

## Scope Boundary

- **JOB-6** owns standalone `worker.ts` entrypoint
- **JOB-8** owns `tenant_id` filter threading (this module's `forRoot` signature stays stable)
- `@JobHandler` decorator definition: JOB-2 (consumed here)
- BullMQ orchestrator backend: Phase 6+ work, separate `IJobOrchestrator` implementation; not in JOB-5

## References

- ADR-022 "Pools", "Worker lifecycle", "Registration — static codegen"
- ADR-008 — Protocol → Backend → Factory
- `runtime/subsystems/events/events.module.ts` — module factory pattern
- `runtime/subsystems/events/events.module.ts` — closest surviving factory pattern (the legacy `runtime/subsystems/jobs/jobs.module.ts` is deleted in JOB-1)
- JOB-1 schema, JOB-2 protocols, JOB-3 Drizzle backends, JOB-4 memory backends
