# JOBS-3: `@pattern-stack/jobs` replaces the ADR-022 jobs subsystem

**Status:** in progress (branch `dugshub/jobs-engine`, local) · **Date:** 2026-11-26
**Decisions:** codegen-targets d24 (a framework-free jobs engine, `@pattern-stack/jobs`), d25 (ownership), d26 (jobs in
0.36.0), d32 (the Nest target moves now), d36 as changed by Doug on 2026-11-26 (below) · **Review:**
codegen-targets `docs/REVIEW-repo-jobs-fitness.md` (go, with changes) · **Supersedes:** ADR-022's runtime
(`runtime/subsystems/jobs/`), JOB-1…JOB-8, JOBS-0…JOBS-2, LISTEN-NOTIFY-1/2 as code; the ADRs stay as history with a
revision note.

## Problem

Codegen's jobs subsystem (ADR-022, `runtime/subsystems/jobs/`, 24 files, 13 of them Nest) is Nest-deep: handlers are
found through `ModuleRef`, boot is a Nest module's `onModuleInit`, SIGTERM is handled inside the worker. The non-Nest
targets (plain wiring, Hono, crew on Bun) can't use it. It also has two durability bugs the review found:

- its completion and failure writes match on the run id alone (`job-worker.ts:716-726, 745, 766`), so a swept run can
  be completed twice;
- its shutdown resets **every** running row in its pool to pending, other processes' too (`job-worker.ts:426-433`).

`@pattern-stack/jobs` is a framework-free engine (the core imports only `zod`) with fenced claims, per-step retries,
waits, signals, map steps, budgets, limiters, child runs and three test contracts. The review says go, with four
changes. This spec adds it as a workspace package (`packages/jobs`) and moves codegen's generated Nest apps onto it.

## Decision

### 1. The package

