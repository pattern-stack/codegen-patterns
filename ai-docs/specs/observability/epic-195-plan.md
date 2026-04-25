# Epic #195 — Observability Subsystem Plan

Inputs:
- `.claude/specs/epic-195-understanding.md`
- `.claude/specs/observability-subsystem-shape-understanding.md`
- `.claude/specs/observability-app-service-layer-understanding.md`
- `.claude/specs/epic-195-architecture-decisions.md` (locked constraints)

## Issue Tree

```
epic-195-observability/
├── [issue] OBS-1: ADR + skill scaffold for combiner subsystem pattern      (docs, chore)
├── [issue] OBS-2: Extend IJobRunService with observability reads           (backend, feature, jobs)
├── [issue] OBS-3: Extend IBridgeDeliveryRepo with status histogram         (backend, feature, bridge)
├── [issue] OBS-4: Extend sync ports (ISyncRunRecorder.listRecent + ICursorStore.listAll)  (backend, feature, sync)
├── [issue] OBS-5: ObservabilityService composer + module + protocol        (backend, feature, observability)
│   └── blocks on: OBS-2, OBS-3, OBS-4
├── [issue] OBS-6: Relocate BridgeMetricsReporter into reporters/           (backend, refactor, observability)
│   └── blocks on: OBS-5
├── [issue] OBS-7: CLI scaffold — just gen-subsystem observability          (generator, feature)
│   └── blocks on: OBS-5
└── [issue] OBS-8: Smoke + baseline test update covering observability      (chore, testing)
    └── blocks on: OBS-5, OBS-7
```

## Dependency Graph

```
OBS-1 (docs; can ship first or parallel) ──────────────────────────────┐
                                                                        │
OBS-2 (jobs reads)   ─┐                                                 │
OBS-3 (bridge reads) ─┼─→ OBS-5 (composer) ─┬─→ OBS-6 (reporter move) ──┤
OBS-4 (sync reads)   ─┘                     ├─→ OBS-7 (CLI scaffold) ───┤
                                            │                            │
                                            └─→ OBS-8 (smoke+baseline) ──┘
                                                (needs OBS-5 and OBS-7)
```

## Execution Order

1. **Wave 1 (parallel):** OBS-1, OBS-2, OBS-3, OBS-4
2. **Wave 2:** OBS-5 (after 2/3/4 land)
3. **Wave 3 (parallel):** OBS-6, OBS-7
4. **Wave 4:** OBS-8 (after OBS-7)

OBS-1 can ship independently at any point — it's documentation only and doesn't block code. Prefer landing it in Wave 1 so the ADR is merged before reviewers see OBS-5.

## Issue Details

### OBS-1: ADR + skill scaffold for combiner subsystem pattern

- **Stack:** Docs
- **Type:** Chore
- **Size:** Small (~150 lines across 2–3 files)
- **Description:** Introduce "combiner subsystem" as a named pattern distinct from ADR-008 infrastructure subsystems. New ADR (or ADR-008 addendum) naming bridge as precedent, defining shape (no schema, no backend-swappability, composes sibling ports via DI, `global: true`). New `.claude/skills/observability/SKILL.md` patterned on jobs/bridge skills. Explicitly state that the entity-pipeline `use-case → service → repo` rule does NOT apply to framework subsystems (two-layer).
- **Acceptance Criteria:**
  - ADR file added under `docs/` introducing combiner subsystem pattern
  - `.claude/skills/observability/SKILL.md` created with L0 summary + routing
  - Skill documents: combiner vs infrastructure distinction, multi-tenancy delegation rule, Cube.js reservation for cross-table analytics, "add read to owning port vs new port" guidance
  - No code changes in this PR

### OBS-2: Extend IJobRunService with observability reads

- **Stack:** Backend
- **Type:** Feature
- **Size:** Small–Medium (~200 lines incl. tests)
- **Description:** Add `countByPoolAndStatus(tenantId?)` and `listRecentFailed(limit, tenantId?)` to `IJobRunService`. Implement in both `DrizzleJobRunService` and `MemoryJobRunService`. Tenant filtering delegated via existing `tenantCondition()`. Return types defined in same protocol file (`PoolStatusCount`, `JobRunFailure`).
- **Acceptance Criteria:**
  - Protocol extended in `job-run-service.protocol.ts`
  - Drizzle backend implements using `GROUP BY pool, status` and `WHERE status='failed' ORDER BY ... LIMIT`
  - Memory backend implements portable equivalents
  - Both methods accept `tenantId?: string | null`
  - Unit tests for memory backend; integration tests for Drizzle backend
  - No consumer yet — port additions only

### OBS-3: Extend IBridgeDeliveryRepo with status histogram

- **Stack:** Backend
- **Type:** Feature
- **Size:** Small (~150 lines incl. tests)
- **Description:** Add `getStatusHistogram(windowHours, tenantId?)` to `IBridgeDeliveryRepo`. Returns plain status counts for phase 1: `{ pending: N, delivered: N, skipped: N, failed: N }`. Implement in `DrizzleBridgeDeliveryRepo` and `MemoryBridgeDeliveryRepo`. No time bucketing.
- **Acceptance Criteria:**
  - Protocol extended with method signature + `StatusHistogram` return type
  - Both backends implement; Drizzle uses `GROUP BY status WHERE attemptedAt >= now() - windowHours`
  - Tenant filtering delegated to existing pattern
  - Tests for both backends
  - Comment in protocol reserving time-bucketed variant for Cube.js

