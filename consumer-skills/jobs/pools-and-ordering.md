<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Pools, Ordering, and Configuration

How pools work, how to configure them in `codegen.config.yaml`, how to get the ordering guarantee you actually need, and how to wire the job worker into your app. Read this when you are choosing a pool for a handler, adding a custom pool, or deciding between embedded and standalone workers.

## What a pool is

A pool is a logical lane. Each pool maps to:
- A distinct queue identifier (written into `job_run.pool`).
- One worker instance per active pool per process.
- A `concurrency` cap — the max number of in-flight runs that pool processes at once.

**Pools are absolute lanes — there is no cross-pool preemption.** A high-priority `batch` run does not jump ahead of `interactive`. If you need isolation between two classes of work, give them separate pools. This is deliberate: priority-based scheduling within one queue can starve low-priority work under sustained load; separate lanes cannot.

## The default pools

Your installed `jobs:` config ships five pools:

| Pool | concurrency | reserved | Use for |
|---|---|---|---|
| `events_inbound` | 20 | yes | (framework) external → us event traffic |
| `events_change` | 30 | yes | (framework) internal change-event traffic |
| `events_outbound` | 10 | yes | (framework) us → external event traffic |
| `interactive` | 20 | no | User-waiting work: exports, renders, ad-hoc one-offs |
| `batch` | 5 | no | Background work: onboarding, ingest, long jobs. **Default for your handlers.** |

You may override `concurrency` (and `description`) on the non-reserved pools, and you may add your own.

### Reserved pools are off-limits to your handlers

The three `events_*` pools exist only to carry event/bridge traffic, one lane per event direction. A `@JobHandler({ pool: 'events_change' })` (or any reserved pool) throws `ReservedPoolViolationError` at app boot — the error names the offending class. You cannot flip `reserved` off in config, and you cannot mark your own pools `reserved`.

To run a job *when an event fires*, declare `@JobHandler.triggers` and let the bridge enqueue it into your chosen (non-reserved) pool. See the `bridge` skill.

## The `jobs:` config block

`codegen subsystem install jobs` injects this into `codegen.config.yaml`:

```yaml
jobs:
  backend: drizzle                 # 'drizzle' (default, Postgres) | 'memory' (tests) | 'bullmq' (opt-in)

  extensions:
    drizzle:
      poll_interval_ms: 1000
      # listen_notify: true        # opt-in Postgres LISTEN/NOTIFY for sub-second wakeups

  multi_tenant: false              # true → service layer requires a tenantId

  worker_mode: embedded            # embedded | standalone (operational hint; see below)

  pools:
    events_inbound:  { queue: jobs-events-inbound,  concurrency: 20, reserved: true }
    events_change:   { queue: jobs-events-change,   concurrency: 30, reserved: true }
    events_outbound: { queue: jobs-events-outbound, concurrency: 10, reserved: true }
    interactive:     { queue: jobs-interactive,     concurrency: 20 }
    batch:           { queue: jobs-batch,           concurrency: 5 }
```

Field notes:

| Key | What it controls |
|---|---|
| `backend` | Which orchestrator implementation runs. `drizzle` (Postgres) is the portable default. `memory` is for tests. `bullmq` is opt-in (see below). |
| `extensions.<backend>.*` | Backend-specific knobs. Each backend reads only its own key; unknown keys are ignored, not errors. |
| `multi_tenant` | When `true`, service methods require a `tenantId` (explicit `null` allowed for cross-tenant work). The `tenant_id` column exists regardless, so flipping this later needs no migration. |
| `worker_mode` | Informational hint only — both worker entrypoints are always scaffolded. See "Worker topology". |
| `pools.<name>.queue` | The queue identifier written into `job_run.pool`. Must be unique. |
| `pools.<name>.concurrency` | Per-process max in-flight for that pool. Running more processes multiplies it. |

## Adding a custom pool

Pure config change — no code edits:

```yaml
jobs:
  pools:
    # framework defaults are merged automatically; you only add yours
    agents:
      queue: jobs-agents
      concurrency: 3
      description: "Long-running LLM / agent work"
```

