# BULLMQ-1 — BullMQ `IJobOrchestrator` backend

> **Update (2026-06-15, ADR-041 / BULLMQ-2):** Three follow-ons landed after this spec.
> (1) **Installability** — `'bullmq'` was added to the jobs `SubsystemDescriptor.backends`; the backend shipped here was un-installable via the CLI until then. (2) **Core-contract leaks closed** — `dispatch()` now maps `runAt`→BullMQ `delay` and `priority`→BullMQ `priority` (JOBS-2), and the worker honours `collisionMode:'queue'` via `moveToDelayed`+`DelayedError` (JOBS-3); these `StartOptions` fields were silently dropped under BullMQ. (3) **Scheduling** — see the revised §Extensions cron bullet (shipped via ADR-039/BULLMQ-2). The events subsystem now also has a BullMQ backend (BULLMQ-2). See ADR-041 for the all-BullMQ topology.

**Status:** Implemented (Phase 1 + Phase 2 + ADR-041 follow-ons) — port-promotion gate pending a broker (see §Verification)
**Date:** 2026-05-25
**Source:** dbi `.ai-docs/rfcs/0003-bullmq-orchestrator-backend.md` (full design + rationale), ADR-022 §"core/extension" + §line 58 (the `JobRun → BullMQ` mapping), `docs/specs/dealbrain-bullmq-audit.md` (consumer requirements), `docs/specs/job-orchestration-research.md`
**Origin:** dealbrain-integrations design sessions 2026-05-25. dbi is the first consumer (will flip `jobs.backend: bullmq`).

---

## Problem & goal

Phase 1 ships **Drizzle only**; ADR-022 §58 reserves a BullMQ orchestrator backend as Phase 6+. dealbrain proper runs heavily on BullMQ (FlowProducer, schedulers, Bull Board — see the audit). Build a **BullMQ backend behind the existing `IJobOrchestrator` core contract** so consumers flip `jobs.backend: bullmq` with no app-code change.

**It is additive** — a new adapter + a `backend: 'bullmq'` factory branch. Do not touch the Drizzle backend, the core protocols, or app code. The domain layer (`job_run`/`job_step` as the source of truth, scoping, hierarchy) **stays in Postgres**; BullMQ replaces only the **claim/dispatch** half.

## Phase 1 — Prep (ships independently of BullMQ; done — commit `505e917`)

These fix real defects surfaced in dbi and are valuable on the Drizzle backend too:

1. **Revive the dead bridge guard.** `JobWorkerModule` provided `JOB_WORKER_MODULE_OPTIONS` but `exports: []`, so `BridgeModule`'s reserved-pool guard (`bridge.module.ts` `onModuleInit`) injected `@Optional()` `undefined` and silently no-opped. **Done — token is now exported** (`exports: [JOB_WORKER_MODULE_OPTIONS]`). ✅ **Resolved discovery:** the spec warned existing tests mounting `JobWorkerModule.forRoot` + `BridgeModule` without reserved pools would newly throw. In practice **no such test exists** — `bridge.module.spec.ts` uses a `FakeWorkerOptionsModule` providing the token directly (and already exercises both the "all reserved pools present" and "missing reserved pools → throws" cases), and `job-worker.module.spec.ts` never mounts `BridgeModule`. So the revival broke nothing; no test fixes were needed. The guard is now genuinely live.
2. **`allPools` option on `JobWorkerModule.forRoot`.** Done — added `allPools?: boolean`; `onModuleInit` resolves `activePools = allPoolNames(poolConfig)` (every pool, reserved incl.) when set, via a new `allPoolNames()` loader helper. **Precedence (discovered, now documented):** explicit `pools` > `allPools` > non-reserved default — explicit beats blanket. `BridgeModule`'s guard short-circuits pass when `workerOpts.allPools` is true (every reserved lane is provably polled).
3. **Bridge/events-aware standalone worker template.** Done — `templates/subsystem/jobs/worker.ejs.t` now imports the generated `SUBSYSTEM_MODULES` barrel (via the `@generated/subsystems` alias) + `JobWorkerModule.forRoot({ mode:'standalone', allPools: true })`. This registers `EVENT_BUS`/`JOB_ORCHESTRATOR`/`BRIDGE_*` so `BridgeDeliveryHandler` resolves, and drains the reserved `events_*` lanes. Retires the hand-authored dbi `worker.ts`.

## Phase 2 — The backend