`packages/jobs` → **`@pattern-stack/jobs`**, a workspace package, published beside codegen (not vendored: the source
uses `.ts` imports that `tsc` rewrites at build, ADR-037's package mode). Export paths, each framework an optional peer:

| Path | What | Peer |
|---|---|---|
| `.` | define (`defineJob`, `step`, `mapStep`, waits, children), the engine entry points, the registry, errors | `zod` (dependency) |
| `./ports` | the store, executor, limiter, clock, sink ports, for adapter authors | |
| `./testing` | the memory store, `storeContract`, `limiterContract`, `replayContract`, fakes | |
| `./postgres` | `PostgresJobStore` over tables handed in (`JobTables`), `eventLogSink` | `drizzle-orm` |
| `./bullmq` | the BullMQ executor (dispatch only) | `bullmq` |
| `./redis` | `redisLimiters`, sweep cursors on Redis/Valkey | none (the app's client) |
| `./nest` | `JobsService`, the actor policy, the module | `@nestjs/common` 10 or 11, `@opentelemetry/api` |
| `./shapes` | the wire shapes, moved in from `@repo/shared/jobs` and `/jobs-ops` | |

"Rewritten slightly" (d24), and nothing more:
- **organization → tenant** throughout, in one commit before any behaviour change (§3 lists every renamed name);
- pattern-stack names: `@pattern-stack/jobs`, `Symbol.for('@pattern-stack/jobs/…')` tokens (ADR-037), log prefixes;
- no `@repo/*` import: the shapes live in `src/shapes/`;
- the Biome fences become tests (`src/__tests__/fences.test.ts`): the core imports only `zod` and its own files; each
  framework only under its export path; production code never imports `./testing`;
- ids are loosened: `requestedBy` is any string, not a uuid; the emitted tables use `text` tenant and user columns
  (codegen's `tenancy:` decides the type), never FKs to an `organizations` table.

The package's own tests run in codegen's `test-all` (`just test-jobs`: `bun test packages/jobs/src` and its
typecheck). `storeContract` runs on the memory store there, and on real Postgres in `test-integration`, over the
tables codegen emits.

### 2. The review's four changes, each with a test that fails without it

1. **The open-run sweep.** The in-process executor pages `openRunIds` (keyset, the store's own cursor) on `start()`
   and on each poll, and submits every open run it registers. So a restarted process resumes a run it was never
   handed, and a run another process created (the bridge's start in a transaction) is found. Test: the
   kill-and-restart case: executor A starts a run and dies mid-step; a fresh executor B over the same store, never
   told the run id, completes it.
2. **A lease per run.** An optional store-port method set, `leaseRun(runId, owner, ttlMs)` /
   `renewRunLease` / `releaseRunLease`, on `job_runs` (owner, token, expiry). The in-process executor takes the lease
   before advancing and renews it while the advance runs; another executor's advance of a leased run is skipped. The
   memory and Postgres stores implement it; `storeContract` gains its cases. Test: two executors over one store, one
   run with a slow plain step: the step's code runs once.
3. **A fixed tenant value.** `tenantId` stays a required string. A single-tenant app, and cross-tenant housekeeping,
   use `SYSTEM_TENANT` (`'__system__'`, exported), never NULL: NULL would break the one-open-run-per-key unique index,
   the composite FKs, the result cache and the limiters. Test: two starts under `SYSTEM_TENANT` with one dedupe key
   join one run.
4. **A tenant-scope hook.** An executor option `around(run, fn)` wraps every place job code runs: a plain step, a gate
   check, a map step's source, hydrate and batch, `admit`, `accept` and `each`. Codegen's Nest target passes one that
   enters the repositories' `AsyncLocalStorage` tenant scope (ADR-042). The engine's determinism is untouched: these
   are effects inside steps. Test: a step reads the scope and sees its run's tenant; without the hook it sees none.

### 3. d36, as Doug settled it (2026-11-26)

Codegen job features the engine lacked. Built in, each with tests:

- **Collision modes**, on the dedupe key (codegen's old ones were on a separate concurrency key; Doug's call puts
  them on the key the engine already has): `collision: 'join' | 'queue' | 'replace'` on the start request, and on the
  job (`defineJob({ collision })`) as its default.
  - `join` (the default, the engine's behaviour): the start returns the open run.
  - `queue`: the new run is created **`queued`**, a run status outside the one-open-run index, never swept or
    advanced. When the run ahead of it on the key ends (completed, failed or canceled), the store makes the oldest
    queued run `pending` in the same transaction, so runs on one key go one at a time, oldest first (by creation time; two made in one millisecond are in no promised order). On Postgres the
    queued insert locks the open run first, and the end locks the same row, so no queued run is stranded. A queued
    run can be canceled before it starts.
  - `replace`: `startRun` cancels the open run (its children with it; `run.canceled` when it's given `events`), then
    starts afresh, retrying a bounded number of times if another start takes the key in between.
  Codegen's old semantics: `job-orchestrator.drizzle-backend.ts:203-223`.
- **A dedupe window**, `dedupeWindowMs` (on the request, and on the job as its default; a whole number, 0 for none):
  a start within the window after a run with the same tenant, job, dry-or-real and key **ended** returns that run, as
  if it were open; an open run still answers first. Codegen's old one: `drizzle-backend.ts:501`. **The bridge's
  exactly-once path never leans on it**: exactly-once comes from the transaction that marks the delivery (§4).
- **Priority is a pool.** There is no `priority` field. Work that must not wait behind other work names its own
  limiter (a "pool", `step({ limiter })`): two limiters with their own capacity run side by side, and a full one never
  holds the other back (`collisions.test.ts`, "priority is a pool"). A YAML `pool:` becomes a limiter of that name.
- **Start at a time** is a first wait step (a signal wait with a timeout, or a gate), not a start field.
- **Re-run of a past run** stays out (a new run with the same input reuses the map-step cache).

### 4. The Nest target on the new engine

Generated Nest apps use `@pattern-stack/jobs/nest` and `./postgres`:
- **Job definitions.** A job is a `defineJob` value in `<name>.job.ts`, registered in one generated registry; no
  `@JobHandler` class. A job whose steps need the app's services is a **job factory** (below).
- **YAML jobs** (`definitions/jobs/*.yaml`, RFC-0005) emit a `defineJob` skeleton: one plain step per arm, its read
  seam left to the author, as today's arms.
- **Tables.** Codegen emits the package's table shape (`job_runs`, `job_steps`, `job_chunks`, `job_items`,
  `job_results`, `job_events`, …) with `text` tenant columns and binds them with `satisfies JobTables`.
- **The bridge** (ADR-023): the outbox drain, in the event's transaction, writes the `bridge_delivery` row, evaluates
  `when`/`map`, starts the user's run with `startRun` over a store built on that transaction, and marks the delivery
  delivered with the run id. No wrapper job, no reserved `events_*` pools, no dynamic child job. The run is submitted
  after commit, and the executor's sweep (change 1) finds it if the submit is lost.
- **An `event` trigger:** `RunTrigger` gains `'event'`; a bridge start records the event id as its trigger ref.
- **The worker** is the in-process executor, started and stopped by the jobs module's lifecycle; the app's entry
  owns SIGTERM. The `LISTEN` wake becomes an executor extension calling `submit`.
- **Deleted:** `runtime/subsystems/jobs/` (ADR-022's subsystem), the bridge's wrapper handler, reserved pools and
  their validator, and the tests of each.

Breaking change: CHANGELOG `[Unreleased]` and `docs/MIGRATION-jobs-engine.md`.

### 5. Job factories: a step that needs the app's services (default taken 2026-11-27; Doug can overrule)

ADR-022's handlers reached use cases through Nest DI (`ModuleRef`), and YAML job arms must call the provider's
`ExecuteIntegrationUseCase`; a module-level `defineJob` value cannot be handed either. So the unit of a job with
dependencies is a **factory**: a plain function from typed dependencies to a `defineJob(...)`, framework-free, so
plain wiring (PW) uses the same unit.

- **The core** (`@pattern-stack/jobs`, `define/job-factory.ts`): `jobFactory({ deps, create })`. `deps` names each
  dependency by token — its class, or `injected<T>(token)` for a string / symbol token — and types `create`'s
  argument (`DepsOf`). `isJobFactory`, `tokenOf`, `JobEntry = AnyJob | JobFactory`. No framework import.
- **The registry scan** lists `export const X = jobFactory(...)` beside `defineJob` / `define<Name>Job` exports;
  `<generated>/jobs.ts` is `readonly JobEntry[]`.
- **The Nest binding** (`@pattern-stack/jobs/nest`'s `JobsModule`, so every Nest host gets it; `buildJobs` / `assertResolvable` are in the core): `buildJobs` calls each
  factory with every dependency resolved through `ModuleRef.get(token, { strict: false })`, so a provider of any of
  the app's modules resolves (the integration assembly exports its use case under
  `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` from its own module). A dependency is handed as a stand-in that
  resolves on first use and forwards to the instance, so the job list can be built while Nest is still
  instantiating modules, in any order; the rule that follows is that `create` must not read a dependency's fields
  while building the job, only in a step, and a dependency must be an object. At bootstrap every factory dependency
  is resolved once (`assertResolvable`), so a missing provider stops the boot naming the job and the dependency.
  The factory is the unit, not an `@Injectable` class.
  The binding lives in the package's `JobsModule`, not codegen's runtime: the installed package resolves the app's
  own `@nestjs/core` (`ModuleRef` is a class token, so its identity matters), and `@nestjs/core` is the package's
  optional peer beside `@nestjs/common`.
- **Plain wiring:** the composition calls `factory.create(deps)` with the values it holds; `buildJobs` is not needed.
- **YAML jobs:** the emit-once `<type>.job.ts` is a factory (`deps: {}` and a comment naming the use-case token
  shape), its arms written inside `create`.
- **Proof:** `src/__tests__/runtime/subsystems/job-factories.spec.ts` writes the emitter's own output for
  `drive_poll.yaml`, fills the arm to call `ExecuteIntegrationUseCase` under its token from a separate module, boots
  the real `JobsEngineModule`, and runs the job: the arm reaches the use case. Also: a class token, a plain value
  beside factories, the boot failure, and lazy resolution.

Plain `defineJob` values with no dependencies are unchanged.

### Left out (d36 and the lane)

Jobs on plain wiring (the plain-wiring lane's PW-4 needs to land first); agents as jobs (the in-step memo
`ctx.step(id, fn)`, spend from a plain step, cancel mid-call, a limiter per sub-step: review §7); a `job` definitions
table and the orphan boot validator (the registry is code); `jobs-output-refs`; the ops UI.

## Renamed or removed public names

| Before (ADR-022 / ADR-023) | After |
|---|---|
| `@JobHandler(type, meta)` class, `JobHandlerBase`, `JobContext` | `defineJob({ key, input, output, steps })`, `step` / `mapStep` / `waitFor` / `children`; `jobFactory` for dependencies |
| `@JobHandler({ triggers })` | `jobTriggers('<key>', [...])` beside the job |
| `IJobOrchestrator` / `JOB_ORCHESTRATOR`, `start(type, input, { tenantId, parentRunId }, tx)` | `JobStarter.start(key, input, { tenantId, dedupeKey, collision, dedupeWindowMs, trigger, budget }, tx)` |
| `JobsDomainModule` + `JobWorkerModule` | `JobsEngineModule.forRoot({ definitions, worker, limiters, inProcess })` |
| `job` / `job_run` / `job_step` + 8 pgEnums | `job_runs`, `job_run_steps`, `job_run_items`, `job_run_chunks`, `job_run_events`, `job_run_values`, `job_item_results` (`@pattern-stack/jobs/postgres`, `timestamptz(3)`, text tenant) |
| `BridgeTriggerEntry.jobType`, `ScannedTrigger.jobType` | `jobKey` |
| `publishAndStart(event, jobType, input, { tenantId, parentRunId })` | `publishAndStart(event, jobKey, input, { tenantId, dedupeKey })` |
| `BridgeDeliveryHandler`, `BRIDGE_RESERVED_POOLS`, `BridgeReservedPoolsNotPolledError`, `bridge_delivery.wrapper_run_id` | removed: the drain starts the run in the event's transaction |
| `jobs.backend`, `jobs.extensions`, `jobs.worker_pools`, `jobs.all_pools`, `jobs.multi_tenant`, `jobs.pools.<n>.queue` / `.reserved` | removed (each an error naming itself and the migration note); `jobs.poll_interval_ms`, `open_sweep_every`, `version_grace_ms` added |
| YAML job `scope`, `concurrency`, `timeoutMs`, `replayFrom`, `dedupe.key` | removed; `collision`, `dedupe: { windowMs }` added |
| `entity.scopeable`, the `ScopeEntityType` union and its generator | removed |
| `IObservability.getPoolDepths` / `getRecentFailedJobs` / `listJobRuns`, the timeline's job runs | removed: `JobsService` is the operator view |
| `JOBS_WAKE_CHANNEL`, the jobs `LISTEN` wake | removed; `pg-notify` lives in events |
| `@pattern-stack/codegen` peer `bullmq` | removed; peer `@pattern-stack/jobs` (optional) added |

## As built

Branch `dugshub/jobs-engine` (local), from origin/main `a727f338`; the commits list in
`codegen-targets/docs/HANDOFF-jobs-port.md`. Where it differs from the plan above, or settled what the plan left open:

- **Tables.** The package owns them (`packages/jobs/src/postgres/tables.ts`, typed `JobTables`); the app re-exports
  them (the vendored `job-orchestration.schema.ts` template is that re-export). Names are `job_run_*`, not the
  plan's `job_steps` …. They are `timestamptz(3)`, not `timestamp(3)`: the scaffold's #796 gate (only declared
  opt-outs are naive) caught the package's naive columns.
- **The bridge start is not submitted after commit**: the drain has no after-commit hook, so the run is found by the
  executor's open-run sweep (`openSweepEvery: 4` in generated apps, about a second).
- **The standalone worker** boots the app's own `AppModule` and starts `JOBS_EXECUTOR`; it carries no config.
- **No LISTEN wake** for the executor (polling plus the sweep). A follow-up if latency needs it.
- **Collisions are on the dedupe key** (d36), and `queued` is a run status outside the open index.
- **Packaging:** `@opentelemetry/api` is a dependency of the package (its `./nest` imports it at load);
  `@pattern-stack/jobs` is an optional peer of `@pattern-stack/codegen`. The smokes install the package from a
  packed tarball (`addJobsPackage`), and `aliasPackageRuntime` pins `drizzle-orm` to the project's copy.
- **Job factories** (§5) — added after the PM's call on 2026-11-27. The Nest binding is the package's `JobsModule`.
- **After `/code-review` (2026-11-27):**
  - A YAML job always emits `limits` (YAML `limits:`, each field optional; default 1000 items, $10, 1000 calls, one
    hour — a default taken): a bridge or schedule start names no budget, and a job without limits refused it.
  - A trigger that cannot start fails alone: its start runs in a savepoint and its delivery is marked `failed` with
    the error; the event commits and its other triggers and subscribers go ahead (before, one bad trigger rolled the
    event back on every drain, for good).
  - Triggers may declare `dedupeKey: (e) => string` (copied like `map`); the drain passes it, so the job's
    `collision` applies to bridge starts. A YAML job with `collision` or `dedupe` emits `() => '<type>'`: ADR-022's
    overrun protection back. Exactly once stays the ledger's.
  - The drain hook's bootstrap refuses a trigger whose job key no registered job has (a typo would otherwise be
    `skipped` for good).
  - `JobStarter.start` without a `tenantId` takes the ambient requester's tenant (`null` or no requester:
    `SYSTEM_TENANT`); a failed submit is logged, not thrown (the run exists; the sweep resubmits it).
  - A process that is no worker (`worker: false`) never submits (`JobStarter`, the package's `JobsService`): its job
    code would run with no lease heartbeat and a worker would take the run over mid-step.
  - The BullMQ executor runs advances and chunks inside the host's `RunScope` (it did not; the in-process one did).
  - The job and trigger scans skip `*.test.ts`, `*.spec.ts` and `__tests__/`.
- **Not built:** the BullMQ executor path in generated apps (the package has it; codegen composes in-process only);
  a lease lost mid-advance is not aborted (documented limit); `JOBS_CONTRACT.md` is the package's contract, its
  host places written as a codegen app's (a fuller rewrite for codegen is a follow-up).
- **Gates:** `just test-unit`, `just test-jobs` (package), `just test-jobs-integration` (Postgres store contract),
  `just test-integration` (scaffold, incl. the tenant scope through the real executor), the smokes and baseline.
