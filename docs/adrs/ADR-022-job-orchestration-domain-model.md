# ADR-022 — Job Orchestration Domain Model

**Status:** Draft
**Date:** 2026-04-17
**Owner:** Doug
**Related:** ADR-008 (Subsystem Architecture), ADR-005 (Entity Family Base Classes)
**Unblocks:** ADR-023 (Event-to-Job Bridge), ADR-025 (Coordination & Signals), ADR-026 (JobEvent Observability), ADR-027 (Agent Job Extensions)

## Context

The existing `jobs/` subsystem (ADR-008) ships `IJobQueue` — a narrow, four-method executor protocol (`enqueue`, `process`, `schedule`, `cancel`) with Drizzle, Redis, BullMQ, and Memory backends. It solves *how* to dispatch a unit of work; it does not model *what* a job is at the domain layer.

In consumer apps (Dealbrain, demo app), this gap has produced known failure modes:

1. **No hierarchy.** An onboarding flow enqueues `pull_emails`, `process_facts`, and `suggest_updates` as three independent `IJobQueue` tasks. When a user's onboarding is canceled, the children keep running. When one fails, the others have no awareness.
2. **No ownership.** A BullMQ job carries `{ type, payload }`. There is no record linking it to the account, opportunity, or contact it was launched for. Queries like "show me every job for this account" or "reschedule everything tied to this opportunity" cannot be answered.
3. **No lane isolation.** Outbound webhooks, inbound ingests, domain-change events, and user-triggered work all flow through the same BullMQ queue. A slow outbound handler stalls change-event propagation; a user's export queues up behind a batch onboarding job.
4. **No visibility.** `IJobQueue` tracks `pending | active | completed | failed`. No parent/child timeline, no step-level breakdown, no cost tracking for LLM steps, no audit trail when a job is canceled or signaled.
5. **No signals.** Agent jobs that need to pause for tool approval, external webhooks, or human-in-the-loop have nowhere to park. Today this is emulated with ad-hoc Redis keys or rerun-with-state hacks.

The industry's prior art on this is well-mapped (see `docs/specs/job-orchestration-research.md` for the synthesis): Airflow/Dagster (definition vs. run, task instances, pools, tags), Temporal (child workflows, parent close policy, task queues, signals), Prefect (work pools, subflows), Step Functions (task tokens, pause-for-external-signal), Inngest (step memoization, concurrency keys, idempotency keys), and the agentic platforms (LangGraph interrupts, OpenAI run steps, Inngest AgentKit). The intersection of these systems is a small, stable set of concepts.

This ADR locks that intersection as the domain model for `@pattern-stack/codegen`'s jobs subsystem.

## Decision

### Architectural spine — single layer with core/extension protocol

**Revised 2026-04-18.** The original two-layer design (`IJobQueue` executor + orchestration layer above) is collapsed into a single `IJobOrchestrator` protocol. Reasoning: `IJobQueue` was a degenerate transport — used only to deliver `{type: 'job_run_tick', payload: {runId}}` wake-up messages, with the actual domain state in Postgres `job_run`. Two storage locations, two retry mechanisms (one ignored), and a port that hid every native feature of any swappable backend (BullMQ Flow Producer, Bull Board, repeatable jobs) behind a four-method dispatch primitive. The "swap transport" benefit was not real because no app code differed across backends — they all behaved identically by design.

Per the project's core/extension principle (CLAUDE.md), swappable backends are now structured as:

- **Core contract** — `IJobOrchestrator` (and `IJobRunService`, `IJobStepService`) define the minimum capability every backend must implement: start, cancel, replay, listForScope, basic memoized `ctx.step`, hierarchy with close policy, retry policy, dedupe, concurrency keys. App code written against the core is portable across all backends.
- **Extensions** — backends MAY add features beyond the core. A future BullMQ backend would expose Bull Board mounting, Flow Producer parent/child, repeatable jobs, native rate limiting. The Postgres backend exposes `LISTEN/NOTIFY` hooks and advisory-lock primitives. Consumers using extensions opt into backend-specific code paths and accept they are no longer portable across backends.

