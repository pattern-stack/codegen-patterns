# Understanding — Epic #195 (Observability Subsystem)

Proposes adding `observability` as the 5th infrastructure subsystem in the ADR-008 family. Read-only cross-subsystem reporting layer validated by two concrete consumers (BridgeMetricsReporter wart + incoming StackStatusService).

## 1. Family fit

**Yes, but with one load-bearing departure.** Observability fits the ADR-008 Protocol → Backend → Factory family cleanly at the wiring level:

- Same shape: `observability.protocol.ts` + `observability.drizzle-backend.ts` + `observability.memory-backend.ts` + `observability.module.ts` with `forRoot({ backend })` and `global: true`.
- Same token convention: `OBSERVABILITY = Symbol('OBSERVABILITY')` in `observability.tokens.ts` (see `runtime/subsystems/jobs/jobs-domain.tokens.ts`, `cache/cache.tokens.ts`).
- Same Drizzle-backend-needs-DRIZZLE pattern (see `cache.module.ts` lines 47–62, 79–82 for the canonical `forRootAsync` shape that threads `DRIZZLE` through DI rather than hand-constructing).

**The departure:** every other ADR-008 subsystem *owns its schema* — events owns `domain_events`, jobs owns `job`/`job_run`/`job_step`, cache owns `cache_entries`, bridge owns `bridge_delivery`, sync owns `sync_runs`/`sync_run_items`/`sync_subscriptions`. Observability is explicitly read-only across other subsystems' tables. That means:

- It has **no `observability.schema.ts`** — unlike every other Drizzle-backed subsystem.
- Its Drizzle backend is a *consumer* of schemas imported from `../jobs/job-orchestration.schema`, `../events/domain-events.schema`, `../bridge/bridge-delivery.schema`, `../sync/sync-audit.schema`.
- There is no equivalent in the existing family. The closest analogue is `IJobRunService` (jobs/job-run-service.protocol.ts) which is the read-side port over `job_run` — but it's still inside the domain that owns the table.

Observability is, architecturally, a **cross-subsystem read port** dressed as a subsystem. That's defensible — it mirrors a dashboard/BFF pattern and the epic's two-consumer validation (BridgeMetricsReporter + StackStatusService) is exactly the right gate — but the fact that it reaches into tables it does not own is the key departure from ADR-008 and should be called out in the ADR addendum for this subsystem. See §3 below for the implication.

A second, lighter departure: the epic adds a `reporters/` sub-directory that no other subsystem has. The nearest precedent is `bridge/bridge-outbox-drain-hook.ts` (a singleton lifecycle thing living at the subsystem root). Reporters are `OnModuleInit` + `setInterval` classes — they belong here, but be intentional: they are *consumers* of `IObservabilityService`, not extensions of it. Don't let reporters accrete protocol surface.

## 2. Core/extension boundary

The epic lists five methods as core:

- `getPoolDepths()`
- `getRecentSyncRuns(limit, integrationId?)`
- `getBridgeDeliveryHistogram(windowHours)`
- `getRecentFailedJobs(limit)`
- `getCursors()`

**All five are implementable by a Memory backend** — they're aggregations over the same in-memory stores that memory backends of jobs/events/bridge/sync already maintain (`MemoryJobStore`, the memory bridge delivery store, the memory sync recorder, the memory cursor store). Confirmed by `runtime/subsystems/jobs/memory-job-store.ts` and the parallel memory-backend files. So the core contract as drafted is portable — good.

**The ambiguous cases, per capability:**

| Capability | Core or extension? | Why |
|---|---|---|
| `getPoolDepths()` — count of `pending`/`running` by `pool` on `job_run` | **Core.** Memory can answer trivially (group over `MemoryJobStore.runs`). Drizzle is a `SELECT pool, status, count(*) GROUP BY`. |
| `getRecentSyncRuns()` | **Core.** Both backends have `sync_runs` rows (Drizzle table; memory recorder keeps an in-memory list). |
| `getBridgeDeliveryHistogram(windowHours)` | **Core.** Status enum is small and fixed (`pending`/`delivered`/`skipped`/`failed`) and both backends store the rows with `attemptedAt`. |
| `getRecentFailedJobs()` | **Core.** `job_run` rows with `status='failed'` exist in both backends. |
| `getCursors()` | **Core, but watch multi-tenancy.** `ICursorStore` already has `get/put` gated on `tenantId`. `getCursors()` needs an explicit decision: scoped to a tenant, or cross-tenant like the JobWorker claim loop? The protocol signature has to make this explicit; don't paper over it. |
| `pg_stat_activity` sampling (connection counts, long-running queries) | **Drizzle extension only.** Memory backend cannot answer. Put this under `observability.extensions.drizzle` mirroring `DrizzleBackendExtensions` in `jobs-domain.module.ts:39–44`. |
| `pg_stat_statements` / query timing | **Drizzle extension only.** Same reason. Also requires the extension to be installed in Postgres — don't ship it as core. |
| LISTEN/NOTIFY for live-streaming events | **Drizzle extension only** — parallel to the reserved `listenNotify` slot on jobs. Memory can't. |
| Prometheus/OTel reporters | **Neither core nor extension of `IObservabilityService`.** They are *consumers* that live in `reporters/` and subscribe to the core port. Keep them on the outside of the protocol surface — otherwise you're back to the uniform-abstraction trap CLAUDE.md warns against. |

