# Phase Roadmap

What's shipping in Phase 1, what's deferred, and what you must NOT build yet. Read this when a requirement sounds like it belongs to the jobs subsystem but isn't covered by `JOB-1..JOB-8` — it's probably Phase 2+ and the answer is "defer, or use the escape hatch listed below."

Source of truth: `docs/adrs/ADR-022-job-orchestration-domain-model.md` §"Phase roadmap", plus the ADR-022 siblings listed there (ADR-023 / 025 / 026 / 027).

## Phase 1 — Domain foundation (the current scope)

Delivered by `JOB-1` through `JOB-8`:

- Drizzle schemas: `job`, `job_run`, `job_step` (all indexes, all enums, Phase 3 placeholder columns in place).
- Protocols: `IJobOrchestrator`, `IJobRunService`, `IJobStepService`.
- Backends: Drizzle (production) + Memory (tests).
- Base types: `JobHandlerBase`, `JobContext`, `@JobHandler`, `ParentClosePolicy`.
- NestJS modules: `JobsDomainModule.forRoot()`, `JobWorkerModule.forRoot()`.
- Worker entrypoints: embedded hook in `main.ts` + standalone `worker.ts`.
- Pool config loader (five framework defaults + user pools).
- Boot-time registry validator (Drizzle mode).
- `scopeable: true` entity flag → generated `ScopeEntityType` TS union.
- Multi-tenancy opt-in via `jobs.multi_tenant: true`.
- Atlas migration docs section in `docs/CONSUMER-SETUP.md`.

Nothing else in the jobs domain is Phase 1.

## Phase 2 — Event-to-Job Bridge (ADR-023)

Not in Phase 1. Adds:
- `IJobBridge` protocol.
- `job_trigger`, `bridge_delivery` tables.
- Cron scheduler loop.
- Event-bus subscriber that matches triggers and enqueues runs.

Depends on the events subsystem's typed-event codegen work (see `../events/SKILL.md`). Until the bridge lands, trigger jobs from use cases, not directly from domain events.

## Phase 3 — Coordination / signals (ADR-025)

Adds `ctx.waitFor(kind, token, opts)`, `ctx.signal(token, payload)`, `ctx.sleep(ms)`. Also:
- Timer-based auto-resume via scheduler.
- External webhook endpoint for `resume_token` resolution.
- Meaning for the `waiting` status and `wait_kind` / `resume_token` / `wait_deadline` columns (which already exist in schema from Phase 1).

**What to do instead in Phase 1:**
- For a delay → `ctx.spawnChild(type, input, { runAt: future })` or `@JobHandler({ retry, concurrency, … })` to shape timing declaratively.
- For external coordination → split the workflow into parent + child handlers so each external wait is a run boundary. Subsequent triggers from webhooks or timers enqueue a follow-up handler via `IJobOrchestrator.start`.

Do NOT simulate signals by polling a table or using Redis keys directly — that's the exact hack ADR-022 rejected. Wait for Phase 3 or restructure the workflow.

## Phase 4 — Observability (ADR-026)

Adds:
- `job_event` audit table.
- `JobEventLogger` service.
- Selective `IEventBus` broadcast rules for lifecycle events.
- Query APIs for timeline and recent-failures views.

In Phase 1, observability is limited to `ctx.logger` output plus reading `job_run` / `job_step` rows directly.

## Phase 5 — Agent step extensions (ADR-027)

Extends `job_step.kind` enum from `'task'` (Phase 1) to include `tool_call | llm_call | wait | checkpoint | message`. Adds:
- Cost JSONB.
- Thread binding on `JobRun`.
- Helper methods `ctx.recordToolCall()`, `ctx.recordLLMCall()`.

For Phase 1 LLM/agent work, use plain `ctx.step` with `kind='task'`. Record cost in the step's `output` jsonb as needed. Don't try to extend the enum yet — it requires an Atlas migration on every consumer.

## Phase 6 — Polish

- Optional `job_artifact` table for oversized outputs (soft-limit warning at 100KB in Phase 1; hard storage comes later).
- Admin CLI: `bun codegen jobs runs <id>`, `jobs cancel <id>`, `jobs replay <id>`.
- Runtime-discovery registry option (`JobWorkerModule.forRoot({ discovery: 'runtime' })`).
- Tenant-aware fair queuing.
- BullMQ orchestrator backend (maps `JobRun → BullMQ Job`, `parent_run_id → FlowProducer`, etc.; exposes Bull Board mounting as an extension).

## Explicit "do not build this yet" list

Work items that look adjacent but are out of scope:

| Thing | Reason it's out of scope | What to do instead |
|---|---|---|
| `IJobQueue` / `job_queue` table / executor port | Deleted in JOB-1 (architectural collapse). | Use `IJobOrchestrator`. Worker polls `job_run` directly. |
| `ctx.waitFor` / `ctx.signal` / `ctx.sleep` | Phase 3 (ADR-025). | Split into parent+child or use `runAt` delays. |
| BullMQ backend | Phase 6+. Reserved slot only. | Use Drizzle backend. |
| Event-to-Job bridge | Phase 2 (ADR-023). | Enqueue from use cases for now. |
| Agent step kinds (`tool_call`, `llm_call`, …) | Phase 5 (ADR-027). | Use `kind='task'` + cost in `output`. |
| `job_event` audit table | Phase 4 (ADR-026). | Read `job_run` + `job_step`; use `ctx.logger`. |
| Jobs-as-YAML codegen / typed `Jobs` facade | Rejected in ADR-022 (see §"Codegen scope"). | Users write TypeScript `@JobHandler` classes. |
| Runtime DI container scan for handlers | Phase 6+. | Import handlers from a reachable module; boot validator catches drift. |
| Admin CLI (`jobs runs`, `jobs cancel`, `jobs replay`) | Phase 6. | Scripts / direct DB queries if you need ops for now. |
| BullMQ queue prefix config | Noted as open question in ADR-022 §"Open implementation questions #2". | Not blocking until BullMQ backend exists. |
| Tenant-aware fair queuing | Phase 6. | Phase 1 is FIFO within pool. |

## Signalling "this is deferred" in code

When you add a new feature that touches the jobs subsystem, and you hit a boundary that needs Phase 2+:

1. Don't invent a workaround in `runtime/subsystems/jobs/`. That's how the old `IJobQueue` tech debt happened.
2. Write the Phase-1-compatible shape (e.g. parent+child runs, `runAt` delays).
3. Leave a `// TODO(ADR-025)` (or `025`, `026`, `027`) comment at the call site so the future phase work can grep it.

If the requirement genuinely can't wait, escalate — draft a new spec against the relevant future-phase ADR rather than sneaking the feature into Phase 1.