```
App use case / scheduler / bridge
        │
        ▼
JobService.start(type, input, scope)         ← core API surface
JobRunService.cancel / signal / resume
        │
        ▼
DrizzleJobOrchestrator (Phase 1)             ← claims rows directly from job_run
   FOR UPDATE SKIP LOCKED on job_run         ← no separate transport table
        │
        ▼
Worker loop: claim → run handler → record steps → transition state → loop
        │
        ▼
JobEventLogger → IEventBus (selective broadcast)
```

Consequences:
- One Drizzle table family for jobs (`job`, `job_run`, `job_step`). The `job_queue` table from the prior `IJobQueue` design is removed.
- One retry policy: `Job.retry_policy` + per-step `ctx.step` options. No competing executor-level retry.
- One claim mechanism: `JobWorker.claimNext(pool)` issues `SELECT ... FOR UPDATE SKIP LOCKED` directly against `job_run` (Drizzle backend); BullMQ backend (when added) maps to BullMQ-native claim.
- Phase 1 ships **Drizzle backend only**. A BullMQ-orchestrator backend is Phase 6+ work, mapping `JobRun → BullMQ Job`, `parent_run_id → FlowProducer`, `concurrency_key → rate limiter`, etc. The mapping is honest: BullMQ backend exposes BullMQ-native features (Bull Board, FlowProducer) as extensions; Postgres backend exposes its own.
- Removed: `IJobQueue` protocol, `job_queue` schema, four `IJobQueue` backends (Drizzle/BullMQ/Redis/Memory), `JobsModule.forRoot({ backend })`. The existing `runtime/subsystems/jobs/` files for `IJobQueue` are deleted, not preserved.

### Codegen scope — generate the system, not user jobs

codegen-patterns ships the orchestration *system*: schemas, protocols, services, backends, modules, worker entrypoints, pool wiring, and Atlas migrations. **User jobs are ordinary TypeScript classes**, not YAML. Rejected alternatives and their reasons:

- **Jobs-as-YAML with generated handlers** was drafted and withdrawn. YAML can express trivial cron-shaped pipelines but cannot express branching, conditional spawn, dynamic agent tool loops, or anything where flow depends on runtime data. The declarative/imperative split added two user-facing concepts, a template DSL (`{{item.id}}`), desugaring rules, and a codegen phase, in exchange for eliminating ~15 lines of TypeScript boilerplate per job. It was not worth the surface area.
- **Generated `Jobs` facade** (typed kickoff per job type) was rejected on the same grounds — if users want a typed facade in their app, it is seven lines of TypeScript they write once.

What is codegen-owned:
- Drizzle schemas (Section *Schema*)
- Protocols: `IJobOrchestrator`, `IJobRunService`, `IJobStepService`
- Services: `JobService`, `JobRunService`, `JobStepService`, `JobEventLogger`, `JobWorker`
- Backends: Drizzle + Memory for each protocol
- NestJS modules: `JobsDomainModule.forRoot()`, `JobWorkerModule.forRoot()`
- Worker entrypoints: embedded `main.ts` hook + standalone `worker.ts`
- Base classes / types: `JobHandler<TInput, TOutput>`, `JobContext<TInput>`, `@JobHandler` decorator
- Pool config loader and queue binding
- Atlas migration emission for all tables

What users write:
- `@JobHandler('type', meta)` decorated classes, registered via NestJS module scan.
- Use cases that inject `IJobOrchestrator` and call `orchestrator.start('type', input, { scope })`.

### The triad

#### `Job`

Row-per-registered-type. Configuration lives here.

