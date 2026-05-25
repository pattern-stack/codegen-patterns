# BULLMQ-1 — BullMQ `IJobOrchestrator` backend

**Status:** Draft — ready to build
**Date:** 2026-05-25
**Source:** dbi `.ai-docs/rfcs/0003-bullmq-orchestrator-backend.md` (full design + rationale), ADR-022 §"core/extension" + §line 58 (the `JobRun → BullMQ` mapping), `docs/specs/dealbrain-bullmq-audit.md` (consumer requirements), `docs/specs/job-orchestration-research.md`
**Origin:** dealbrain-integrations design sessions 2026-05-25. dbi is the first consumer (will flip `jobs.backend: bullmq`).

---

## Problem & goal

Phase 1 ships **Drizzle only**; ADR-022 §58 reserves a BullMQ orchestrator backend as Phase 6+. dealbrain proper runs heavily on BullMQ (FlowProducer, schedulers, Bull Board — see the audit). Build a **BullMQ backend behind the existing `IJobOrchestrator` core contract** so consumers flip `jobs.backend: bullmq` with no app-code change.

**It is additive** — a new adapter + a `backend: 'bullmq'` factory branch. Do not touch the Drizzle backend, the core protocols, or app code. The domain layer (`job_run`/`job_step` as the source of truth, scoping, hierarchy) **stays in Postgres**; BullMQ replaces only the **claim/dispatch** half.

## Phase 1 — Prep (ships independently of BullMQ; do first)

These fix real defects surfaced in dbi and are valuable on the Drizzle backend too:

1. **Revive the dead bridge guard.** `JobWorkerModule` provides `JOB_WORKER_MODULE_OPTIONS` but `exports: []`, so `BridgeModule`'s reserved-pool guard (`bridge.module.ts` `onModuleInit`) injects `@Optional()` `undefined` and silently no-ops. **Export the token.** ⚠ Check existing tests that mount `JobWorkerModule.forRoot` + `BridgeModule` without reserved pools — they will newly throw `BridgeReservedPoolsNotPolledError`; fix them to pass the reserved pools (this is the guard working as intended).
2. **`allPools` option on `JobWorkerModule.forRoot`.** Add `allPools?: boolean`; when set, `onModuleInit` resolves `activePools = [...poolConfig.keys()]` (incl. reserved) instead of `allNonReservedPoolNames`. Make `BridgeModule`'s guard short-circuit pass when `workerOpts.allPools` is true.
3. **Bridge/events-aware standalone worker template.** `templates/subsystem/jobs/worker.ejs.t` currently emits a thin `worker.ts` (DatabaseModule + JobsDomainModule + JobWorkerModule, non-reserved pools only) → `BridgeDeliveryHandler` (events_* pools, needs EVENT_BUS/JOB_ORCHESTRATOR/BRIDGE_*) is unregistered and reserved lanes never drain. Emit a `worker.ts` that imports the generated `SUBSYSTEM_MODULES` barrel + `JobWorkerModule.forRoot({ mode:'standalone', allPools: true })`. (dbi had to hand-author this — see dbi `worker.ts`; this retires that.)

## Phase 2 — The backend

Mirror `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` (the template, 536 lines, methods `start`/`cancel`/`replay`/`upsertJobRows`).

| Core contract op | BullMQ mapping |
|---|---|
| `start(type, input, opts)` | `queue.add(type, payload, { jobId, attempts, backoff })`; also insert the `job_run` row (Postgres stays source of truth) |
| pool | one BullMQ **queue** per pool (use `jobs.pools[].queue` alias) |
| `concurrency` per pool | `Worker(queue, processor, { concurrency })` |
| `parent_run_id` / hierarchy | `FlowProducer` parent/child |
| retry policy | job opts `{ attempts, backoff: { type:'exponential', delay } }` |
| dedupe (`idempotencyKey`) | `jobId` + `deduplication.ttl` |
| `cancel` | `job.remove()` (+ cascade via `root_run_id` as Drizzle does) |
| `listForScope` | **unchanged** — query Postgres `job_run` |
| boot `upsertJobRows` + validator | retained — handler registry → queue registration |

New files (mirror the drizzle ones):
- `runtime/subsystems/jobs/job-orchestrator.bullmq-backend.ts` (`BullMQJobOrchestrator implements IJobOrchestrator`)
- `runtime/subsystems/jobs/job-worker.bullmq-backend.ts` (or extend the worker) — `new Worker(queue, processor, { concurrency })` per pool; processor resolves the handler via the registry and runs it through the existing `JobHandlerBase` path.
- `backend: 'bullmq'` branch in `JobsDomainModule.forRoot` / `JobWorkerModule.forRoot` (swap orchestrator + worker providers; keep `forRoot` surface identical).
- Config validation: accept `jobs.backend: 'bullmq'` + typed `jobs.extensions.bullmq.{ redis_url, bull_board }`; resolve `REDIS_URL`.

## Gotchas

1. **`jobId` must be colon-safe + stable.** Consumers use `vendor:externalId` ids and `idempotencyKey`; BullMQ treats `:` as a key separator (dealbrain's `BullMQService.sanitizeBullMQId` strips colons). **Use `sha1(idempotencyKey)`** as the `jobId` — colon-safe, stable (same logical key → same id → dedup works). Confirm no collision concern at expected volumes.
2. **Postgres + BullMQ coordination.** `job_run` is the domain source of truth (for `listForScope`/hierarchy/scoping); BullMQ holds dispatch state. The orchestrator writes both. Keep them consistent (insert `job_run` in `start`; the worker updates `job_run.status` on completion/failure).
3. **Reserved pools → reserved queues.** Bridge's reserved-pool guard maps to "is a Worker consuming this queue." Pair with Phase-1 prep #1/#2.

## Extensions (opt-in; not core)

- **Bull Board** — `jobs.extensions.bullmq.bull_board.{ enabled, mount_path }`. dealbrain mounts at `/api/admin/queues` behind admin auth. Emit as opt-in; the Drizzle backend (no dashboard) stays a valid peer.
- **FlowProducer** exposure for parent/child DAGs.
- Cron / `upsertJobScheduler` — **out of scope** (ADR-025 scheduling territory); note it.

## Verification (the falsifier / port-promotion gate)

Run the existing **job-orchestrator contract suite against the BullMQ backend** (Valkey/Redis up). This is the 2nd-impl test that promotes `IJobOrchestrator` per ADR-022 §claim. Backend stays opt-in (`jobs.backend: drizzle` default) until this is green.

## dbi consumption (after this lands)

dbi flips `jobs.backend: bullmq` + `jobs.extensions.bullmq.redis_url: redis://localhost:16379` (the `valkey` docker-compose service is already scaffolded), regenerates (regen is non-destructive on 0.8.1), boots the same `worker.ts`. See dbi RFC-0003 §5.

## Related codegen-patterns work (this batch)
- [OBS-LIST-1](OBS-LIST-1.md) — observability combiner list reads (independent).
- [CREATE-DTO-1](CREATE-DTO-1.md) — create-DTO `.optional()` fix (independent, small).
- Deferred epic: dbi RFC-0004 (user-defined triggers / DB-backed `bridge_trigger` + composite registry) — extends the bridge; design locked, not in this batch.
