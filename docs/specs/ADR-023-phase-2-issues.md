# ADR-023 Phase 2 — Event-to-Job Bridge: Issue Breakdown

**Source of truth:** [ADR-023](../adrs/ADR-023-event-to-job-bridge.md) (revised 2026-04-21)
**Orchestration plan:** [BRIDGE-PHASE-2-PLAN.md](./BRIDGE-PHASE-2-PLAN.md)
**Phase scope:** The bridge subsystem — `bridge_delivery` schema, `IJobBridge` + `IEventFlow` protocols, Drizzle + memory backends, framework `BridgeDeliveryHandler`, outbox drain integration, `bridgeRegistry` codegen with build-time validation against `eventRegistry`, `EventFlowService` facade with `publish` / `publishAndStart` verbs (including Case B dedup pre-write), `BridgeModule.forRoot({ backend, multiTenant })` wiring on the three reserved `events_*` pools, multi-tenancy enforcement at the three `assertTenantId` sites (JOB-8 / SYNC-6 precedent), fanout CLI `codegen events consumers <type>` indexing all three tiers, Hygen scaffold templates, CONSUMER-SETUP section, and `.claude/skills/bridge/`. Does not include Phase 2.5 items (YAML trigger authoring, `debounce:`, dashboard hiding) or ADR-026 (selective JobEvent broadcast).

**Prerequisite:** ADR-024 Phase 1 (EVT-1..EVT-8 shipped) and ADR-022 Phase 1 (JOB-1..JOB-8 shipped) are both on `main`. All seven ADR-023 decisions are locked; revision pass complete 2026-04-21. No design work remains.

---

## Issue List

### BRIDGE-1 — `bridge_delivery` Drizzle schema + enum

**Scope.** `bridge_delivery` table, `bridge_delivery_status` enum (`pending | delivered | skipped | failed`), three indexes (event lookup, status partial, user-run partial), and `UNIQUE (event_id, trigger_id)` idempotency constraint. Schema foundation for every subsequent BRIDGE issue. `tenant_id` is emitted unconditionally (nullable) — mirrors JOB-1 post-2026-04-20 reversal.

**Files touched.**
- `runtime/subsystems/bridge/bridge-delivery.schema.ts` (new)
- `runtime/subsystems/bridge/index.ts` (new — barrel re-export)

**Depends on.** Nothing. Schema foundation.

**Blocks.** BRIDGE-2, BRIDGE-3, BRIDGE-4.

**Gate marker.** CHECKPOINT after merge — schema direction sanity check.

**Acceptance criteria.**
- [ ] `bridge_delivery` table declared with all columns per ADR-023 §Schema.
- [ ] `bridge_delivery_status` enum present.
- [ ] `UNIQUE (event_id, trigger_id)` constraint declared.
- [ ] Three indexes declared: `bridge_delivery_event_idx`, `bridge_delivery_status_idx` (partial), `bridge_delivery_user_run_idx` (partial).
- [ ] `tenant_id` column emitted unconditionally, nullable; service-layer enforcement lands in BRIDGE-8.
- [ ] `BridgeDeliveryRecord` inferred type exported from `index.ts`.
- [ ] Unit test asserts schema imports, column names present, enum values correct.

---

### BRIDGE-2 — Protocols `IJobBridge` + `IEventFlow` and DI tokens

**Scope.** The stable public API surface. `IJobBridge` (repo-shaped: `insertDelivery`, `findDelivery`, `markDelivered`, `markSkipped`, `markFailed`). `IEventFlow` with two verbs from ADR-023 §Decision 7. DI tokens: `BRIDGE_DELIVERY_REPO`, `EVENT_FLOW`, `BRIDGE_MULTI_TENANT`, `BRIDGE_MODULE_OPTIONS`. Errors module with `MissingTenantIdError` mirroring events-errors / jobs-errors shape.

**Files touched.**
- `runtime/subsystems/bridge/bridge.protocol.ts` (new)
- `runtime/subsystems/bridge/bridge.tokens.ts` (new)
- `runtime/subsystems/bridge/bridge-errors.ts` (new)
- `runtime/subsystems/bridge/index.ts` (modify — re-exports)

