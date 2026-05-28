---
name: jobs
description: Load when authoring a `@JobHandler` class, kicking off a background job from a use case, or configuring job pools in a project that ran `codegen subsystem install jobs`. Triggers include `@JobHandler`, `JobContext`, `ctx.step` / `ctx.spawnChild`, injecting `JOB_ORCHESTRATOR` / `JOB_RUN_SERVICE`, registering `JobsDomainModule` / `JobWorkerModule`, and editing the `jobs:` block in `codegen.config.yaml`.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Jobs

The jobs subsystem is the durable background-work engine vendored into your app by `codegen subsystem install jobs`. It gives you a way to run work asynchronously, retry it, scope it to a domain entity, cancel it as a tree, and resume it after a crash without redoing finished steps. You author jobs as plain TypeScript classes decorated with `@JobHandler`; the runtime handles claiming, retry, memoization, and lifecycle.

The vendored code lives under `<paths.subsystems>/jobs/` (default `src/shared/subsystems/jobs/`) and is imported as `@shared/subsystems/jobs`. Do not hand-edit it — it is managed by the package.

## Mental model

A job is **stateful work**. Each execution is a row in the `job_run` table — a durable state machine you can query, cancel, and replay. This is the sharp line versus events: an *event* is an immutable fact ("contact was created"); a *job* is the work that reacts to it. If you catch yourself wanting `status`, `attempts`, or a retry policy on something, you want a job. See the sibling `events` skill for that distinction.

Three tables back the system, one concept each:

| Table | Meaning |
|---|---|
| `job` | One row per registered handler type. Materialized from your `@JobHandler` metadata at app boot. |
| `job_run` | One row per execution. The durable state machine: queryable by scope, cancellable as a tree. |
| `job_step` | One row per checkpoint inside a run. Powers memoization (skip already-done work on retry). |

There is **one** claim mechanism: a worker polls `job_run` directly with `SELECT ... FOR UPDATE SKIP LOCKED`. There is no separate queue table and no separate "enqueue" port. You start work with `IJobOrchestrator.start(...)`; the worker discovers the row on its next poll.

Run hierarchy: a child run carries `parent_run_id` and `root_run_id`. Cancelling a run cascades to its tree via `root_run_id` according to each child's close policy.

### State machine

```
pending → running → { completed | failed | timed_out | canceled }
```

"Scheduled for later" is not a separate state — it is `status='pending'` with `run_at` in the future; the claim query simply skips it until `run_at` passes.

## Routing table

| For this task | Read |
|---|---|
| Writing a `@JobHandler`, using `JobContext`, `ctx.step`, spawning children, scope, plugging into a use case | `handler-authoring.md` |
| Choosing/configuring pools, concurrency, ordering guarantees, the `jobs:` config block, embedded vs. standalone workers | `pools-and-ordering.md` |

For running a job *in response to a domain event*, that is the Event-to-Job Bridge — see the `bridge` skill. You declare triggers on the same `@JobHandler` decorator; this skill covers everything else about the handler.

## Non-obvious rules

- **Jobs are TypeScript classes, not YAML.** There is no jobs-as-YAML codegen. You write a `@JobHandler` class; the package ships the orchestration around it.
- **A `@JobHandler` class must also be a registered NestJS provider.** The decorator registers the class with the job registry for orchestration; it does NOT register it in Nest's DI container. Add it to the `providers` of its owning module, or the worker throws an unresolvable-provider error when it tries to run it.
- **`step_id` must be stable across replays.** Hardcode it (`'pull_emails'`) or derive it deterministically from input. Never `Date.now()`, never random. Memoization is keyed on `(job_run_id, step_id)`; an unstable id defeats it.
- **The default pool is `batch`.** `interactive` exists but must be opted into explicitly.
- **The `events_inbound` / `events_change` / `events_outbound` pools are reserved.** A `@JobHandler({ pool: 'events_*' })` throws `ReservedPoolViolationError` at app boot. Those lanes belong to the event/bridge machinery. To run a job when an event fires, use `@JobHandler.triggers` (the `bridge` skill), not a reserved pool.
- **Concurrency and dedupe are different things.** Dedupe collapses duplicate enqueues (returns the existing run id, no new row). Concurrency lets the new row exist but gates when it is claimed. Both are set once on the decorator, not per call site.
- **`ctx.waitFor` / `ctx.signal` / `ctx.sleep` do not exist.** If you need a delay, use `ctx.spawnChild(type, input, { runAt })`. If you need to pause for external input, split the work across parent + child runs.

## Do not

- Do not look for an `IJobQueue` or a `job_queue` table — they do not exist. Start work with `IJobOrchestrator.start(type, input, opts)`.
- Do not target a reserved `events_*` pool from a `@JobHandler`. It fails at boot.
- Do not use `Date.now()` or randomness for a `step_id`.
- Do not wrap `ctx.spawnChild` inside a `ctx.step` — a child run is its own memoization root.
- Do not hand-edit anything under `<paths.subsystems>/jobs/`. It is vendored from the package.
- Do not reach for a job when the caller is waiting synchronously on the result — that is a use case, not a job. Jobs are durable because they are asynchronous.