**Methods that look core but aren't portable:**

- Any "bytes on disk" / table-size / index-bloat query. Memory has no concept. Extension only.
- `killQuery(pid)` — pg-specific. Extension only (and probably shouldn't ship in Phase 1).
- `getReplicationLag()` — same.

**Rule of thumb from CLAUDE.md's core/extension doctrine:** if a method would force `MemoryObservabilityService` to return `null` or throw `NotSupportedError`, it does not belong in the core contract. Put it in `extensions.drizzle` with a typed reservation in the module options (pattern: `jobs-domain.module.ts:39–70`).

## 3. Read-only nature — which tables, and whose are they?

The Drizzle backend will read:

| Table | Owning subsystem | Schema file |
|---|---|---|
| `job`, `job_run`, `job_step` | jobs | `runtime/subsystems/jobs/job-orchestration.schema.ts` |
| `domain_events` | events | `runtime/subsystems/events/domain-events.schema.ts` |
| `bridge_delivery` | bridge | `runtime/subsystems/bridge/bridge-delivery.schema.ts` (columns: `id`, `eventId`, `triggerId`, `wrapperRunId`, `userRunId`, `status`, `skipReason`, `error`, `tenantId`, `attemptedAt`, `deliveredAt`; status enum: `pending`/`delivered`/`skipped`/`failed`) |
| `sync_runs`, `sync_run_items` | sync | `runtime/subsystems/sync/sync-audit.schema.ts` |
| `sync_subscriptions` | sync (cursor store) | same as above |
| `pg_stat_activity`, `pg_stat_statements` | Postgres | N/A (system catalog) |

**The load-bearing architectural question the epic glosses over:** *should observability import these schemas directly, or should each owning subsystem expose a read port that observability composes?*

The precedent cuts both ways:

- **Against direct access** — ADR-004 (cross-domain access rules) makes cross-domain reaching-in a violation for entity domains. There's already `IJobRunService.listForScope` for the jobs read side. If observability writes its own `SELECT status, count(*) FROM job_run GROUP BY pool, status`, it duplicates semantic knowledge of `job_run` (which statuses are "terminal", which rows count toward "depth", etc.) that the jobs domain already encodes. When JOB-8 added multi-tenancy, every jobs read had to grow tenant gating — observability would silently skip that if it reaches in directly.
- **For direct access** — the tables are schema artifacts. Observability is a read-only reporting layer. Forcing a `getPoolDepths` method onto `IJobOrchestrator` pollutes that port with reporting concerns that belong elsewhere. ADR-008 subsystems are more permissive about cross-import than entity domains (e.g., bridge imports from events and jobs already — see `bridge/event-flow.service.ts`).

**My read:** the honest answer is a mix, and the epic should make the split explicit:

- Queries that need *semantic* knowledge (what counts as "non-terminal", "eligible for retry", etc.) should go through the owning subsystem's read port. For jobs that means extending `IJobRunService` with `countByPoolAndStatus()` and `listRecentFailed(limit)`, not duplicating the WHERE clauses in observability.
- Queries that are purely tabular aggregations over stable columns (histogram over `bridge_delivery.status` + `attemptedAt`) are safe to do directly — the semantics are in the column types, not the domain logic.
- Multi-tenant gating, if it applies to any read, **must** go through the owning subsystem. This is the single biggest footgun. Re-implementing tenant filters in observability will rot.

Flag this in the ADR and in the first sub-issue spec. If the epic doesn't address this, the implementer will default to direct imports (path of least resistance) and we'll discover the wart when JOB-9 or the next tenancy change lands.

## 4. Pattern conformance — concrete layout

Using `jobs` as the reference (most-complex backend, multiple protocols, reserved extensions):

```
runtime/subsystems/observability/
  observability.protocol.ts          # IObservabilityService, public types (PoolDepth, SyncRunSummary, StatusHistogram, JobRunFailure, CursorSnapshot)
  observability.drizzle-backend.ts   # DrizzleObservabilityService
  observability.memory-backend.ts    # MemoryObservabilityService (reads MemoryJobStore, memory bridge/sync stores via DI)
  observability.module.ts            # ObservabilityModule.forRoot({ backend, extensions? })
  observability.tokens.ts            # OBSERVABILITY symbol
  observability-errors.ts            # ObservabilityError base (mirrors jobs-errors.ts, events-errors.ts, bridge-errors.ts)
  reporters/
    bridge-metrics.reporter.ts       # OnModuleInit + setInterval; injects OBSERVABILITY
    index.ts                         # barrel (ADR-017)
  index.ts                           # barrel — re-exports protocol types, tokens, module; NOT the Drizzle backend class
```

Test layout (mirrors `src/__tests__/` → `runtime/subsystems/jobs/__tests__/` convention seen across the repo):

```
runtime/subsystems/observability/__tests__/
  observability.memory-backend.test.ts
  observability.drizzle-backend.integration.test.ts  # runs against Postgres via just db-up
  bridge-metrics.reporter.test.ts
```

Module file shape — follow `jobs-domain.module.ts` almost verbatim:

- `interface ObservabilityModuleOptions { backend: 'drizzle' | 'memory'; extensions?: { drizzle?: DrizzleObservabilityExtensions } }`
- `interface DrizzleObservabilityExtensions { pgStatActivity?: boolean; pgStatStatements?: boolean }` — typed reservations, even if unimplemented in phase 1 (see `jobs-domain.module.ts:39–44, 46–55` for the "typed-but-unimplemented" pattern and the explicit `void opts.extensions;` line).
- `global: true`.
- Memory branch: construct singletons with `useValue`, then alias via `useExisting` (see `jobs-domain.module.ts:87–101`).
- Drizzle branch: `{ provide: OBSERVABILITY, useClass: DrizzleObservabilityService }` (lines 97–100).
- For the async form, copy `cache.module.ts:66–89` exactly — threading `DRIZZLE` via `inject: [..., { token: DRIZZLE, optional: true }]` and throwing the "selected 'drizzle' but DRIZZLE not provided" error.

CLI scaffold — mirror `templates/subsystem/jobs/` which ships 4 files (`prompt.js`, `main-hook.ejs.t`, `worker.ejs.t`, `job-orchestration.schema.ejs.t`). For observability:

```
templates/subsystem/observability/
  prompt.js
  main-hook.ejs.t                    # AppModule.imports += ObservabilityModule.forRoot({ backend: 'drizzle' })
```

No schema template (observability owns no schema), no worker template. A config template is optional — there's a `jobs-config/` sibling for `codegen.config.yaml: jobs.*` blocks; observability probably needs an `observability-config/` block for reporter intervals.

Skills:

```
.claude/skills/observability/
  SKILL.md                           # routing + L0 summary, following .claude/skills/jobs/SKILL.md
  reporters.md                       # L1 — authoring a reporter
  drizzle-extensions.md              # L1 — pg_stat_* and LISTEN/NOTIFY opt-ins
```

## 5. Open questions / risks

1. **Multi-tenancy gating on reads.** `IJobRunService` and `ICursorStore` take `tenantId`. `getPoolDepths()` probably wants aggregates across tenants (operator dashboard) — but `StackStatusService` might be per-tenant. The protocol signatures need explicit `tenantId?: string | null | undefined` semantics following the jobs convention (`job-orchestrator.protocol.ts:58–66`). Don't leave it implicit.

2. **Memory backend's data sources.** `MemoryObservabilityService` needs references to `MemoryJobStore`, the memory bridge/sync stores, and the memory cursor store. These are `useValue` singletons in their respective modules. The wiring question: does `ObservabilityModule` need to import those modules, or does it rely on `global: true` DI? Precedent from `jobs-domain.module.ts:91–92` is `useValue` + direct constructor injection. Observability will want to `@Optional() @Inject(MemoryJobStore)` each store so it degrades gracefully if a subsystem is absent.

3. **`BridgeMetricsReporter` migration path.** The epic says it currently lives in app code. Moving it to `runtime/subsystems/observability/reporters/` means: (a) it must become DI-constructor-only — no app-specific configuration baked in; (b) the logger interface it uses needs to be a Nest logger, not an app-local logger; (c) anything it currently reads directly from the bridge table must go through `IObservabilityService`. The epic doesn't call out the config surface for reporters (interval ms, enabled/disabled). Reporters need a `ReportersConfig` shape in `ObservabilityModuleOptions`, probably.

4. **`pg_stat_activity` in non-Postgres-owning deployments.** The current stack is Postgres-only via Drizzle, but the core/extension doctrine says backends can be swapped. If someone later builds a Turso/LibSQL Drizzle backend, `pg_stat_activity` panics. Typed extensions (`extensions.drizzle`) handle this — but the *reporter* needs to check presence before calling. Reporters calling extension methods need a "probe" pattern.

5. **Histogram bucketing contract.** `getBridgeDeliveryHistogram(windowHours)` returns `StatusHistogram`. Is that `{ delivered: N, failed: N, skipped: N, pending: N }` (simple status counts) or bucketed time series? The epic doesn't say. Make this explicit in the protocol; histograms typically mean buckets, and reporters will want both shapes.

6. **Where does `getBridgeDeliveryHistogram` live when the app has no bridge?** Bridge is a subsystem — not every consumer installs it. The core contract needs to tolerate subsystem absence gracefully. Either: (a) observability splits into per-subsystem sub-ports (`IJobsObservability`, `IBridgeObservability`, etc.), each tied to its subsystem being present; or (b) the core port returns empty results when a subsystem is absent, with the `@Optional()` DI pattern. (b) is simpler and matches what memory backend degradation already wants (§5.2).

7. **ADR for this subsystem.** ADR-008 established the pattern for the original four subsystems. Adding observability as subsystem #5 with a read-only cross-subsystem posture warrants either a new ADR or an explicit ADR-008 addendum. Per CLAUDE.md ("specs and skills are living documentation"), this should ship in the same PR as the first observability code.

8. **Bypassing owning-subsystem ports** — restating §3: the biggest long-term risk. Worth encoding as a rule in the observability SKILL.md: "this subsystem reads from other subsystems' tables; when semantic knowledge is needed, add a read method to the owning subsystem's port — do not duplicate domain logic here."

## 6. Validation of the "8-issue breakdown"

The epic body as returned from GitHub does not actually contain 8 labeled sub-issues — only the epic itself exists in the tracker (no OBS-1..OBS-8 issues found via search). So there's nothing concrete to validate against. Based on the scope described, the natural slicing by analogy with JOB-1..JOB-8 would be:

| Slice | Rationale | Precedent |
|---|---|---|
| OBS-1 — Protocol + types (`IObservabilityService`, `PoolDepth`, `SyncRunSummary`, `StatusHistogram`, `JobRunFailure`, `CursorSnapshot`) + tokens + errors | Foundation; nothing else can land first | JOB-2 |
| OBS-2 — Memory backend | Needed for testing every downstream slice; avoids Docker dependency for unit tests | JOB-4 |
| OBS-3 — Drizzle backend (core methods only, no extensions) | Production path | JOB-3 |
| OBS-4 — Module wiring (`ObservabilityModule.forRoot`, async form) | DI surface | JOB-5 |
| OBS-5 — `BridgeMetricsReporter` migration out of app code into `reporters/` | First consumer proof | no precedent — this is the reporter-pattern pilot |
| OBS-6 — CLI scaffold (`just gen-subsystem observability`, `templates/subsystem/observability/`) + config block template | Generator UX | JOB-6 |
| OBS-7 — Drizzle extensions (`pg_stat_activity`, `pg_stat_statements`, optionally `LISTEN/NOTIFY`) behind `extensions.drizzle` | Opt-in backend features | JOB-8 (by structural analogy with opt-in flags) |
| OBS-8 — Skill + ADR addendum + docs | Living documentation closing the loop | parallels ADR-022 Phase 1 close-out |

**What's missing from a naive 8-slice read:**

- **A spec for the read-port-vs-direct-import decision (§3).** This either rides on OBS-1 or is its own pre-slice. It is the riskiest call in the epic and must be resolved before OBS-3 starts — otherwise the Drizzle backend shape is unstable.
- **Owning-subsystem read-port extensions.** If the §3 decision goes "read through owning ports," then `IJobRunService` needs `countByPoolAndStatus()` and `listRecentFailed()`, and `IBridgeDelivery` needs a histogram method. That's 2–3 small PRs *across* jobs/bridge/sync, not inside observability. Easy to miss in an observability-only slicing.
- **Reporter config surface.** Interval, enabled flag, log level. Should have a dedicated slice or be folded explicitly into OBS-5.
- **StackStatusService wiring.** The epic names it as the second consumer but the slices above only pilot BridgeMetricsReporter. StackStatusService is likely app-side, not framework-side — but a sample implementation (or at least the HTTP surface expectations) should live in a doc/skill file so the `/dev/status` pattern is reusable.

**Possibly redundant:**

- OBS-7 (extensions) could be deferred to a Phase 2 — phase 1 shipping with just `extensions.drizzle = {}` as a typed reservation (the pattern from `jobs-domain.module.ts:46–55`) is enough. The epic itself is explicit that Prometheus/OTel are "extensible for" future, i.e., not phase 1.

Net: the 8-slice guess is reasonable but under-specifies the cross-subsystem read-port decision (§3) and the cross-subsystem PRs that decision implies. The epic body also doesn't commit to the concrete slice list — when it's written down, that's the moment to bake §3 in.