**Depends on.** BRIDGE-1.

**Blocks.** BRIDGE-3, BRIDGE-4, BRIDGE-5, BRIDGE-7, BRIDGE-8.

**Acceptance criteria.**
- [ ] `IJobBridge` interface shaped as repo-style ledger ops (no wrapper-run spawning; that's the framework handler's job).
- [ ] `IEventFlow.publish<T>(event)` and `IEventFlow.publishAndStart<T, J>(event, jobType, input, opts?)` signatures match ADR-023 §Decision 7 verbatim.
- [ ] Tokens are string-valued `as const` (matches events subsystem; see EVT-6 §Implementation Notes for rationale).
- [ ] `MissingTenantIdError` exported with consistent shape.
- [ ] Type-level test compiles.

---

### BRIDGE-3 — Memory backend (`MemoryBridgeDeliveryRepo`)

**Scope.** Test double implementation of `IJobBridge`. In-memory `Map` keyed by `(event_id, trigger_id)`. Ergonomic helpers for tests: `getDeliveriesForEvent(eventId)`, `getByStatus(status)`, `clear()`. UNIQUE constraint simulated (throws on duplicate insert).

**Files touched.**
- `runtime/subsystems/bridge/bridge-delivery.memory-backend.ts` (new)
- `src/__tests__/runtime/subsystems/bridge-delivery.memory-backend.spec.ts` (new)
- `runtime/subsystems/bridge/index.ts` (modify — re-export)

**Depends on.** BRIDGE-2.

**Blocks.** BRIDGE-5 (handler uses it in tests), BRIDGE-7 (facade uses it in tests).

**Acceptance criteria.**
- [ ] `MemoryBridgeDeliveryRepo` implements `IJobBridge`.
- [ ] Duplicate `insertDelivery` for same `(event_id, trigger_id)` throws a `UniqueConstraintError` (same shape as what Drizzle driver raises).
- [ ] Helpers: `getDeliveriesForEvent`, `getByStatus`, `clear`.
- [ ] All state-transition methods (`markDelivered`, `markSkipped`, `markFailed`) round-trip through the map.
- [ ] Unit tests cover all methods + the UNIQUE simulation.

---

### BRIDGE-4 — Drizzle backend + outbox drain integration

**Scope.** `DrizzleBridgeDeliveryRepo` (Postgres impl of `IJobBridge`). Outbox drain modification in `runtime/subsystems/events/event-bus.drizzle-backend.ts`: for each drained event, consult `bridgeRegistry` (provided via DI), and for each matched trigger insert `bridge_delivery` (status=pending) + wrapper `job_run` (type=`@framework/bridge_delivery`, pool=`events_<direction>`), all inside the per-event transaction from ADR-023 §Outbox drain atomicity.

