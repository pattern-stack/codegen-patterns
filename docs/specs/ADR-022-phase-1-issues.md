# ADR-022 Phase 1 — Job Orchestration Domain Model: Issue Breakdown

**Source of truth:** [ADR-022](../adrs/ADR-022-job-orchestration-domain-model.md)
**Phase scope:** Layers 1–4 of the synthesis (triad, hierarchy, scoping, policy). Ships the complete domain foundation: schemas, protocols, services, backends, modules, worker entrypoints, pool config, decorator, boot-time validator, `scopeable` codegen flag, multi-tenancy opt-in, upgrade path, and Atlas migration docs. Does not include signals/wait (ADR-025), observability (ADR-026), or agent step kinds (ADR-027).

---

## Issue List

### JOB-1 — Add Drizzle schemas for `job`, `job_run`, and `job_step`

**Scope.** Three new `pgTable` declarations land in `runtime/subsystems/jobs/`. All columns specified in ADR-022 are present, including the Phase 3 placeholder columns (`wait_kind`, `resume_token`, `wait_deadline`) on `job_run` and the `waiting` enum value on the status column. All required indexes are declared.

**Files touched.**
- `runtime/subsystems/jobs/job-orchestration.schema.ts` (new)
- `runtime/subsystems/jobs/index.ts` (re-export new schema symbols)

**Depends on.** Nothing.

**Acceptance criteria.**
- [ ] `job`, `job_run`, and `job_step` tables are exported as Drizzle `pgTable` objects.
- [ ] `job_run.status` enum includes `pending | running | waiting | completed | failed | timed_out | canceled`.
- [ ] All five indexes on `job_run` (claim, tree, scope, dedupe, concurrency) are declared.
- [ ] Both indexes on `job_step` (`(job_run_id, step_id)` unique, `(job_run_id, seq)`) are declared.
- [ ] `tenant_id` column is present but annotated that it is conditionally emitted (note in comment; the conditional emit logic lives in JOB-7).
- [ ] Phase 3 placeholder columns exist with a `// ADR-025` comment; no application logic references them.
- [ ] A unit test asserts the schema can be imported without error and that expected column names are present.

**Out of scope.** No migration SQL — Atlas generates that from this schema. Service logic and claim query belong in JOB-3/JOB-4.

---

### JOB-2 — Define protocols `IJobOrchestrator`, `IJobRunService`, `IJobStepService` and base types

**Scope.** The three protocol interfaces, plus `JobHandlerBase`, `JobContext<TInput>`, `@JobHandler` decorator, `ParentClosePolicy` enum, and injection tokens. These are the stable public API surface that all backends and consumer code will depend on.

**Files touched.**
- `runtime/subsystems/jobs/job-orchestrator.protocol.ts` (new)
- `runtime/subsystems/jobs/job-run-service.protocol.ts` (new)
- `runtime/subsystems/jobs/job-step-service.protocol.ts` (new)
- `runtime/subsystems/jobs/job-handler.base.ts` (new — `JobHandlerBase`, `JobContext`, `@JobHandler` decorator)
- `runtime/subsystems/jobs/jobs-domain.tokens.ts` (new — `JOB_ORCHESTRATOR`, `JOB_RUN_SERVICE`, `JOB_STEP_SERVICE` symbols)
- `runtime/subsystems/jobs/index.ts` (re-export all new types)

**Depends on.** JOB-1 (protocols reference row types from schema).

**Acceptance criteria.**
- [ ] `IJobOrchestrator` exposes at minimum `start(type, input, opts)`, `cancel(runId, opts?)`, `replay(runId)`.
- [ ] `IJobRunService` exposes `listForScope`, `cancelForScope`, `rescheduleForScope`.
- [ ] `IJobStepService` exposes `recordStep`, `findStep` (sufficient for Drizzle backend in JOB-3).
- [ ] `@JobHandler` decorator accepts `<TInput>` type parameter and a metadata object matching the ADR spec (pool, scope, retry, concurrency, dedupe, timeoutMs, replayFrom).
- [ ] `JobContext<TInput>` exposes `ctx.input`, `ctx.run`, `ctx.step(id, fn, opts?)`, `ctx.spawnChild(type, input, opts)`, `ctx.logger`. No `ctx.waitFor()` — that is ADR-025.
- [ ] `ParentClosePolicy` enum has `Terminate | Cancel | Abandon`.
- [ ] All three injection tokens are `Symbol()` values exported from `jobs-domain.tokens.ts`.
- [ ] Type-level test: a sample `OnboardingHandler extends JobHandlerBase<OnboardingInput>` compiles without casts.

**Out of scope.** No backend implementations — those are JOB-3 and JOB-4.

---

### JOB-3 — Drizzle backends for `IJobOrchestrator`, `IJobRunService`, `IJobStepService`