| Column | Type | Notes |
|---|---|---|
| `type` | `text` PK | Unique business key, e.g. `onboarding` |
| `version` | `integer` | Increments on breaking input changes |
| `pool` | `text` | One of the configured pools (Section *Pools*) |
| `scope_entity_type` | `text?` | Nullable if the job is global |
| `retry_policy` | `jsonb` | `{ attempts, backoff, base_ms, non_retryable_errors[] }` |
| `timeout_ms` | `integer?` | Run-level hard cap |
| `concurrency_key_template` | `text?` | e.g. `"account:{{input.account_id}}"` — evaluated in handler code, stored as the literal the codegen emits |
| `collision_mode` | `enum` | `queue \| reject \| replace`, default `queue` |
| `dedupe_key_template` | `text?` | Same evaluation as concurrency key |
| `dedupe_window_ms` | `integer?` | Window during which duplicate enqueues collapse |
| `priority_default` | `integer` | `0` unless overridden on enqueue |
| `replay_from` | `enum` | `scratch \| last_step \| last_checkpoint`, default `last_checkpoint` |
| `created_at`, `updated_at` | `timestamptz` | |

`Job` rows are populated at boot from decorator metadata — the worker module walks registered `@JobHandler` classes and upserts. This is not a user-editable table at runtime; it is the materialized view of what the app knows how to run.

#### `JobRun`

Row-per-execution. State lives here.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `job_type` | `text` FK → `job.type` | |
| `job_version` | `integer` | Captured at enqueue; a run continues on its original version even if `job.version` bumps |
| `parent_run_id` | `uuid?` FK → `job_run.id` | Direct parent |
| `root_run_id` | `uuid` | Self-reference if no parent, else the top of the tree |
| `parent_close_policy` | `enum` | `terminate \| cancel \| abandon`, default `terminate` |
| `scope_entity_type` | `text?` | Free text at DB, typed by generated `ScopeEntityType` union |
| `scope_entity_id` | `text?` | UUID or other primary key |
| `tenant_id` | `text?` | Opt-in column, present only when `codegen.config.yaml: jobs.multi_tenant: true` |
| `tags` | `jsonb` | Freeform key/value |
| `pool` | `text` | Resolved from `job.pool` at enqueue, cached here for claim query |
| `priority` | `integer` | |
| `concurrency_key` | `text?` | Evaluated from template at enqueue |
| `dedupe_key` | `text?` | Evaluated at enqueue; `(job_type, dedupe_key)` unique within `dedupe_window_ms` |
| `status` | `enum` | See *State machine* |
| `input` | `jsonb` | |
| `output` | `jsonb?` | Populated on completion |
| `error` | `jsonb?` | `{ message, stack, retryable, attempt }` |
| `trigger_source` | `enum` | `manual \| schedule \| event \| parent` |
| `trigger_ref` | `text?` | `event_id \| schedule_id \| null` |
| `run_at` | `timestamptz` | Earliest eligible tick time |
| `started_at`, `finished_at` | `timestamptz?` | |
| `claimed_at` | `timestamptz?` | For stale-claim recovery |
| `attempts` | `integer` | Run-level retry counter |
| `wait_kind` | `enum?` | See ADR-025; placeholder column added in Phase 1, semantics in Phase 3 |
| `resume_token` | `text?` | See ADR-025 |
| `wait_deadline` | `timestamptz?` | See ADR-025 |
| `created_at`, `updated_at` | `timestamptz` | |

**Indexes (Phase 1 required):**
- `(status, pool, run_at)` — claim query
- `(root_run_id)` — tree traversal
- `(scope_entity_type, scope_entity_id)` — "show everything for this account"
- `(job_type, dedupe_key)` partial `WHERE dedupe_key IS NOT NULL` — idempotency lookup
- `(concurrency_key)` partial `WHERE concurrency_key IS NOT NULL AND status IN ('pending','running')` — collision check

#### `JobStep`

Row-per-checkpoint within a run. Memoization and granular retry live here.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `job_run_id` | `uuid` FK → `job_run.id` | |
| `step_id` | `text` | User-chosen id, e.g. `'pull_emails'` or `'recompute:acct-123'`; unique per `(job_run_id, step_id)` |
| `kind` | `enum` | `task` for Phase 1; extended in ADR-027 to `tool_call \| llm_call \| wait \| checkpoint \| message` |
| `seq` | `bigint` | Monotonic within run |
| `status` | `enum` | `pending \| running \| completed \| failed \| skipped` |
| `input` | `jsonb?` | |
| `output` | `jsonb?` | Memoized return value on success |
| `error` | `jsonb?` | |
| `attempts` | `integer` | Step-level retry counter |
| `started_at`, `finished_at` | `timestamptz?` | |

