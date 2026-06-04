# Pools and Configuration

How pools work, what lives in `codegen.config.yaml: jobs.*`, how the core/extension surface maps to backend-specific features, and how to add a new pool. Touch this file when you're editing the config schema, the pool loader, or the framework defaults.

Source of truth: `docs/specs/JOB-5.md` (module + pool loader), `docs/specs/JOB-6.md` (scaffold template that emits the config block), ADR-022 §"Pools" and §"Event lanes".

## What a pool is

A pool is a logical lane. Each pool maps to:
- A distinct `queue` identifier (written into `job_run.pool`).
- One `JobWorker` instance per active pool per process.
- A `concurrency` cap — max in-flight runs per worker process.

**Pools are absolute lanes.** A high-priority `batch` run does not preempt `interactive`. If you want preemption, make a dedicated pool. This invariant exists because priority is a weaker isolation guarantee than separate claim queues — priority-based schedulers can starve; lane-based schedulers cannot.

## Framework defaults (five pools)

From `pool-config.loader.ts` (JOB-5 §1):

| Pool | queue | concurrency | reserved | Purpose |
|---|---|---|---|---|
| `events_inbound` | `jobs-events-inbound` | 20 | **yes** | External → us. Webhook receivers, pub/sub consumers, inbound email ingest. |
| `events_change` | `jobs-events-change` | 30 | **yes** | Internal domain mutations → projections. Drives downstream materialisation. |
| `events_outbound` | `jobs-events-outbound` | 10 | **yes** | Us → external. Outbound webhooks, notifications, publishes. |
| `interactive` | `jobs-interactive` | 20 | no | User is waiting. Exports, renders, ad-hoc one-off work. |
| `batch` | `jobs-batch` | 5 | no | Background. Onboarding, batch ingest, agent runs. **Default for user `@JobHandler`s.** |

Concurrency values ship as defaults; consumers may override non-reserved pools' `concurrency` (and `description`) in config.

## Reserved pools are off-limits to user handlers

The three `events_*` pools exist to carry the `IEventBus` outbox drain, routed by `DomainEvent.direction` (`inbound | change | outbound`). They are `reserved: true`. User code targeting them must fail loudly at module init:

- A `@JobHandler({ pool: 'events_change' })` triggers `ReservedPoolViolationError` during `JobWorkerModule.onModuleInit`. Error lists the offending class names.
- The loader silently preserves `reserved: true` on framework pools even if the user tries to flip it in config.
- User-defined pools cannot set `reserved: true` — reserved is framework-only.

If a user task genuinely needs to participate in the event stream, it goes through the `IEventBus` + Phase 2 bridge (ADR-023), not directly as a handler on `events_*`. See `../events/SKILL.md`.

## The `jobs:` config block