**Files touched.**
- `runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts` (new)
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` (modify — drain integration)
- `src/__tests__/runtime/subsystems/bridge-delivery.drizzle-backend.spec.ts` (new)
- `test/scaffold/tests/bridge-drain.test.ts` (new — Docker integration)

**Depends on.** BRIDGE-1, BRIDGE-2, BRIDGE-3 (integration-test parity reference).

**Blocks.** BRIDGE-5, BRIDGE-8.

**Gate marker.** GATE before opening — DB migration surface + drain modification (most invasive change in the stack; touches already-shipped EVT-4 code).

**Acceptance criteria.**
- [ ] `DrizzleBridgeDeliveryRepo` implements `IJobBridge`; maps DB unique-constraint violation to typed error.
- [ ] Drain consults `bridgeRegistry` via an injected token (injected nullably so non-bridge-enabled projects still drain).
- [ ] Per-event transaction inserts `bridge_delivery` + wrapper `job_run` for every matched trigger.
- [ ] **Per-trigger conflict handling** uses `INSERT ... ON CONFLICT (event_id, trigger_id) DO NOTHING` with rowcount check. If rowcount == 0, the trigger's wrapper `job_run` insert is skipped (facade pre-wrote or a previous drain attempt wrote the row). See Implementation Notes in BRIDGE-4.md.
- [ ] Processed_at stamp on `domain_events` still lands inside the same per-event transaction (no regression of EVT-4 semantics).
- [ ] Docker integration test: publish event with two matching triggers → assert 2 × `bridge_delivery` + 2 × wrapper `job_run` rows, event `processed_at` set, all inside one tx boundary (crash-between is not reachable).
- [ ] Baseline / smoke / unit tests green; no regression of EVT-4 `FOR UPDATE SKIP LOCKED` claim semantics.

---

### BRIDGE-5 — Framework `BridgeDeliveryHandler` (wrapper handler)

**Scope.** The framework `@JobHandler` class that runs on the three reserved `events_*` pools. Three instances registered (one per direction). Handler body: load `bridge_delivery` by `id`, resolve `bridgeRegistry` entry by `trigger_id`, evaluate `when:` predicate (if provided), call `orchestrator.start(jobType, mappedInput, { parentRunId: ctx.run.id, tenantId })`, transition ledger to `delivered | skipped | failed`. Step memoization on `spawn_user_run` step gives replay safety.

**Files touched.**
- `runtime/subsystems/bridge/bridge-delivery-handler.ts` (new)
- `src/__tests__/runtime/subsystems/bridge-delivery-handler.spec.ts` (new)
- `test/scaffold/tests/bridge-handler.test.ts` (new — integration)

**Depends on.** BRIDGE-2, BRIDGE-3 (memory-backed tests), BRIDGE-4 (drain writes the rows this handler consumes).

**Blocks.** BRIDGE-8.

**Acceptance criteria.**
- [ ] Handler reads `bridge_delivery` by id passed in its input.
- [ ] Unknown `trigger_id` (registry evicted since enqueue) → mark `skipped` with `skip_reason='trigger_unregistered'`. See ADR-023 §Trigger rename or removal.
- [ ] `when:` returning false → mark `skipped` with `skip_reason='predicate_false'`.
- [ ] Successful `orchestrator.start` → mark `delivered`, populate `user_run_id`, stamp `delivered_at`.
- [ ] Exception during start → wrapper's own retry policy applies; final exhaustion marks `failed` with error payload.
- [ ] Step memoization via `ctx.step('spawn_user_run', ...)` — replay doesn't spawn twice.
- [ ] Integration test: full fanout chain (publish → wrapper run → user job run with parent_run_id set + trigger_source='event').

---

### BRIDGE-6 — Codegen: `bridgeRegistry` from `@JobHandler.triggers`

**Scope.** AST scan of project handler files for `@JobHandler({ triggers: [...] })` metadata. Emit `runtime/subsystems/bridge/generated/registry.ts` with `bridgeRegistry` keyed by event type, preserving declaration order per type. Build-time validation against the generated `eventRegistry`: unknown event type → hard error. `map:` typecheck happens at TS compile of the generated file. Hook into `just gen-all`.

**Files touched.**
- `src/cli/shared/bridge-registry-generator.ts` (new)
- `runtime/subsystems/bridge/generated/registry.ts` (emitted; stub in repo)
- `runtime/subsystems/bridge/generated/.gitkeep` (new)
- `src/__tests__/cli/bridge-registry-generator.test.ts` (new)
- `src/cli/commands/entity.ts` or equivalent `gen-all` entry point (modify — wire generator)

**Depends on.** BRIDGE-2 (protocol types referenced in generated file).

**Blocks.** BRIDGE-7 (facade consults registry at call time), BRIDGE-8 (module injects it).

**Acceptance criteria.**
- [ ] AST scan locates all `@JobHandler` decorators with a `triggers` array, across configured handler directories.
- [ ] `triggerId` format is stable: `<jobType>#<triggerIndex>`.
- [ ] Unknown event type → codegen hard error listing file + trigger index.
- [ ] Generated file carries `// Generated. Do not edit.` header.
- [ ] Empty project (no handlers with triggers) → emit empty `bridgeRegistry = {}` stub; no error.
- [ ] `just gen-all` on fixture produces expected registry.
- [ ] Baseline snapshot updated.