**Indexes:**
- `(job_run_id, step_id)` unique
- `(job_run_id, seq)` for timeline queries

### State machine

```
                  ┌──────────┐
  enqueue  ───▶   │ pending  │
                  └────┬─────┘
                       │ claim
                       ▼
                  ┌──────────┐           signal / timer
                  │ running  │ ◀──────────────────────┐
                  └────┬─────┘                        │
         step ok? │    │  wait(kind)                  │
                  │    ▼                              │
                  │  ┌──────────┐                     │
                  │  │ waiting  │ ────────────────────┘
                  │  └────┬─────┘         resume
                  │       │  deadline
                  ▼       ▼
              completed  failed / timed_out

  any non-terminal ──cancel──▶ canceled
```

`scheduled` is a sub-state of `pending` where `run_at > now()`. Not a separate enum value; filter by `run_at` in the claim query.

`waiting` is present in the schema from Phase 1 but no `JobContext.waitFor()` API is exposed until Phase 3 (ADR-025). This avoids a breaking schema migration when signals land.

### Hierarchy and close policy

`parent_run_id` + `root_run_id` form the tree. `parent_close_policy` is inherited by the child at spawn time and stored on its row; later changes to the parent do not retroactively alter children.

Policy semantics (lifted from Temporal):
- `terminate` — when the parent reaches any terminal state, running children transition to `canceled` with `error.reason = 'parent_terminated'`. **Default.**
- `cancel` — same effect on children, but the parent waits for children to finish transitioning before it itself terminates. Useful when you want the parent's completion timestamp to reflect the actual end-of-work.
- `abandon` — children are untouched; they keep running and may outlive the parent. Useful for fire-and-forget side effects.

Root-level cancellation propagates through `root_run_id`: `JobRunService.cancel(runId, { cascade: true })` cancels the target and every descendant whose policy permits it.

### Scoping

`scope_entity_type` is the string name of an entity (`'account'`, `'opportunity'`, `'contact'`). Generated via entity-YAML opt-in:

```yaml
# entities/account.yaml
name: account
scopeable: true
```

At codegen, every `scopeable: true` entity contributes to the generated `ScopeEntityType` TypeScript union. DB column is `text` — no CHECK constraint — to keep Atlas migrations painless when new entities are marked scopeable. Type safety lives at the TS layer.

Query surface:
- `JobRunService.listForScope(scopeType, scopeId, opts?)` — all runs tied to a domain entity
- `JobRunService.cancelForScope(scopeType, scopeId)` — bulk cancel (cascades per close policy)
- `JobRunService.rescheduleForScope(scopeType, scopeId, newRunAt)` — shift a bundle

These are the "reorganize everything for this account" primitives from the problem statement.

### Policy

**Retry — two layers, orthogonal.**
- **Run-level** from `job.retry_policy`. If the whole run fails (handler throws uncaught, signal deadline missed, timeout), retry from the configured `replay_from` position.
- **Step-level** from the `ctx.step(id, fn, { attempts, backoff })` call site. Retries wrap a single step call without touching earlier completed steps. Step memoization (Section *Replay*) makes this free.

Both policies respect `non_retryable_errors` — an array of error class names or `.code` strings that short-circuit retries.

**Concurrency key and collision.** `concurrency_key` (evaluated from the template at enqueue) serializes runs sharing the key within the pool. On collision, one of three behaviors:
- `queue` (default) — the new run is accepted in `pending`, claimed only when the incumbent exits non-terminal states
- `reject` — the new enqueue fails with `JobCollisionError`; caller decides whether to retry
- `replace` — the incumbent is canceled (`cascade: true`), the new run starts. Useful for "latest state wins" agent loops and rolling batch windows