Emitted by `just gen-subsystem jobs` (JOB-6's `codegen-config-jobs-block.ejs.t`). Canonical shape:

```yaml
jobs:
  # ── Backend selection (core/extension model — see CLAUDE.md) ──
  backend: drizzle

  # ── Backend-specific extensions (typed per backend) ──
  extensions:
    drizzle:
      # listen_notify: true          # LISTEN-NOTIFY-1: Postgres LISTEN/NOTIFY wakes the worker on enqueue-commit, alongside polling. Off by default; needs a direct (non-transaction-pooler) connection.
      poll_interval_ms: 1000
    # bullmq:                        # Reserved slot — backend not yet implemented
    #   bull_board:
    #     enabled: true
    #     mount_path: /admin/queues
    #   redis_url: redis://...

  # ── Multi-tenancy (JOB-8) ──
  multi_tenant: false                # true → service layer enforces tenantId

  # ── Worker topology ──
  worker_mode: embedded              # embedded | standalone

  # ── Pools ──
  pools:
    events_inbound:
      queue: jobs-events-inbound
      concurrency: 20
      reserved: true
    events_change:
      queue: jobs-events-change
      concurrency: 30
      reserved: true
    events_outbound:
      queue: jobs-events-outbound
      concurrency: 10
      reserved: true
    interactive:
      queue: jobs-interactive
      concurrency: 20
    batch:
      queue: jobs-batch
      concurrency: 5
```

Field semantics:

| Key | Who reads it | Notes |
|---|---|---|
| `backend` | `JobsDomainModule.forRoot` | `'drizzle'` or `'memory'`. BullMQ is a reserved slot only. |
| `extensions.<backend>.*` | Backend class during init | Each backend reads only its own key. Unknown keys for the active backend warn, don't error (core/extension principle — swap is non-destructive). |
| `multi_tenant` | `JobsDomainModule.forRoot` | Threads `JOBS_MULTI_TENANT` token through. Default `false`. When `true`, service methods require `tenantId` (see JOB-8). |
| `worker_mode` | Informational + scaffold hint | `embedded` means `JobWorkerModule` imported by `AppModule`; `standalone` means run `worker.ts` separately. Switching does not change generated code — both entrypoints are always emitted. |
| `pools.<name>.queue` | `JobWorker` | Identifier written into `job_run.pool`. Must be unique across pools. |
| `pools.<name>.concurrency` | `JobWorker` | Per-process max in-flight. Horizontal scale multiplies. |
| `pools.<name>.reserved` | `PoolConfigLoader` | Framework-only. User configs cannot enable. Framework pools cannot have it disabled. |

## Core contract vs. extensions — the rule

From CLAUDE.md:
- **Core contract** — every backend MUST implement. App code written against `IJobOrchestrator` + `IJobRunService` + `IJobStepService` is portable across backends.
- **Extensions** — optional, backend-specific. Live under `extensions.<backend>`.

When adding a feature, ask: "Is this something every future backend can reasonably implement?"
- Yes → put it on the core protocol (edit `job-orchestrator.protocol.ts`, thread through all backends).
- No → it's an extension. Add it to `JobsDomainModuleOptions.extensions.<backend>`, wire only the matching backend, document that consumers opting in accept non-portable code paths.

Examples of extension-shaped features (NOT core):
- **Bull Board** (BullMQ-only admin UI) → `extensions.bullmq.bullBoard`. Phase 6+.
- **`LISTEN/NOTIFY` wake-up** (Postgres-only) → `extensions.drizzle.listenNotify`. Drizzle only.
- **Native rate limiters** (BullMQ queue options) → extensions.

Examples of core-shaped features (NOT extensions):
- Retry, dedupe, concurrency collision, cascade cancel, step memoization, scope queries. These are modeled on the domain side and therefore backend-agnostic.

## Adding a custom pool

Pure config change. To add an `agents` pool for long-running LLM work:

```yaml
jobs:
  pools:
    # … framework defaults preserved automatically …
    agents:
      queue: jobs-agents
      concurrency: 3
      description: "Long-running LLM/agent work"
```

Then any `@JobHandler({ pool: 'agents', … })` targets it. No code changes required. `JobWorkerModule` discovers the pool at boot, spins up a `JobWorker(pool='agents')`, starts its claim loop.

If you want to restrict which pools a process services (useful for heterogeneous deploys), pass `opts.pools`:

```ts
JobWorkerModule.forRoot({ mode: 'standalone', pools: ['batch', 'agents'] })
```

Pools omitted from the list are not claimed by this process.

## Pool config loader rules (JOB-5 §1)

- Reads `${process.cwd()}/codegen.config.yaml` (or `configPath` argument in tests).
- Always merges `FRAMEWORK_POOLS` first, then user-defined pools.
- Users may override `concurrency` and `description` on non-reserved defaults.
- Users cannot set `reserved: true` on their own pools.
- Users cannot flip `reserved: true` → `false` on framework pools.
- Cached in module scope after first call.

## `JobsDomainModule.forRoot` — options shape

From JOB-5 §3:

```ts
interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory';
  extensions?: {
    drizzle?: {
      listenNotify?: boolean;
      pollIntervalMs?: number;
    };
    // bullmq?: ...  // Phase 6+
  };
  multiTenant?: boolean;
}
```

Module is `global: true`, provides `JOB_ORCHESTRATOR`, `JOB_RUN_SERVICE`, `JOB_STEP_SERVICE`, and (JOB-8) `JOBS_MULTI_TENANT`.

`JobWorkerModule.forRoot` separately takes `{ mode, backend?, pools?, shutdownTimeoutMs? }` and imports `JobsDomainModule` internally. A process can import `JobsDomainModule` alone (read-only — services available, no worker running) or `JobWorkerModule` (which brings the domain module with it plus the claim loop).

## Worker topology — embedded vs. standalone

Both entrypoints are always scaffolded by JOB-6. The choice is operational.

**Embedded** (`AppModule` imports `JobWorkerModule.forRoot({ mode: 'embedded' })`):
- API process and workers share CPU.
- Simplest deploy; good default for dev and small installs.
- `jobs.worker_mode: embedded` in config is informational / hint.

**Standalone** (run `worker.ts` as a separate process):
- `main.ts` does not import `JobWorkerModule`.
- `worker.ts` boots a bare NestJS application context (no HTTP listener) with only `DatabaseModule` + `JobsDomainModule.forRoot(...)` + `JobWorkerModule.forRoot({ mode: 'standalone' })`.
- Scale workers independently from the API; CPU spikes on one side don't stall the other.

Switching is an operational change plus the config `worker_mode` toggle. **No regeneration needed — both files ship regardless.**

## Multi-tenancy surface

`jobs.multi_tenant: true` is a single opt-in. Consequences (JOB-8):

- `JOBS_MULTI_TENANT` token resolves to `true`.
- All backend methods accept `tenantId` in their options types.
- When enabled: missing `tenantId` throws `MissingTenantIdError`. Explicit `null` is allowed (cross-tenant background work).
- Queries (claim, `listForScope`, `cancel`, etc.) filter by `tenantId` when enabled.
- `tenant_id` column exists on `job_run` regardless of the flag — JOB-1 lands it unconditionally so flipping the flag later doesn't require a migration.

Tenant-aware fair queuing is Phase 6 polish; Phase 1 is FIFO within pool.

## Horizontal scale notes

- **Handler upsert** under concurrent boots uses `ON CONFLICT (type) DO UPDATE SET … , updated_at = now()` (JOB-3 OQ-3). Last-writer-wins is safe because all instances of the same binary produce identical metadata.
- **Stale sweeper** is per-worker; each `UPDATE ... WHERE claimed_at < threshold` is self-protecting. No leader election. See `orchestrator-and-worker.md` §"Stale-claim sweeper".
- **BullMQ queue naming** (once BullMQ backend lands): if two apps share a Redis, default queue names collide. A `jobs.queue_prefix` knob is noted in ADR-022 §"Open implementation questions" as a future addition. Not in Phase 1.

## Events-lane cross-reference

The three `events_*` pools exist because of the events subsystem, not the jobs subsystem. Their concurrency values are tuned to event traffic:

- `events_change: 30` — highest because projections fan out per mutation.
- `events_inbound: 20` — external ingress, often bursty.
- `events_outbound: 10` — lower to avoid overwhelming downstream receivers; also leaves headroom for retry storms.

Event semantics and direction routing live in `../events/SKILL.md` (and the events subsystem code). This file owns only the pool side of the contract.