Then any `@JobHandler({ pool: 'agents', … })` targets it. The worker discovers the pool at boot and starts its claim loop.

## Ordering: parallelism vs. order

By default a pool runs at its configured concurrency, so two runs in the same pool can execute concurrently. There is **no implicit ordering guarantee**. If you genuinely need ordered execution, choose the narrowest knob that satisfies the requirement:

1. **Per-entity ordering (preferred).** Set `concurrency` on the `@JobHandler` with a key derived from the entity and `collisionMode: 'queue'`:

   ```ts
   @JobHandler<ProvisionInput>('provision_workspace', {
     concurrency: {
       key: (input) => `account:${input.accountId}`,
       collisionMode: 'queue',
     },
   })
   ```

   This serializes runs sharing the same key while keeping unrelated keys parallel. Keeps throughput high.

2. **Whole-pool serialization (blunt).** Set `concurrency: 1` on the pool in config. Serializes *every* run in that pool end to end. Use only when every run in the pool genuinely needs strict order — it caps throughput hard.

If you think you need strict ordering *across different entities*, reconsider — that is usually a sign the work should tolerate independent timelines.

## Worker topology — embedded vs. standalone

Both entrypoints are always scaffolded. The choice is operational; switching needs no regeneration.

**Embedded** — your `AppModule` imports `JobWorkerModule.forRoot({ mode: 'embedded' })`. The API process and the workers share the same process. Simplest; good default for dev and small deployments.

**Standalone** — run the scaffolded `worker.ts` as its own process. `main.ts` does not import `JobWorkerModule`; the worker boots a bare Nest application context (no HTTP listener) with the database module plus the jobs modules. Lets you scale workers independently of the API.

## Wiring into your app

Two modules, both `global: true`:

```ts
import { JobWorkerModule } from '@shared/subsystems/jobs';

@Module({
  imports: [
    DatabaseModule,
    // Brings the orchestrator/services AND runs the worker claim loops:
    JobWorkerModule.forRoot({ mode: 'embedded', backend: 'drizzle' }),
    // ...
  ],
})
export class AppModule {}
```

`JobWorkerModule.forRoot({ mode, backend?, pools?, multiTenant?, shutdownTimeoutMs? })` imports `JobsDomainModule` internally and starts a worker per active pool. The protocol tokens (`JOB_ORCHESTRATOR`, `JOB_RUN_SERVICE`, `JOB_STEP_SERVICE`) become available project-wide.

- Pass `pools: ['batch', 'agents']` to restrict which pools *this* process services — useful for heterogeneous standalone deploys. Pools omitted from the list are not claimed by this process.
- A process that only needs to *start* jobs (not run them) can import `JobsDomainModule.forRoot({ backend })` alone — services available, no worker loop.

Tests swap the backend:

```ts
JobWorkerModule.forRoot({ mode: 'embedded', backend: 'memory' })
```

## Backend choice

The portability contract is the same across backends: code written against `IJobOrchestrator` + `IJobRunService` + `IJobStepService` works on any backend. Backend-specific features live under `extensions.<backend>`.

- **`drizzle`** (default) — Postgres only, no extra infra. The worker polls `job_run`. Extensions: `poll_interval_ms`, opt-in `listen_notify`.
- **`memory`** — in-process, for tests. Behavior-parity with Drizzle for the scenarios that matter.
- **`bullmq`** — opt-in via `backend: bullmq`. Postgres `job_run` stays the domain source of truth; BullMQ replaces only the claim/dispatch half. Extensions include a Bull Board admin UI mount and `FlowProducer` access. Choose this only after you have a measured reason to.

## Multi-tenancy

`jobs.multi_tenant: true` is a single opt-in:
- Backend methods accept a `tenantId`; a missing one throws when the flag is on (explicit `null` allowed for cross-tenant background work).
- Claim, `listForScope`, `cancel`, etc. filter by `tenantId`.
- The `tenant_id` column is always present, so flipping the flag never needs a migration.

Also pass `multiTenant: true` to `JobWorkerModule.forRoot(...)` so the runtime enforces it, and keep the config flag and the module option in agreement.