Choice is a property of the Job (`job.collision_mode`), not the call site.

**Dedupe key.** Independent of concurrency. `(job_type, dedupe_key)` is unique within `dedupe_window_ms`; a duplicate enqueue returns the existing run's id rather than creating a new row. Used when a use case might retry the same logical operation (e.g. webhook replay). Unlike concurrency, dedupe does not queue — it short-circuits.

**Priority.** Integer, higher wins, tie-broken by `run_at ASC`. Bounded to a configured range (default `[-100, 100]`) at enqueue time to prevent runaway escalation.

**Timeout.** `job.timeout_ms` is a hard wall-clock cap on total run duration across all retries. When breached, run transitions to `timed_out`. Step-level timeouts live on the `ctx.step()` call; breach fails just that step.

### Replay

`replay_from` is a memoization policy, not a separate code path. When a failed run is retried:
- `scratch` — `job_step` rows for this run are soft-deleted (moved to `job_step_archive`), handler re-enters with an empty step table
- `last_step` — only the failing step's row is cleared; earlier completed steps stay memoized; the handler re-enters and replays until it hits the empty step slot
- `last_checkpoint` (default) — no rows cleared; handler re-enters, every `ctx.step(id, fn)` checks for a `completed` row with matching `step_id` and returns `output` without calling `fn`

Three modes, one handler path. `JobContext.step()` is the only primitive that needs to know about memoization.

### Pools

Five framework-defined pools ship by default; users declare custom pools in `codegen.config.yaml`.

```yaml
# codegen.config.yaml (excerpt)
jobs:
  multi_tenant: false        # opt-in tenant_id column
  worker_mode: embedded      # embedded | standalone
  pools:
    events_inbound:
      queue: jobs-events-inbound
      concurrency: 20
      reserved: true
      description: "External → us. Webhooks, pub/sub, inbound email."
    events_change:
      queue: jobs-events-change
      concurrency: 30
      reserved: true
      description: "Internal mutations. Drives projections."
    events_outbound:
      queue: jobs-events-outbound
      concurrency: 10
      reserved: true
      description: "Us → external. Webhooks fired, publishes, notifications."
    interactive:
      queue: jobs-interactive
      concurrency: 20
      description: "User is waiting — renders, exports, one-off work."
    batch:
      queue: jobs-batch
      concurrency: 5
      description: "Background — onboarding, ingest, agent runs."
```

Rules:
- Each pool binds to a distinct BullMQ queue name. Workers are one-per-pool; a `batch` worker cannot starve an `interactive` worker because they consume different streams.
- `reserved: true` pools are framework-only. User `@JobHandler` decorations that target a reserved pool fail at build time (caught by a Nest module validator). Reserved pools exist to guarantee isolation for the `IEventBus` outbox drain (Section *Event lanes*); no user code enqueues to them.
- Default user-job pool is `batch`. A handler must opt into `interactive` explicitly; this prevents accidental fast-lane assignment for heavy work.
- `concurrency` is per-worker-process; horizontal scale multiplies it.

Adding a custom pool is a config-only change. Example: a Dealbrain app could declare a fourth user pool `agents` for long-running LLM jobs so they don't share concurrency with ingest.

### Event lanes (forward reference)

The three `events_*` pools exist to carry `IEventBus` outbox drain traffic, routed by `DomainEvent.direction` (`inbound | change | outbound`). Direction semantics and the event-codegen YAML model are specified in the events-planner design doc (`docs/specs/events-codegen-plan.md`) and will be formalized in a sibling ADR. This ADR commits only to: the three pools exist, they are reserved, the bus drains into them based on direction.

### Claim query (Drizzle backend)

ORM builder, single transaction, `FOR UPDATE SKIP LOCKED`:

```ts
async claimNext(pool: string): Promise<JobRunRow | null> {
  return this.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(and(
        eq(jobRuns.status, 'pending'),
        eq(jobRuns.pool, pool),
        lte(jobRuns.runAt, new Date()),
      ))
      .orderBy(desc(jobRuns.priority), asc(jobRuns.runAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return null;

    const [claimed] = await tx
      .update(jobRuns)
      .set({ status: 'running', claimedAt: new Date() })
      .where(eq(jobRuns.id, candidate.id))
      .returning();

    return claimed;
  });
}
```

BullMQ backend delegates to BullMQ's native atomic claim — nothing custom. Memory backend uses a single in-process mutex.

### Handler API

```ts
import { JobHandler, JobContext, ParentClosePolicy } from '@pattern-stack/codegen/jobs';

interface OnboardingInput {
  accountId: string;
}

@JobHandler<OnboardingInput>('onboarding', {
  pool: 'batch',
  scope: { entity: 'account', from: (input) => input.accountId },
  retry: { attempts: 3, backoff: 'exponential', baseMs: 1000 },
  concurrency: { key: (input) => `account:${input.accountId}`, collision: 'queue' },
  dedupe: { key: (input) => `onboarding:${input.accountId}`, windowMs: 24 * 60 * 60 * 1000 },
  timeoutMs: 60 * 60 * 1000,
  replayFrom: 'last_checkpoint',
})
export class OnboardingHandler extends JobHandlerBase<OnboardingInput> {
  constructor(
    private readonly emails: EmailService,
    private readonly facts: FactService,
  ) { super(); }

  async run(ctx: JobContext<OnboardingInput>) {
    const emails = await ctx.step('pull_emails', () =>
      this.emails.pullForAccount(ctx.input.accountId),
    );

    await ctx.spawnChild('process_facts', {
      emailIds: emails.map(e => e.id),
    }, {
      closePolicy: ParentClosePolicy.Terminate,
    });

    return { emailCount: emails.length };
  }
}
```

Decorator metadata is read at boot by `JobWorkerModule` to populate the `Job` table and the in-memory handler registry. TypeScript generics on `@JobHandler<TInput>` flow through to `JobContext<TInput>` so `ctx.input` is typed without casts.

`JobContext` API for Phase 1:
- `ctx.input: TInput`
- `ctx.run: JobRun` — metadata about this run (id, scope, parent, etc.)
- `ctx.step(id, fn, opts?)` — memoized durable step
- `ctx.spawnChild(type, input, opts)` — spawn child JobRun
- `ctx.logger: Logger` — scoped to this run

`ctx.waitFor()`, `ctx.signal()`, `ctx.sleep()` arrive in ADR-025.

### Worker lifecycle

Two entrypoints, both emitted from Phase 1:

- **Embedded** (default) — `JobWorkerModule.forRoot({ mode: 'embedded' })` imported by `AppModule`. API process and workers share CPU. Lowest ceremony; good for dev and small deployments.
- **Standalone** — a separate `worker.ts` entrypoint boots a stripped NestJS context with only the worker module, no HTTP bindings. Scale workers independently; API CPU spikes cannot stall jobs and vice versa. Switch is a `codegen.config.yaml: jobs.worker_mode: 'standalone'` flip plus deploying the second binary.

Codegen emits both `main.ts` and `worker.ts` on scaffold. A consumer who never deploys standalone simply never runs `worker.ts`; the file is inert.

Graceful shutdown: on `SIGTERM`, workers stop claiming new ticks, wait for in-flight step functions to resolve (bounded by a configurable `shutdown_timeout_ms`, default `30000`), then exit. In-flight JobRuns transition back to `pending` with `claimed_at: null` for another worker to pick up.

### Registration — static codegen, runtime discovery deferred

The `@JobHandler` decorator registers a class into a module-local map at class-evaluation time. `JobWorkerModule.forRoot()` reads the map at boot. This is a code-level registry — adding a new handler requires importing it somewhere reachable from the app's module tree (standard NestJS practice).