**Scope.** Production Postgres implementations of all three protocols, including the claim query (`FOR UPDATE SKIP LOCKED`), step memoization logic, parent-close-policy cascade, stale-claim sweeper (time-based, default 5 min threshold), and run-level retry/timeout enforcement. `JobWorker` (the tick-processing loop) also lands here as it is tightly coupled to the Drizzle transaction model.

**Files touched.**
- `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` (new)
- `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts` (new)
- `runtime/subsystems/jobs/job-step-service.drizzle-backend.ts` (new)
- `runtime/subsystems/jobs/job-worker.ts` (new — tick loop, graceful shutdown)
- `runtime/subsystems/jobs/index.ts` (re-export)

**Depends on.** JOB-1, JOB-2.

**Acceptance criteria.**
- [ ] `claimNext(pool)` runs inside a single Drizzle transaction with `FOR UPDATE SKIP LOCKED` and sets `status = 'running'`, `claimed_at = now()`.
- [ ] Dedupe check: a duplicate enqueue within `dedupe_window_ms` returns the existing run ID, no new row.
- [ ] Concurrency collision: `queue | reject | replace` modes are enforced at enqueue time.
- [ ] Step memoization: `ctx.step(id, fn)` returns cached `output` when a `completed` row with matching `step_id` exists; calls `fn` otherwise.
- [ ] `replay_from: 'scratch'` clears `job_step` rows for the run before re-entry; `last_step` clears only the failing step; `last_checkpoint` is the no-op default.
- [ ] Stale-claim sweeper: a `setInterval`-driven loop (wired via `OnModuleInit`) returns rows where `status='running' AND claimed_at < now() - threshold` back to `pending`.
- [ ] `JobWorker` stops claiming on `SIGTERM`, drains in-flight steps within `shutdown_timeout_ms`, then exits.
- [ ] Integration tests (Docker Postgres): enqueue → claim → complete round trip; cascade cancel; dedupe collapse.

**Out of scope.** Memory backend is JOB-4. BullMQ native claim is a no-op for Phase 1 — BullMQ backend of `IJobQueue` (executor layer) is unchanged.

---

### JOB-4 — Memory backends for all three protocols + unit test suite

**Scope.** In-process, mutex-based implementations of `IJobOrchestrator`, `IJobRunService`, and `IJobStepService` suitable for unit tests. Must be behaviourally equivalent to the Drizzle backends for all Phase 1 scenarios (claim, memoize, cascade cancel, dedupe).

**Files touched.**
- `runtime/subsystems/jobs/job-orchestrator.memory-backend.ts` (new)
- `runtime/subsystems/jobs/job-run-service.memory-backend.ts` (new)
- `runtime/subsystems/jobs/job-step-service.memory-backend.ts` (new)
- `runtime/subsystems/jobs/index.ts` (re-export)
- `runtime/subsystems/jobs/__tests__/job-orchestrator.unit.test.ts` (new)
- `runtime/subsystems/jobs/__tests__/job-worker.unit.test.ts` (new)

**Depends on.** JOB-2 (protocols), JOB-3 (behaviour spec to match).

**Acceptance criteria.**
- [ ] Memory claim uses a synchronous mutex (not DB transaction); behaviour matches Drizzle contract.
- [ ] All three collision modes (`queue | reject | replace`) pass the same unit test cases as the Drizzle integration tests.
- [ ] Step memoization and replay modes are tested at unit level without Docker.
- [ ] Cascade cancel (parent terminates → children cancel) is covered.
- [ ] `@JobHandler`-decorated class instantiated in a test module; `ctx.step` memoises across two simulated ticks.
- [ ] All tests run in `just test-unit` (no Docker).

**Out of scope.** No BullMQ-specific claim logic — the executor-layer BullMQ backend is unchanged.

---

### JOB-5 — `JobsDomainModule.forRoot()` and `JobWorkerModule.forRoot()` with pool config loader

**Scope.** Two NestJS `DynamicModule` factories wiring the new protocols to their backends. `JobsDomainModule` is the read/write service module (imported by `AppModule`). `JobWorkerModule` additionally starts the worker tick loop, boots the handler registry, runs the boot-time validator (every `Job` row must have a registered `@JobHandler` class), and upserts `Job` rows from decorator metadata. The pool config loader parses `codegen.config.yaml: jobs.pools`, applies the five framework defaults, validates that user handlers do not target `reserved: true` pools, and wires each pool to an `IJobQueue` queue name.

**Files touched.**
- `runtime/subsystems/jobs/jobs-domain.module.ts` (new)
- `runtime/subsystems/jobs/job-worker.module.ts` (new)
- `runtime/subsystems/jobs/pool-config.loader.ts` (new)
- `runtime/subsystems/jobs/index.ts` (re-export modules)

**Depends on.** JOB-2, JOB-3, JOB-4.