Mirror `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` (the template, 536 lines, methods `start`/`cancel`/`replay`/`upsertJobRows`).

| Core contract op | BullMQ mapping |
|---|---|
| `start(type, input, opts)` | `queue.add(type, payload, { jobId, attempts, backoff })`; also insert the `job_run` row (Postgres stays source of truth) |
| pool | one BullMQ **queue** per pool (use `jobs.pools[].queue` alias) |
| `concurrency` per pool | `Worker(queue, processor, { concurrency })` |
| `parent_run_id` / hierarchy | `queue.add(..., { parent: { id, queue } })` for incremental `ctx.spawnChild`; `FlowProducer` exposed (`.flowProducer()`) for atomic-tree submits. See §Extensions discovery note. |
| retry policy | job opts `{ attempts, backoff: { type:'exponential', delay } }` |
| dedupe (`idempotencyKey`) | `jobId` + `deduplication.ttl` |
| `cancel` | `job.remove()` (+ cascade via `root_run_id` as Drizzle does) |
| `listForScope` | **unchanged** — query Postgres `job_run` |
| boot `upsertJobRows` + validator | retained — handler registry → queue registration |

New files (done — commit Phase 2):
- `runtime/subsystems/jobs/job-orchestrator.bullmq-backend.ts` — `BullMQJobOrchestrator extends DrizzleJobOrchestrator`. **Implementation decision:** rather than reimplement the 536 lines of dedupe / concurrency-collision / parent-resolution / `job_run` INSERT / cancel-cascade / replay logic, the BullMQ backend **extends** the Drizzle backend and overrides `start`/`cancel`/`replay` to layer BullMQ dispatch on top of the shared Postgres writes. `start` calls `super.start()` (Postgres stays the source of truth) then `dispatch()` (queue.add). `cancel` snapshots the subtree, calls `super.cancel()` (DB cascade), then removes the matching BullMQ jobs. `replay` calls `super.replay()` then re-enqueues. `upsertJobRows` is inherited untouched. The Drizzle backend file itself was **not modified** (the spec's "do not touch" holds) — the subclass keeps its own `bullDb` handle because the parent's `db` is `private`.
- `runtime/subsystems/jobs/job-worker.bullmq-backend.ts` — `BullMQJobWorker`: one `new Worker(queueName, processor, { concurrency })` per active pool. The processor loads the `job_run` row, marks it `running`, resolves the handler via `ModuleRef`, builds the `JobContext` (same `ctx.step` / `ctx.spawnChild` semantics as the Drizzle `JobWorker`), runs `handler.run(ctx)`, and writes `job_run.status`. Throwing rethrows so BullMQ applies the job's `attempts`/`backoff`; the terminal failure mirrors to `job_run.status='failed'` in the `failed` event handler (only once attempts are exhausted). No claim query / stale sweeper / backoff math — BullMQ owns all three.
- `runtime/subsystems/jobs/bullmq.config.ts` — the extension config surface: `BullMqExtensionsConfig` (snake_case YAML shape), `resolveBullMqConfig` (redis_url → `REDIS_URL` env → `redis://localhost:6379`), `resolvePoolQueueName` (logical pool → `def.queue` alias + optional `queue_prefix`), and the `BULLMQ_CONNECTION` / `BULLMQ_RESOLVED_CONFIG` DI tokens.
- **`bullmq` is an OPTIONAL peer dependency — the backend files MUST lazy-load it (discovered constraint, post-review).** `jobs-domain.module.ts` *statically* imports `BullMQJobOrchestrator`, so a `drizzle`-only consumer loads that file at module-eval. A top-level *value* import (`import { Queue, Worker, FlowProducer } from 'bullmq'`) resolves `'bullmq'` eagerly → `MODULE_NOT_FOUND` boot crash for any consumer who didn't install the optional dep. (Unit tests here mask it — `bullmq` is a devDep in this repo.) **Fix, mirroring `event-bus.redis-backend.ts:createRedisClient`:** both bullmq backend files use **`import type` only** for `Queue`/`Worker`/`FlowProducer`/`ConnectionOptions`/`Job` (types are erased — never resolve at runtime); the value constructors load via `await import('bullmq')` at first use — orchestrator: `loadBullMq()` (idempotent, caches the ctors), `await`ed at the top of `dispatch`/`cancel`/`flowProducer`; worker: in its now-async `onModuleInit` — each wrapped in try/catch → friendly `'BullMQ backend requires the "bullmq" package. Install it with: npm install bullmq'`. `flowProducer()` and `BullMQJobWorker.onModuleInit` became async as a result (the spawn loop `await`s the latter — a no-op for the sync Drizzle/stub workers). Pinned by regression tests: a static-source check that the backend files have zero top-level value imports of `'bullmq'`, plus a runtime check that constructing the orchestrator leaves the lazy ctors unloaded.
- `backend: 'bullmq'` branch in `JobsDomainModule.forRoot` (orchestrator → `BullMQJobOrchestrator`, run/step services **stay Drizzle** — `listForScope` is an unchanged Postgres query; binds + conditionally exports the BullMQ tokens) and `JobWorkerModule.forRoot` (spawns `BullMQJobWorker` per pool when `backend==='bullmq'`; injects the BullMQ tokens `@Optional()`; closes orchestrator producer connections on destroy). `forRoot` surfaces are unchanged.
- Config: `jobs.backend: 'bullmq'` + typed `jobs.extensions.bullmq.{ redis_url, queue_prefix, bull_board }`. **Note on validation:** this project Zod-validates only the `pipelines`/`generate`/`patterns` config blocks; `jobs` is passed through untyped (see `src/config/config-loader.ts`). "Validation" for BullMQ is therefore TypeScript-level — the runtime `forRoot` options are strongly typed (`BullMqExtensionsConfig`), and the subsystem barrel composer (`subsystem-barrel-generator.ts`) inlines the typed extension block into the generated `JobsDomainModule.forRoot(...)` / `JobWorkerModule.forRoot(...)` calls. No new project-level Zod schema was added (none of the other subsystem backends have one either).

## Gotchas

1. **`jobId` must be colon-safe + stable.** Consumers use `vendor:externalId` ids and `idempotencyKey`; BullMQ treats `:` as a Redis key separator. Implemented as **`sha1(idempotencyKey)`** (`sha1JobId()` in `job-orchestrator.bullmq-backend.ts`) — colon-safe, stable (same logical key → same id → BullMQ-native dedup). When a run has no dedupe key configured, the `jobId` falls back to the `job_run.id` UUID (already colon-free). **Collision finding (resolved during implementation):** SHA-1's 160-bit space puts the birthday bound at ~2^80 distinct keys before a 50% accidental-collision chance — orders of magnitude beyond any realistic job volume, so there is **no collision concern at expected (or even absurd) volumes**. SHA-1's cryptographic break is irrelevant here: there is no adversary forging idempotency keys, and a forged collision would only deduplicate two jobs the caller already chose to key identically. We accept SHA-1 with no mitigation (no salt, no upgrade to SHA-256). The *intentional* same-key→same-id mapping IS the dedup mechanism, not a collision. Recorded in the `sha1JobId` JSDoc.
2. **Postgres + BullMQ coordination.** `job_run` is the domain source of truth (for `listForScope`/hierarchy/scoping); BullMQ holds dispatch state. The orchestrator writes both — `super.start()` inserts the `job_run` row, then `dispatch()` enqueues. The `BullMQJobWorker` marks `running` on claim and writes the terminal `completed`/`failed` status. A run canceled in Postgres after enqueue but before claim is honoured: the processor reads the row, sees `status==='canceled'`, and skips the handler.
3. **Reserved pools → reserved queues.** Bridge's reserved-pool guard maps to "is a Worker consuming this queue." Paired with Phase-1 prep #1/#2 — the standalone `worker.ts` sets `allPools: true`, so a BullMQ `Worker` is spawned for every reserved `events_*` queue too.

## Extensions (opt-in; not core)

- **Bull Board** — `jobs.extensions.bullmq.bull_board.{ enabled, mount_path }`. Parsed + resolved into `BullMqResolvedConfig.bullBoard` (default mount `/admin/queues`). **Mounting is the consumer's responsibility** — Bull Board needs the consumer's Express/Nest adapter and admin auth, which the framework can't synthesize; we only carry the config. The Drizzle backend (no dashboard) stays a valid peer.
- **FlowProducer** exposure — `BullMQJobOrchestrator.flowProducer()` returns the shared `FlowProducer` for consumers that want to submit a whole parent/child DAG atomically up front. Backend-specific (not portable). **Note on the runtime `ctx.spawnChild` path:** that is incremental, so it uses `queue.add` with a `parent: { id, queue }` ref (attaching to the parent's existing BullMQ job) rather than the FlowProducer — `queue.add` is the correct primitive for incremental spawns, and the FlowProducer is reserved for the atomic-tree use case. **Discovery / correction:** the spec's mapping table said "`parent_run_id` → FlowProducer"; the accurate mapping is "FlowProducer for atomic trees, `queue.add` `parent` ref for incremental spawns." Both express the same BullMQ parent/child link. The domain `parentClosePolicy` cascade remains Postgres-authoritative either way.
- `queue_prefix` — optional namespace (`jobs.extensions.bullmq.queue_prefix`) so several codegen apps can share one Redis without queue-name collisions (ADR-022 §"BullMQ queue naming collisions"). Applied to every pool queue alias.
- Cron / `upsertJobScheduler` — was deferred here; **now SHIPPED** as the ADR-039 materializer swap on the events side (BULLMQ-2 / ADR-041, 2026-06-15). Recurring automation is event-shaped: a job declares its cadence (RFC-0005 D4) → a scheduled domain event → the bridge → the job. `BullMQEventBus` registers BullMQ Job Schedulers (`upsertJobScheduler`) that produce the scheduled domain event into the outbox; the jobs orchestrator deliberately does NOT gain a `schedule()` method (it would force a Drizzle/Memory scheduler into the core — ADR-041). The original "ADR-025 scheduling territory" pointer was wrong; **ADR-039 is the scheduling territory**.

## Verification (the falsifier / port-promotion gate)

The port-promotion gate is the existing **job-orchestrator contract suite run against the BullMQ backend with a real Postgres `job_run` + a Redis/Valkey broker up**. This is the 2nd-impl test that promotes `IJobOrchestrator` per ADR-022 §claim. Backend stays opt-in (`jobs.backend: drizzle` default) until this is green.

**What ran in this codegen-patterns PR:**
- `just test-unit` — green (the new `job-orchestrator.bullmq.spec.ts`: 15 tests covering `sha1JobId`, `resolveBullMqConfig`, `resolvePoolQueueName`, and DI wiring that `JobsDomainModule.forRoot({ backend: 'bullmq' })` resolves `BullMQJobOrchestrator` *without* opening a Redis connection; plus the Phase-1 `allPools`/guard tests and the barrel-composer bullmq tests).
- Runtime + templates typecheck clean (only 3 pre-existing, unrelated `src/cli/` junction-typing errors remain).

**What could NOT run here, and why (honest gap — do not mistake the green unit suite for the gate):**
- The behavioural claim/dispatch path (`start` → `queue.add` → `BullMQJobWorker` → `completed`/`failed`/retry/cancel-remove) requires BOTH a live Redis broker AND a live Postgres (`job_run` is the source of truth). **This codegen-patterns repo ships `runtime/` INTO consumer projects and does not depend on a Postgres driver (`pg`/`node-postgres`) itself** — every in-repo orchestrator test uses the Memory backend or a `drizzle(pg-proxy)` mock that never talks to a real DB. There is also **no reusable cross-backend contract harness** (the existing "contract suite" is `MemoryJobOrchestrator`-specific). A Redis container was reachable in the sandbox, but it belongs to other projects and is not ours to write test data into.
- **Therefore the port-promotion gate is a CI/local follow-up in the dbi consumer repo**, which has a Postgres and the scaffolded `valkey` docker-compose service (see §dbi consumption / dbi RFC-0003 §5). Until that runs green, `jobs.backend: bullmq` stays opt-in (default `drizzle`), exactly as ADR-022 §claim requires. The unit suite here proves the wiring and the pure helpers; it does NOT prove the broker round-trip — and was not faked to.

## dbi consumption (after this lands)

dbi flips `jobs.backend: bullmq` + `jobs.extensions.bullmq.redis_url: redis://localhost:16379` (the `valkey` docker-compose service is already scaffolded), regenerates (regen is non-destructive on 0.8.1), boots the same `worker.ts`. See dbi RFC-0003 §5.

## Related codegen-patterns work (this batch)
- [OBS-LIST-1](OBS-LIST-1.md) — observability combiner list reads (independent).
- [CREATE-DTO-1](CREATE-DTO-1.md) — create-DTO `.optional()` fix (independent, small).
- Deferred epic: dbi RFC-0004 (user-defined triggers / DB-backed `bridge_trigger` + composite registry) — extends the bridge; design locked, not in this batch.