---

### BRIDGE-7 — `EventFlowService` facade implementation

**Scope.** `EventFlowService implements IEventFlow`. `publish()` delegates to `IEventBus.publish()`. `publishAndStart()` runs inside a single caller-provided-or-created transaction: outbox insert (via `IEventBus.publish(tx)`) + `orchestrator.start(jobType, input, { parentRunId, tenantId })` + (Case B only) `bridge_delivery` pre-write with `status='delivered'`, `wrapper_run_id=null`, `user_run_id=eagerRunId`. Case B is detected by consulting `bridgeRegistry` at call time: if the registry has an entry for `(event.type, jobType)`, it's Case B and the pre-write is required.

**Files touched.**
- `runtime/subsystems/bridge/event-flow.service.ts` (new)
- `src/__tests__/runtime/subsystems/event-flow.service.spec.ts` (new)

**Depends on.** BRIDGE-2, BRIDGE-3 (memory repo for tests), BRIDGE-6 (registry injected).

**Blocks.** BRIDGE-8.

**Gate marker.** GATE before opening — facade dedup semantics against real `bridgeRegistry`.

**Implementation notes.**
- **Transactional coupling is load-bearing.** Case B's `bridge_delivery(status=delivered)` pre-write MUST be inside the same transaction as `orchestrator.start()` (and the outbox insert). A crash between the two leaves an orphan `job_run` with no ledger row → the drain will later insert its own row and double-spawn. Explicit in the spec body.
- The registry lookup is O(1) Map access per call; no performance concern.
- Multiple triggers on same (event, job) are not possible — `triggerId` is stable per (jobType, triggerIndex); the facade writes one delivery row per matched trigger.

**Acceptance criteria.**
- [ ] Case A (no registry entry for (event, job)): `publishAndStart` writes outbox + starts job; no `bridge_delivery` row written; returns `{ runId }`.
- [ ] Case B (registry entry exists): `publishAndStart` additionally pre-writes `bridge_delivery(status='delivered', wrapper_run_id=null, user_run_id=eagerRunId)`.
- [ ] Case B + later drain: drain's `INSERT ON CONFLICT DO NOTHING` returns rowcount=0, skips wrapper spawn, no double-run.
- [ ] All three DB writes in Case B happen inside one transaction (test with crash injection between steps asserts atomicity).
- [ ] `publish()` is a thin `IEventBus.publish()` delegate.

---

### BRIDGE-8 — `BridgeModule.forRoot()` + multi-tenancy enforcement

**Scope.** `BridgeModule.forRoot({ backend: 'drizzle' | 'memory', multiTenant?: boolean })`. Imports `JobsDomainModule` + `EventsModule`. Registers `IJobBridge` backend + `EventFlowService` + `BridgeDeliveryHandler` (three instances, one per reserved `events_*` pool, mirroring EVT-6 `TYPED_EVENT_BUS` provider shape). Exposes all tokens `global: true`. Multi-tenancy threading enforced at three sites via shared `assertTenantId` helper. End-to-end integration test: publish → drain → wrapper → user job execution.

**Files touched.**
- `runtime/subsystems/bridge/bridge.module.ts` (new)
- `runtime/subsystems/bridge/assert-tenant-id.ts` (new — shared helper)
- `runtime/subsystems/bridge/event-flow.service.ts` (modify — tenant gate at entry)
- `runtime/subsystems/bridge/bridge-delivery-handler.ts` (modify — tenant gate at entry)
- `runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts` (modify — tenant gate before write)
- `src/__tests__/runtime/subsystems/bridge.module.spec.ts` (new — NestJS harness)
- `test/scaffold/tests/bridge-e2e.test.ts` (new — Docker end-to-end)

**Depends on.** BRIDGE-4, BRIDGE-5, BRIDGE-6, BRIDGE-7.

**Blocks.** BRIDGE-9.

**Gate marker.** GATE before opening — multi-tenancy review (security-sensitive; mirrors JOB-8 / SYNC-6 precedent).

