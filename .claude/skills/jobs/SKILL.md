---
name: jobs
description: Load when working anywhere in the jobs subsystem. Triggers include authoring or reviewing `@JobHandler` classes; touching `IJobOrchestrator` / `IJobRunService` / `IJobStepService` or their Drizzle/Memory backends; changes under `runtime/subsystems/jobs/`; the job worker loop, claim query, stale-claim sweeper, or graceful-shutdown logic; pool configuration under `codegen.config.yaml: jobs.*`; the jobs subsystem scaffold templates in `templates/subsystem/jobs/`; and any work referencing ADR-022 or JOB-1..JOB-8 specs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Jobs Domain (ADR-022 Phase 1)

The jobs subsystem is codegen-patterns' durable job orchestration system for generated NestJS + Drizzle apps. It models runs as first-class domain rows (queryable by scope, cancellable as trees, memoized per step) rather than hiding everything behind a narrow dispatch port. Phase 1 ships the Drizzle and Memory backends of `IJobOrchestrator`; later phases add signals, observability, and agent steps.

**Authoritative sources (read when you need depth, not every time):**
- `docs/adrs/ADR-022-job-orchestration-domain-model.md` — the decision record. Don't reproduce; link.
- `docs/specs/JOB-1.md` … `JOB-8.md` — per-PR implementation specs (schema, protocols, backends, module, templates, scope flag, multi-tenancy).
- `docs/specs/ADR-022-phase-1-issues.md` — issue breakdown + dependency graph.

## Mental model

### The triad

Three Drizzle tables, one domain concept each. Do not add a fourth for "executor state" — there isn't one.

| Table | Meaning | Lifetime |
|---|---|---|
| `job` | Row per registered handler type. Configuration materialised from decorator metadata at boot. | Long-lived; upserted on every boot via `ON CONFLICT DO UPDATE`. |
| `job_run` | Row per execution. Durable state machine; queryable by scope; cancellable as a tree. | Permanent; archived by ops, not the framework. |
| `job_step` | Row per checkpoint within a run. Powers memoization and granular retry. | Tied to parent run. |

`parent_run_id` + `root_run_id` form the hierarchy. Runs without a parent set `root_run_id = id` at insert (client-generated UUID, no self-FK — see JOB-1).

### Single-layer architecture (do not forget this)

There is **no** `IJobQueue`, **no** `job_queue` table, **no** executor port. The worker polls `job_run` directly with `SELECT ... FOR UPDATE SKIP LOCKED`. One retry policy, one claim mechanism, one state location. If a historical reference ever says "enqueue on IJobQueue," it is from a deleted layer — ignore it and use `IJobOrchestrator.start(...)` instead.

### Core contract + extensions

Per CLAUDE.md, backends are core-contract + opt-in extensions. The core contract is `IJobOrchestrator` + `IJobRunService` + `IJobStepService`; app code against these three is portable. Extensions are backend-specific capabilities exposed additively in `codegen.config.yaml: jobs.extensions.<backend>`. Phase 1 ships:

- **Drizzle backend** — core contract implemented. Extensions reserved: `listen_notify`, `poll_interval_ms`.
- **Memory backend** — core contract for tests. No extensions.
- **BullMQ backend** — **does not exist yet.** Reserved for Phase 6+. Do not document or pretend otherwise.

When adding features, default to the core contract. Only push something into `extensions:` when it is genuinely backend-specific (e.g. Bull Board, `LISTEN/NOTIFY`).

### Where code lives