**Acceptance criteria.**
- [ ] `JobsDomainModule.forRoot({ backend: 'drizzle' | 'memory' })` wires all three protocol tokens; `global: true`; matches ADR-008 factory pattern.
- [ ] `JobWorkerModule.forRoot({ mode: 'embedded' | 'standalone', pools?: [...] })` starts the claim loop for each configured pool; stops cleanly via `OnModuleDestroy`.
- [ ] Boot-time validator: if a `Job` row exists in Postgres with no matching entry in the handler registry, module init throws with the missing type name listed.
- [ ] `@JobHandler` classes are upserted into the `job` table on `onModuleInit`; a handler removed from source logs a warning (prune is Phase 6).
- [ ] Pool config loader rejects a user `@JobHandler` targeting a `reserved: true` pool with a descriptive error at module init.
- [ ] Unit test: `JobsDomainModule.forRoot({ backend: 'memory' })` boots in NestJS test harness; `JOB_ORCHESTRATOR` token resolves.

**Out of scope.** Standalone worker entrypoint scaffold file (`worker.ts`) — that is JOB-6.

---

### JOB-6 — Hygen scaffold templates: `worker.ts`, `main.ts` hook, config block

**Scope.** Generator-side additions so that `bun codegen subsystem jobs` (or the upgrade path) emits the two worker entrypoint files and adds the `jobs:` block to `codegen.config.yaml`. Templates live under `templates/subsystem/jobs/` and follow existing Hygen EJS style. The standalone `worker.ts` boots a bare NestJS context with only `JobWorkerModule`; `main.ts` gains an optional embedded import comment. The config block template writes the five default pool definitions.

**Files touched.**
- `templates/subsystem/jobs/worker.ejs.t` (new)
- `templates/subsystem/jobs/main-hook.ejs.t` (new — inject fragment)
- `templates/subsystem/jobs/codegen-config-jobs-block.ejs.t` (new)
- `src/cli/commands/subsystem.command.ts` (minor — wire new job templates to `gen-subsystem jobs`)

**Depends on.** JOB-5 (references module names that must be stable).

**Acceptance criteria.**
- [ ] `just gen-subsystem jobs` produces `worker.ts` and injects a `jobs:` config block in a fresh project scaffold.
- [ ] Generated `worker.ts` imports `JobWorkerModule` and boots a NestJS app without HTTP listener.
- [ ] Config block contains the five default pools with correct `reserved` flags.
- [ ] Baseline snapshot test updated; `just test-baseline` passes.

**Out of scope.** None at the operational-glue level — fresh installs are the only install path (no backwards-compat upgrade flow needed).

---

### JOB-7 — `scopeable: true` entity flag → generated `ScopeEntityType` union

**Scope.** Parser and codegen additions to read `scopeable: true` from entity YAML and collect all such entity names into a generated `ScopeEntityType` TypeScript union. The union is emitted into `@shared/jobs/scope-entity-type.ts` (or equivalent project path). The Zod schema gains the `scopeable` field. No DB CHECK constraint — type safety is TS-only per ADR-022.

**Files touched.**
- `src/schema/entity-definition.schema.ts` (add `scopeable: z.boolean().optional()` to `EntityConfigSchema`)
- `src/parser/load-entities.ts` (collect scopeable names, expose via parsed output)
- `templates/entity/new/clean-lite-ps/` or a new `templates/shared/scope-entity-type.ejs.t` (emit the union file)
- `src/__tests__/schema/entity-definition.schema.test.ts` (unit test for new field)

**Depends on.** JOB-1 (schema uses `scope_entity_type` text column whose type this union matches), JOB-2 (protocol `scope` option in `@JobHandler` references this union).

**Acceptance criteria.**
- [ ] `scopeable: true` in an entity YAML passes Zod validation; absence or `false` also passes.
- [ ] Parser collects all `scopeable: true` entity names across the entities directory.
- [ ] Generator emits a `ScopeEntityType` union containing exactly the scopeable entity names.
- [ ] An entity without `scopeable` does not appear in the union.
- [ ] Unit test: two entities, one scopeable, one not; assert union contains only the first.

**Out of scope.** Multi-tenancy column conditional emit — that is JOB-8. No generated helper methods on `JobRunService` beyond what JOB-3 already provides.

---

### JOB-8 — Multi-tenancy opt-in and Atlas migration docs