**Multi-tenancy enforcement sites** (all three use the shared `assertTenantId` helper; identical error-message shape; precedent: JOB-8 §Acceptance Criteria and the Phase 2 plan risk #6):
1. `EventFlowService.publishAndStart` entry — before outbox insert.
2. `BridgeDeliveryHandler.handle` entry — before reading `bridge_delivery` row.
3. `DrizzleBridgeDeliveryRepo.insertDelivery` before write.

At each site: when `multiTenant === true` and resolved `tenantId === undefined`, throw `MissingTenantIdError` naming the call site. Explicit `tenantId: null` passes (cross-tenant work, mirrors JOB-8 contract).

**Framework handler registration** follows EVT-6 `TYPED_EVENT_BUS` provider shape: one `BridgeDeliveryHandler` class, registered three times via factory providers bound to each reserved pool. Reserved-pool concurrency default: 32 (documented in CONSUMER-SETUP in BRIDGE-9).

**Acceptance criteria.**
- [ ] `BridgeModule.forRoot({ backend: 'memory' })` boots in NestJS test harness.
- [ ] `BridgeModule.forRoot({ backend: 'drizzle' })` boots against Docker Postgres.
- [ ] All three multi-tenancy sites throw `MissingTenantIdError` when flag on and `tenantId` undefined.
- [ ] Explicit `tenantId: null` persists and flows end-to-end.
- [ ] Wrong-tenant access at `DrizzleBridgeDeliveryRepo` read path is a silent no-op (mirrors JOB-8 cancel semantics).
- [ ] End-to-end integration: publish event → drain writes delivery + wrapper run → wrapper handler claims, reads delivery, calls `orchestrator.start` → user job row exists with `parent_run_id=<wrapper>.id`, `trigger_source='event'`, `trigger_ref=<event.id>`.
- [ ] `just test-all` green.

---

### BRIDGE-9 — Fanout CLI, Hygen scaffold, CONSUMER-SETUP, skill

**Scope.** Three deliverables: (a) `codegen events consumers <type>` CLI indexing all three tiers (Tier 1 `@OnEvent` subscribers, Tier 2 `publishAndStart` AST scan, Tier 3 `bridgeRegistry`); (b) Hygen scaffold templates for `bun codegen subsystem install bridge` — scaffold runtime files + inject `bridge:` config block; (c) CONSUMER-SETUP section + `.claude/skills/bridge/SKILL.md` with routing and load-on-touch triggers. Flip ADR-023 status from `Revised` to `Shipped`. Promote events phase-roadmap entry from deferred → shipped.

**Files touched.**
- `src/cli/commands/events/consumers.ts` (new — CLI command)
- `src/cli/commands/subsystem.ts` (modify — add 'bridge' dispatch)
- `src/cli/shared/subsystem-detect.ts` (modify — 'bridge' in SubsystemName union)
- `src/cli/shared/config-block-detect.ts` (modify — 'bridge' config-block handling)
- `src/cli/shared/bridge-scaffold-locals.ts` (new)
- `templates/subsystem/bridge/prompt.js` (new)
- `templates/subsystem/bridge/*.ejs.t` (new — one per runtime file)
- `templates/subsystem/bridge-config/prompt.js` (new)
- `templates/subsystem/bridge-config/codegen-config-bridge-block.ejs.t` (new)
- `docs/CONSUMER-SETUP.md` (modify — "Bridge subsystem" section)
- `README.md` (modify — one-line subsystem mention)
- `.claude/skills/bridge/SKILL.md` (new)
- `.claude/skills/bridge/routing.md` (new)
- `.claude/skills/events/SKILL.md` (modify — cross-link)
- `.claude/skills/events/phase-roadmap.md` (modify — Phase 2 → shipped)
- `.claude/skills/jobs/SKILL.md` (modify — cross-link to wrapper handler)
- `docs/adrs/ADR-023-event-to-job-bridge.md` (modify — status Revised → Shipped)

**Depends on.** BRIDGE-8.

**Blocks.** Nothing. Epic closes.

**Gate marker.** GATE before opening — CLI UX + scaffold shape review.

**Risk-driven requirements** (plan doc risks #5 and ADR-023 §Ordering guarantee):
- **AST scan fallback warning**: if the `publishAndStart` AST scanner finds zero call sites but the project has `EventFlowService` registered in its AppModule (detected via a second AST pass), emit `WARN: EventFlowService is imported but no publishAndStart call sites found. The scan may be missing non-standard injection patterns; verify manually.` Do not fail the command — warn only.
- **CONSUMER-SETUP ordering guidance** must mention BOTH control knobs with the tradeoff explicit:
  - `jobs.pools.events_<direction>.concurrency = 1` — blunt instrument; serializes **all** events in that direction; simplest; highest throughput penalty.
  - `concurrency_key` on the user job's `@JobHandler` — granular, per-aggregate ordering (e.g., `concurrency_key: (ctx) => ctx.input.accountId`); preserves parallelism across unrelated aggregates.
- Reserved-pool concurrency default of 32 documented here.

**Acceptance criteria.**
- [ ] `codegen events consumers user.created` prints a single report with three sections (Tier 1 / Tier 2 / Tier 3) and file:line citations.
- [ ] AST scan for Tier 2 identifies `<any>.publishAndStart('user.created', ...)` and also `eventFlow.publishAndStart(...)`; unmatched-but-registered-facade warning path covered.
- [ ] `bun codegen subsystem install bridge` scaffolds all runtime files + injects `bridge:` config block (`backend: drizzle`, `multi_tenant: false`).
- [ ] `docs/CONSUMER-SETUP.md` has "Bridge subsystem" section covering: install command, trigger authoring via `@JobHandler({ triggers: [...] })`, when NOT to use the bridge (sub-second work → `publishAndStart`), ordering guidance (both knobs), reserved-pool concurrency knob.
- [ ] `.claude/skills/bridge/SKILL.md` + `routing.md` exist; routing row added to `.claude/skills/events/SKILL.md`.
- [ ] ADR-023 status flipped; events phase-roadmap Phase 2 promoted.
- [ ] `just test-all` green. Epic closes.

---

## Dependency Graph

```
BRIDGE-1 (schema)
  ├──▶ BRIDGE-2 (protocols + tokens)
  │      ├──▶ BRIDGE-3 (memory backend)
  │      │      └──▶ BRIDGE-5 (framework handler, test parity)
  │      │      └──▶ BRIDGE-7 (facade, test parity)
  │      ├──▶ BRIDGE-4 (drizzle backend + drain integration)   [GATE]
  │      │      └──▶ BRIDGE-5 (framework handler)
  │      │      └──▶ BRIDGE-8 (module wiring)
  │      ├──▶ BRIDGE-6 (codegen bridgeRegistry)
  │      │      └──▶ BRIDGE-7 (facade consults registry)       [GATE]
  │      │      └──▶ BRIDGE-8 (module injects registry)
  │      └──▶ BRIDGE-7 (facade)
  └──▶ (BRIDGE-1 also blocks BRIDGE-3, BRIDGE-4 directly)
            ▼
         BRIDGE-8 (module + multi-tenancy)                     [GATE]
            │
            ▼
         BRIDGE-9 (CLI + scaffold + docs + skill)              [GATE]
            │
            ▼
          Epic closes; ADR-023 status → Shipped
```

**Gates:** CHECKPOINT after BRIDGE-1; GATEs before BRIDGE-4, BRIDGE-7, BRIDGE-8, BRIDGE-9.

**Simplified critical path.** `BRIDGE-1 → 2 → {3,4,6} → {5,7} → 8 → 9`. Sequential in practice (one coordinator, one worktree per plan doc §Orchestration Recommendation).

---

## Suggested Sequencing

Single coordinator, sequential `/develop` loops per `BRIDGE-PHASE-2-PLAN.md` §Orchestration Recommendation. Do not parallelize — each PR's output is the next's input. Gate reports via `.orchestration-gate-<n>.md` file protocol.

---

## Closing note

One epic + 9 sub-issues in GitHub per plan doc; mirror SYNC structure (#60 + #126–#133).