```
runtime/subsystems/jobs/
  job-orchestration.schema.ts        # JOB-1: job, job_run, job_step + enums + indexes
  job-orchestrator.protocol.ts       # JOB-2: IJobOrchestrator
  job-run-service.protocol.ts        # JOB-2: IJobRunService
  job-step-service.protocol.ts       # JOB-2: IJobStepService
  job-handler.base.ts                # JOB-2: JobHandlerBase, JobContext, @JobHandler, ParentClosePolicy
  jobs-domain.tokens.ts              # JOB-2: JOB_ORCHESTRATOR / JOB_RUN_SERVICE / JOB_STEP_SERVICE
  job-*.drizzle-backend.ts           # JOB-3: production backends + JobWorker
  job-*.memory-backend.ts            # JOB-4: test backends
  memory-job-store.ts                # JOB-4: shared in-memory store
  jobs-domain.module.ts              # JOB-5: DynamicModule wiring tokens
  job-worker.module.ts               # JOB-5: lifecycle, validator, registry scan
  pool-config.loader.ts              # JOB-5: reads codegen.config.yaml: jobs.pools
templates/subsystem/jobs/            # JOB-6: main scaffold (worker.ts, main hook, schema)
templates/subsystem/jobs-config/     # #121 (F13): config-block inject, invoked independently
                                     #   - `subsystem install jobs --force` alone preserves an
                                     #     existing `jobs:` block
                                     #   - `--force-config` opts into regeneration
```

User-authored handler classes live in the consumer app, typically under `src/jobs/` or colocated with their use case. **Jobs are TypeScript classes with `@JobHandler`. There is no jobs-as-YAML codegen — ADR-022 rejected it explicitly.**

## Routing table (read only what your task needs)

| Task | L1 file |
|---|---|
| Writing a `@JobHandler`, using `JobContext`, spawning children, memoizing work | [handler-authoring.md](./handler-authoring.md) |
| Touching the orchestrator, worker loop, claim query, stale sweeper, graceful shutdown | [orchestrator-and-worker.md](./orchestrator-and-worker.md) |
| Configuring pools, reading/writing `codegen.config.yaml: jobs.*`, adding custom pools, core/extension surface | [pools-and-config.md](./pools-and-config.md) |
| Deciding what to build now vs. defer; what's Phase 1 vs. 2/3/5/6 | [phase-roadmap.md](./phase-roadmap.md) |

Cross-domain: job-completion events and the events outbox drain into the three reserved `events_*` pools. See `../events/SKILL.md` (once it exists) or `runtime/subsystems/events/` for the producer side.

## Non-obvious rules you MUST internalise

### State machine values

```
pending → running → { completed | failed | timed_out | canceled }
running ⇄ waiting   # schema column exists Phase 1, behaviour ships Phase 3 (ADR-025)
```

`jobRunStatusEnum` is exactly `['pending', 'running', 'waiting', 'completed', 'failed', 'timed_out', 'canceled']`. `waiting` MUST be present from Phase 1 so Phase 3 doesn't require a breaking migration. `scheduled` is not an enum value — "scheduled" means `status='pending' AND run_at > now()`, filtered at the claim query.

### `parent_close_policy` semantics

Stored on the **child** at spawn; later changes to the parent don't retroactively rewrite children.

- `terminate` (default) — when parent enters any terminal state, running children are cancelled with `error.reason = 'parent_terminated'`.
- `cancel` — same effect on children, but the parent's `finished_at` is set only after children finish transitioning.
- `abandon` — children untouched; fire-and-forget.

Cascade cancel walks via `root_run_id`, not recursive `parent_run_id` chases.

### Reserved pools are off-limits to user handlers

`events_inbound`, `events_change`, `events_outbound` are `reserved: true`. These exist for the `IEventBus` outbox drain, one pool per `DomainEvent.direction`. A user `@JobHandler({ pool: 'events_change' })` **must fail at module init** with `ReservedPoolViolationError` (JOB-5). Do not attempt to "just write to that queue" — use `IEventBus` from the events subsystem and let the bridge enqueue.

Default user pool is `batch`. `interactive` must be opted in explicitly.

### Concurrency collision modes

Set once per job on `@JobHandler({ concurrency: { key, collisionMode } })`, not per call site.

- `queue` (default) — new run accepted in `pending`; claimed only when incumbent exits non-terminal states.
- `reject` — new enqueue throws `JobCollisionError` with the incumbent's runId.
- `replace` — incumbent is cancelled cascade, new run starts. Matches "latest-wins" agent loops.