Runtime-discovery mode (`JobWorkerModule.forRoot({ discovery: 'runtime' })` that scans the DI container for decorated providers) is tracked as **Phase 6+ enhancement**. Concern: a handler that is defined but never imported will be silently invisible. A boot-time validator (shipped Phase 1) checks that every `Job` row's `type` has a registered handler and fails loudly on mismatch — that catches ~90% of drift without the complexity of container scanning.

### Multi-tenancy

Opt-in via `codegen.config.yaml: jobs.multi_tenant: true`. When enabled:
- `tenant_id` column appears on `job_run` and `job_event`
- Every service method accepts a `tenantId` and filters all queries by it
- Worker-side, tenant-based fair queuing is Phase 6 polish; initial implementation is FIFO within a pool

When disabled: column is omitted, methods have no `tenantId` parameter, generated code is simpler.

### Atlas migration workflow

All job-related schemas are emitted as Drizzle `pgTable` declarations. Atlas consumes the Drizzle schema via the existing Atlas + Drizzle integration (see consumer-setup doc addendum — to be written in Phase 1). Consumers run `atlas migrate diff` to generate migrations, `atlas migrate apply` to apply. codegen-patterns ships the schema; it does not ship raw SQL migrations.

This supersedes the older `drizzle-kit push` recommendation in `docs/CONSUMER-SETUP.md` — that section will be updated to reflect the Atlas workflow as part of Phase 1.

## Phase roadmap

Implementation is sequenced in six phases. Each phase is an independently reviewable PR.

### Phase 1 — Domain foundation
Layers 1–4 of the synthesis: triad, hierarchy, scoping, policy. Schema, protocols, services, backends (Drizzle + Memory), module, worker entrypoints (both), pool wiring, `@JobHandler` decorator, boot-time registry validator, Atlas integration docs. Ships the state machine including `waiting` as a column (behavior deferred to ADR-025).

### Phase 2 — Event-to-Job Bridge (ADR-023)
`IJobBridge`, `job_trigger` and `bridge_delivery` tables, cron scheduler loop, event-bus subscriber that matches triggers and enqueues runs. Depends on events-planner's events-codegen work (for typed event references in trigger rules).

### Phase 3 — Coordination (ADR-025)
`ctx.waitFor()`, `ctx.signal()`, `ctx.sleep()`. Timer-based auto-resume via scheduler loop. Webhook endpoint for external `resume_token` resolution. No schema change — columns added in Phase 1.

### Phase 4 — Observability (ADR-026)
`job_event` audit table, `JobEventLogger` service, selective `IEventBus` broadcast rules, query APIs for timeline and recent-failures views.

### Phase 5 — Agent extensions (ADR-027)
`JobStep.kind` extended with `tool_call | llm_call | wait | checkpoint | message`. Cost JSONB. Thread binding on `JobRun`. Helper methods `ctx.recordToolCall()`, `ctx.recordLLMCall()`.

### Phase 6 — Polish
Optional `job_artifact` table for oversized outputs. Admin CLI (`bun codegen jobs runs <id>`, `jobs cancel <id>`, `jobs replay <id>`). Runtime-discovery registry option. Tenant-aware fair queuing.

## Open implementation questions (non-blocking)

These are caught here so they are not lost; they do not block Phase 1.

1. **Stale-claim recovery.** If a worker crashes mid-tick, its `claimed_at` row is stranded. Propose: a janitor process per pool scans `status='running' AND claimed_at < now() - stale_threshold` and returns rows to `pending`. Phase 1 ships a simple time-based sweeper (default `5 min`); richer heartbeats can follow.
2. **BullMQ queue naming collisions.** If two codegen-based apps share a Redis, pool queue names (`jobs-batch`, etc.) collide. Recommend a configurable prefix (`jobs.queue_prefix` in config, default app name).
3. **Run output size.** JSONB is fine for small outputs; large outputs (LLM responses, report data) should go to `job_artifact` (Phase 6). Soft-limit warning in Phase 1 when output exceeds `100 KB`.
4. **Signal auth.** External signal endpoint (`POST /jobs/signals/:resume_token`) needs an auth model. Propose opaque single-use token with rotation; detail in ADR-025.
5. **Cross-pool priorities.** A high-priority `batch` run should still never preempt an `interactive` run — pools are absolute lanes. Document this invariant; consumers who want preemption need to add a dedicated pool.