### OBS-4: Extend sync ports — listRecent + listAll cursors

- **Stack:** Backend
- **Type:** Feature
- **Size:** Small–Medium (~200 lines incl. tests)
- **Description:** Add `listRecent(limit, integrationId?, tenantId?)` to `ISyncRunRecorder` (or equivalent read port) and `listAll(tenantId?)` to `ICursorStore`. Implement in Drizzle + Memory backends for both. Defines `SyncRunSummary` and `CursorSnapshot` return types.
- **Acceptance Criteria:**
  - Both protocol extensions land with typed return shapes
  - Drizzle backends implement against `sync_runs` and `sync_subscriptions` tables
  - Memory backends implement over in-memory recorder/cursor stores
  - All methods accept optional `tenantId` and delegate existing tenant filtering
  - Unit + integration tests

### OBS-5: ObservabilityService composer + module + protocol

- **Stack:** Backend
- **Type:** Feature
- **Size:** Medium (~400 lines incl. tests)
- **Description:** Core of the epic. Create `runtime/subsystems/observability/` with `observability.protocol.ts` (`IObservability` + types), `observability.service.ts` (single `ObservabilityService` class composing sibling ports via DI — NO service/repo split, NO Memory/Drizzle backend variants), `observability.module.ts` (`ObservabilityModule`, `global: true`, consumes sibling tokens), `observability.tokens.ts` (`OBSERVABILITY`), `observability-errors.ts`, `index.ts` barrel. Service methods: `getPoolDepths`, `getRecentSyncRuns`, `getBridgeDeliveryHistogram`, `getRecentFailedJobs`, `getCursors` — each delegates to the owning port added in OBS-2/3/4. Use `@Optional()` injection so observability degrades gracefully if a subsystem is absent.
- **Acceptance Criteria:**
  - Single `ObservabilityService` class (no backend variants, no repo layer)
  - All five core methods accept optional `tenantId` and pass through to owning port
  - Module is `global: true`, consumes sibling tokens via DI
  - `@Optional()` for each subsystem injection; missing subsystem returns empty result, not error
  - Barrel re-exports protocol + types + tokens + module (not the service class directly)
  - Unit tests use in-memory backends of jobs/bridge/sync composed under observability
  - No new schema file

### OBS-6: Relocate BridgeMetricsReporter into reporters/

- **Stack:** Backend
- **Type:** Refactor
- **Size:** Small–Medium (~250 lines incl. tests)
- **Description:** Move `BridgeMetricsReporter` out of app code into `runtime/subsystems/observability/reporters/bridge-metrics.reporter.ts`. Refactor to inject `OBSERVABILITY` token (not reach into bridge tables directly). Use Nest logger. Add `ReportersConfig` shape to `ObservabilityModuleOptions` for interval + enabled flag. Delete original app-side file.
- **Acceptance Criteria:**
  - Reporter lives in `runtime/subsystems/observability/reporters/`
  - Reporter consumes `IObservability.getBridgeDeliveryHistogram()` only — no direct bridge table access
  - `OnModuleInit` + `setInterval` lifecycle preserved
  - Reporter is opt-in via module options (`reporters: { bridgeMetrics: { enabled, intervalMs } }`)
  - Old app-side file deleted (no back-compat shim per CLAUDE.md)
  - Unit test covers interval firing + delegation

### OBS-7: CLI scaffold — just gen-subsystem observability

- **Stack:** Generator
- **Type:** Feature
- **Size:** Small (~150 lines)
- **Description:** Add `templates/subsystem/observability/` with `prompt.js` + `main-hook.ejs.t` (injects `ObservabilityModule` into `AppModule.imports`). Optional `observability-config/` template for reporter intervals in `codegen.config.yaml`. No schema template, no worker template. Wire into subsystem registry so `just gen-subsystem observability` resolves.
- **Acceptance Criteria:**
  - `just gen-subsystem observability` runs end-to-end in a scratch project
  - `AppModule` receives `ObservabilityModule.forRoot()` import via Hygen inject
  - No schema or worker template shipped
  - Prompt surfaces reporter enable flag(s)
  - Subsystem discoverable from CLI noun-verb (`subsystem new observability`)

### OBS-8: Smoke + baseline test update covering observability

- **Stack:** Testing
- **Type:** Chore
- **Size:** Small (~150 lines)
- **Description:** Update `just test-smoke` fixture to include `just gen-subsystem observability` and verify the fresh project typechecks with observability wired. Update baseline snapshots under `test/baseline/` for any delta from extended ports (OBS-2/3/4). Ensure `just test-all` remains green in CI.
- **Acceptance Criteria:**
  - Smoke test runs `gen-subsystem observability` and typechecks
  - Baseline snapshots regenerated and committed
  - `just test-all` passes locally and on CI
  - No Drizzle extensions exercised (phase 1 only)

## Notes for orchestrator

- OBS-1 can ship at any time; prefer Wave 1 so the pattern is documented before the composer PR lands.
- OBS-2/3/4 are genuinely independent and assignable to three parallel agents. They do not share files.
- OBS-5 is the only "medium" issue; if it grows past ~500 lines during implementation, split the reporter-config shape into its own PR but keep the composer atomic.
- Phase-2 issues explicitly NOT in this plan: Drizzle extensions (pg_stat_*, LISTEN/NOTIFY), Prometheus/OTel exporters, StackStatusService wiring, Cube.js cross-table analytics.
- Cap respected: 8 issues exactly.