Concurrency is **orthogonal to dedupe**. Dedupe short-circuits (returns incumbent's runId, no new row); concurrency queues (new row exists, claim is gated).

### Replay modes

`@JobHandler({ replayFrom })` — one of `scratch | last_step | last_checkpoint` (default `last_checkpoint`). Replay is a memoization policy only — same handler code runs all three times.

- `scratch` — clear all `job_step` rows for the run, re-enter empty.
- `last_step` — clear only the failing step's row.
- `last_checkpoint` — clear nothing; memoized steps return cached `output`.

### Step memoization contract

`ctx.step(id, fn, opts?)` is the only primitive that knows about memoization.

1. Look up `(job_run_id, step_id)` in `job_step`. If `status='completed'`, return `step.output` without calling `fn`.
2. Otherwise record a `running` row, `await fn()`, upsert terminal status on success or failure. Rethrow on failure.

Implications:
- `step_id` must be **stable across replays**. Hardcode it (`'pull_emails'`) or derive from input (`\`recompute:\${ctx.input.accountId}\``) — never `Date.now()` or random.
- `fn` should be effectively idempotent when `replayFrom='scratch'`.
- Step output must be JSON-serialisable (it lives in `jsonb`).
- Don't try to "step" around `spawnChild` — child runs are their own memoization root.

### `JobContext` API surface — Phase 1 only

```ts
ctx.input    // typed via @JobHandler<TInput>
ctx.run      // JobRun row (id, rootRunId, scope, tags, parentRunId, ...)
ctx.step(id, fn, opts?)            // durable memoized step
ctx.spawnChild(type, input, opts?) // returns child JobRun
ctx.logger   // scoped NestJS Logger
```

**NOT in Phase 1, deferred to ADR-025:**
- `ctx.waitFor(kind, token, opts)` — parking on signals
- `ctx.signal(token, payload)` — resuming others
- `ctx.sleep(ms)` — timer-driven wait

The `wait_kind`, `resume_token`, `wait_deadline` columns and the `waiting` enum value exist in the Phase 1 schema as placeholders (JOB-1) but no code reads/writes them yet. Don't wire them up.

### `scopeable: true` and `ScopeEntityType`

Entity YAML opts in via `scopeable: true`. The codegen run emits `src/shared/jobs/scope-entity-type.ts` with a TS union of all flagged entity names. `@JobHandler` consumers reference it:

```ts
scope: { entity: 'account' satisfies ScopeEntityType, from: (i) => i.accountId }
```

DB column is plain `text` with no CHECK constraint — type safety is TS-only, on purpose (adding a new scopeable entity is code-gen only, no migration). See [handler-authoring.md](./handler-authoring.md) and `docs/specs/JOB-7.md`.

## Do-not list

- **Do not enqueue on `IJobQueue`.** It doesn't exist. Use `IJobOrchestrator.start(type, input, opts)`.
- **Do not add a `job_queue` table or an executor port.** The prior two-layer design was collapsed intentionally; the single-layer claim query is the architecture.
- **Do not write `// deprecated` or emit an upgrade command.** No users exist. Replace cleanly. See CLAUDE.md operating principles.
- **Do not build a "uniform BullMQ/Drizzle interface that hides everything."** Core contract is the portability floor; backend extensions live under `codegen.config.yaml: jobs.extensions.<backend>`.
- **Do not target a reserved pool** from a `@JobHandler`. Module init will throw.
- **Do not use `Date.now()` or randomness for `step_id`.** Memoization requires stable ids.
- **Do not invent jobs-as-YAML codegen.** ADR-022 explicitly rejected it. Users write TypeScript `@JobHandler` classes; codegen only ships the system around them.
- **Do not call `ctx.waitFor` / `ctx.signal` / `ctx.sleep`.** Phase 3 only. If you need to pause work in Phase 1, split into parent + child runs and let `ctx.spawnChild` drive sequencing.
- **Do not add a CHECK constraint to `scope_entity_type`.** Type safety lives at the TS layer; the column stays free-text so a new scopeable entity is codegen-only.
- **Do not document a BullMQ backend.** It is Phase 6+ and does not exist. Mention it only as a reserved extension slot, never as available today.

## Quick-start pointer

For the "write a new `@JobHandler` from zero" path, jump to [handler-authoring.md](./handler-authoring.md). It walks through decorator metadata, `ctx.step` / `ctx.spawnChild`, scope wiring, and how a use case kicks the job off via the injected `IJobOrchestrator`.