**Scope.** Two deliverables. (1) Multi-tenancy: when `jobs.multi_tenant: true` in config, all service methods accept and enforce `tenantId` (column already exists per JOB-1's unconditional emit decision; this issue threads the flag through service-layer logic). (2) Docs: `docs/CONSUMER-SETUP.md` deletes the `drizzle-kit push` recommendation and adds an Atlas migration workflow section.

**Removed (2026-04-18):** Upgrade command (`subsystem upgrade jobs`) — per project policy (no backwards compat until we have users), `subsystem install jobs` overwrites cleanly. No upgrade path needed.

**Files touched.**
- Service-layer files in `runtime/subsystems/jobs/` (orchestrator + run service backends, both Drizzle and Memory; module options + token)
- `docs/CONSUMER-SETUP.md` (delete `drizzle-kit push` section; add Atlas section)

**Depends on.** JOB-1 (schema), JOB-5 (module options).

**Acceptance criteria.**
- [ ] `codegen.config.yaml: jobs.multi_tenant: false` (default): no tenant filtering; `tenant_id` written as null.
- [ ] `multi_tenant: true`: every service method accepts `tenantId`; missing `tenantId` throws `MissingTenantIdError`; explicit `null` allowed for cross-tenant background jobs; queries filter by `tenantId`.
- [ ] `docs/CONSUMER-SETUP.md` contains "Atlas migration workflow" section; `drizzle-kit push` section removed.
- [ ] A reviewer can follow the Atlas section from scratch on a clean project.

**Out of scope.** Tenant-aware fair queuing (Phase 6). `job_event` table (ADR-026). Upgrade command (removed per backwards-compat policy).

---

## Dependency Graph

```
JOB-1 (schema)
  └──▶ JOB-2 (protocols + base types)
         ├──▶ JOB-3 (Drizzle backends)
         │      └──▶ JOB-4 (Memory backends + unit tests)
         │              └──▶ JOB-5 (modules + pool loader)
         │                     ├──▶ JOB-6 (Hygen templates)
         │                     │      └──▶ JOB-8 (multi-tenant + Atlas docs)
         │                     └──▶ JOB-7 (scopeable flag)
         │                            └──▶ JOB-8
         └──▶ JOB-7 (also uses JOB-1 for schema column reference)
```

Simplified linear view of critical path:

```
JOB-1 → JOB-2 → JOB-3 → JOB-4 → JOB-5 → JOB-6 ─┐
                                           JOB-7 ──┴─→ JOB-8
```

---

## Suggested Sequencing

**Wave 1 (parallel foundation).**
JOB-1 (schemas) — no dependencies; unblocks everything.

**Wave 2 (parallel protocol + type work).**
JOB-2 (protocols and base types) — starts as soon as JOB-1 merges.

**Wave 3 (parallel implementation).**
JOB-3 (Drizzle backends) and JOB-7 (scopeable flag) can proceed in parallel once JOB-2 is merged. JOB-7 only needs JOB-1 and JOB-2; it does not need JOB-3.

**Wave 4 (parallel close-out).**
JOB-4 (memory backends) starts after JOB-3 merges (behavioural parity). JOB-5 (modules) starts after JOB-4 merges. JOB-6 (Hygen templates) starts after JOB-5 merges. JOB-8 (multi-tenancy + upgrade + docs) starts after JOB-5, JOB-6, and JOB-7 all merge.

---

## Open Questions for the Owner

1. **`tenant_id` conditional emit mechanism.** The ADR says `tenant_id` appears "only when `codegen.config.yaml: jobs.multi_tenant: true`." Should this be a separate schema file that is included/excluded at scaffold time, or a runtime flag checked when `JobsDomainModule.forRoot()` runs Drizzle migrations? The two approaches have different migration-safety trade-offs.

2. **Stale-claim sweeper placement.** The ADR describes a per-pool stale-claim sweeper but does not specify whether it runs as part of `JobWorker` (one sweeper per pool-worker) or as a separate singleton service in `JobsDomainModule`. With multiple worker processes, a singleton sweeper could double-recover a row that a slow worker is still processing. Clarify expected concurrency model.

3. **`job` table upsert on every boot.** The ADR says `Job` rows are populated from `@JobHandler` decorator metadata at boot. If a consumer runs multiple app instances (horizontal scale), every instance will attempt the upsert concurrently. Should the upsert use `ON CONFLICT DO NOTHING`, `ON CONFLICT DO UPDATE`, or an advisory lock? The right choice affects observable `version` bump behaviour.

4. **Boot-time validator in the Drizzle backend only.** The registry validator checks that every `Job` DB row has a handler. When `backend: 'memory'` is used (tests), there are no DB rows. Should the validator be skipped entirely in memory mode, or should it cross-check the in-memory registry against what would be in the DB? Clarify test-mode semantics.

5. **`ScopeEntityType` union file location.** The ADR says the union is the generated output of `scopeable: true` entity flags, but does not specify where in the consumer project it lands. Candidates: `@shared/jobs/scope-entity-type.ts`, `@shared/types/scope-entity-type.ts`, or co-located with the jobs subsystem scaffold. This affects the import path in `@JobHandler` decorator usage and needs to be locked before JOB-7 templates are written.