## Consequences

**Positive:**
- Jobs become first-class domain entities: queryable by scope, reorganizable by entity, cancelable as trees.
- Lane isolation at the pool layer prevents the Dealbrain bleed where outbound webhooks stalled change events.
- The `@JobHandler` + `JobContext` pair is a small, stable API surface. No YAML parser, no template DSL, no desugaring.
- Replay, retry, dedupe, and concurrency are declarative properties — ops can tune them without code changes (retry policy overrides can live in config; structural properties stay on the class).
- Forward-compatible with signals (Phase 3) and agent steps (Phase 5) — the schema reserves space without committing to semantics.

**Negative:**
- The `job_queue` table (executor-layer, used by `IJobQueue`) and the new `job_run`/`job_step` tables (orchestration-layer) live side-by-side. Two "job" concepts in the schema. Mitigated by naming: `job_queue` is the executor's queue (transient ticks); `job_run` is the domain's durable execution. Documentation must make this distinction clear. Whether `IJobQueue` itself should be retired in favor of a fused single-layer design is a separate question (the two-layer split has architectural merit beyond compat — clean swap to BullMQ/Redis backends — but is worth re-examining).
- `@JobHandler` decorator metadata is the source of truth for `Job` rows. A handler class deleted from source but left registered in Postgres will produce dangling `Job` rows. Phase 1 validator warns; Phase 6 admin CLI adds a prune command.

**Operating principle (project-wide, codified in CLAUDE.md):** No backwards-compatibility constraints until external users exist. Architectural correctness is the only criterion. No upgrade commands, no deprecated callouts, no parallel old-and-new schemas to preserve in-flight snapshots.

**Deferred by this ADR (explicit):**
- Signal / wait / resume semantics → ADR-025
- JobEvent audit log + selective broadcast → ADR-026
- Agent step kinds, cost, thread binding → ADR-027
- Event-to-Job Bridge → ADR-023
- Events codegen (YAML, typed `IEventBus`, direction routing) → cross-ADR with events-planner

## Alternatives considered

1. **Extend `IJobQueue` in-place.** Add `parent_id`, `scope`, `status enum` columns to `job_queue`. Rejected: conflates executor and domain concerns, blocks backend swap (Memory/Redis backends don't have schema control), and makes the existing narrow protocol a maintenance burden.

2. **Airflow-style static DAG.** Jobs are fully declarative graphs of tasks. Rejected: cannot express dynamic spawn (agent tool loops, conditional onboarding branches), which is a Phase 5 requirement and a Phase 1 onboarding story.

3. **Single global queue with application-level priorities.** Reject because priority is a weaker isolation guarantee than separate lanes — a priority-based scheduler can still starve low-priority work under load; lanes cannot.

4. **Jobs as generated YAML** with a full template DSL. Prototyped in-discussion and withdrawn (see *Codegen scope* above).

5. **Temporal as the backend.** Rejected for this iteration: operational cost, Node SDK maturity concerns for long-lived agent workflows, and the strategic goal of keeping codegen-patterns self-contained (Postgres + optional Redis). A Temporal-backed `IJobOrchestrator` backend remains a future option.

## References

- ADR-008 (Subsystem Architecture) — Protocol → Backend → Factory pattern
- ADR-005 (Entity Family Base Classes) — `scopeable: true` entity flag lives next to family declarations
- `docs/specs/job-orchestration-research.md` — synthesis of Airflow, Dagster, Temporal, Prefect, Step Functions, Inngest, LangGraph, OpenAI Assistants, CrewAI
- `docs/specs/events-codegen-plan.md` — parallel design for typed events and direction routing
- `runtime/subsystems/jobs/` — legacy `IJobQueue` scaffold (deleted by this ADR's Phase 1 work; see JOB-1 file deletion list)
