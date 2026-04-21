# JOB-3 — Drizzle Backends: `IJobOrchestrator`, `IJobRunService`, `IJobStepService`, and `JobWorker`

**Issue:** JOB-3
**Status:** Draft
**Last Updated:** 2026-04-20
**Depends on:** JOB-1 (schema), JOB-2 (protocols + base types)
**Blocks:** JOB-4 (memory backends must match this behaviour spec), JOB-5 (module wiring)

## Overview

Production Postgres backend implementing the three orchestration protocols plus the worker loop. Single-layer architecture per the architectural collapse decision (CLAUDE.md, ADR-022 revised spine): no executor layer, no `IJobQueue`, no `job_queue` table. The worker polls `job_run` directly via `SELECT ... FOR UPDATE SKIP LOCKED`, runs the handler, records steps, transitions state, and loops. This is the densest issue in Phase 1: it owns the claim query, dedupe/concurrency enforcement, step memoization via `job_step` upsert, parent-close-policy cascade, stale-claim recovery, and graceful shutdown.

## Context

Per the core/extension principle (CLAUDE.md), `IJobOrchestrator` is the swap point. Phase 1 ships only the Drizzle backend implementing the **core contract**. A future BullMQ orchestrator backend (Phase 6+) would map `JobRun → BullMQ Job`, `parent_run_id → FlowProducer`, etc., and expose backend-specific **extensions** (Bull Board mounting, native rate limits) — but that is not Phase 1 work.

```
App use case
     │
     ▼
IJobOrchestrator.start(type, input, opts)
     │   dedupe check → collision check → INSERT job_run
     ▼
JobWorker polling loop (per pool)
     │   SELECT ... FOR UPDATE SKIP LOCKED on job_run WHERE status='pending' AND pool=$1
     ▼
Run handler.run(ctx) with memoized ctx.step
     │   UPDATE job_run SET status=..., output=... (or re-enter pending on retry)
     ▼
JobEventLogger → IEventBus (selective broadcast — Phase 5)
```

`job_run` and `job_step` are the only persistence. No transient ticks, no separate transport.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` | create | `IJobOrchestrator` — start, cancel, replay |
| `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts` | create | `IJobRunService` — scope queries, cascade cancel, reschedule |
| `runtime/subsystems/jobs/job-step-service.drizzle-backend.ts` | create | `IJobStepService` — upsert step, lookup for memoization |
| `runtime/subsystems/jobs/job-worker.ts` | create | Tick loop, claim query, graceful shutdown, stale sweeper |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export all four new classes |

## Implementation Steps

### 1. `job-orchestrator.drizzle-backend.ts`

**`start(type, input, opts)`:**

a. Load `job` row. Throw `JobTypeNotFoundError` if absent.

b. Dedupe check — if `dedupe_key_template` set: evaluate key; query `job_run` where `(job_type, dedupe_key)` and `created_at > now() - dedupe_window_ms` and `status NOT IN ('canceled','failed')`. If a row exists, return it without inserting.

c. Concurrency collision check — if `concurrency_key_template` set: query `job_run` where matching `concurrency_key` and `status IN ('pending','running')`. Branch on `collision_mode`:
- `reject` — throw `JobCollisionError` with incumbent's `runId`
- `replace` — call `this.cancel(incumbent.id, { cascade: true, reason: 'replaced' })` before proceeding
- `queue` — proceed; claim query natively gates the new row behind the incumbent (enforced at claim time, step 4d)

d. Generate `id` client-side via `randomUUID()`. Resolve `rootRunId`: if `opts.parentRunId` set, load parent's `root_run_id`; otherwise use the new `id` (self-reference). INSERT `job_run` row in a single statement.

e. Return the created `JobRun`. **No tick to enqueue** — the polling worker for the relevant pool will claim the row on its next loop iteration.

**`cancel(runId, opts)`:**

a. Load target. If terminal, return (idempotent).

b. Transition target to `canceled` atomically: `UPDATE ... WHERE id = $runId AND status NOT IN (terminal_statuses)` with `RETURNING`.

c. If `opts.cascade !== false`: fetch descendants via `WHERE root_run_id = $rootRunId AND id != $runId AND status NOT IN (terminals)`. For each, branch on `parent_close_policy`:
- `terminate` or `cancel` → transition to `canceled`
- `abandon` → skip

**`replay(runId)` (added during JOB-3 implementation, 2026-04-20):**

a. Load the target run and its `job` definition. If the run is not in a terminal status (`completed` | `failed` | `timed_out` | `canceled`), throw `JobNotReplayableError`. Phase-1 protocol signature is `replay(runId)` with no options, so the effective replay mode is read from `job.replay_from` alone — user-override lands in a later phase.

b. Resolve effective `replay_from` mode:
- `scratch` → DELETE all `job_step` rows for this run.
- `last_step` → DELETE only non-`completed` step rows; completed steps stay memoised so `ctx.step` cache-hits on resume.
- `last_checkpoint` → **Phase 1 collapses to `last_step`.** The schema has no explicit checkpoint markers yet; delete only non-completed step rows. The two modes diverge in a later phase once `job_step.kind === 'checkpoint'` (ADR-027) is added.

c. UPDATE `job_run`: `status='pending'`, `attempts=0`, `run_at=now()`, `started_at=null`, `finished_at=null`, `claimed_at=null`, `error=null`, `output=null`.

d. Wrap steps (a)+(b)+(c) in a single transaction (per the transaction-boundary table — step reset + run reset must commit together).

e. Return the updated `JobRun`.

### 2. `job-run-service.drizzle-backend.ts`

- **`listForScope`:** query `job_run WHERE scope_entity_type AND scope_entity_id` with filters. Read-only, no tx.
- **`cancelForScope`:** fetch non-terminal runs; for each, call `orchestrator.cancel(runId, { cascade: true })`. Reuses cascade logic.
- **`rescheduleForScope`:** bulk `UPDATE run_at = $newRunAt WHERE scope AND status = 'pending'`.
- **`findByRootRunId`:** helper for cascade cancel; not on public protocol.

### 3. `job-step-service.drizzle-backend.ts`

- **`recordStep`:** upsert on `(job_run_id, step_id)` unique index. On insert, generate UUID. On conflict, update `status`, `output`, `error`, `finished_at`, `attempts`. Intentional conflict-update because step row is written as `running` first, then updated to terminal.
- **`findStep`:** `SELECT ... WHERE job_run_id = $runId AND step_id = $stepId LIMIT 1`. Returns `null` if absent. Hot path for memoization.

### 4. `job-worker.ts`

`JobWorker` is `@Injectable()`, wired by `JobWorkerModule` (JOB-5). One worker instance per active pool; each holds references to the orchestrator, run service, and step service.

**`onModuleInit()`:**
- Start the polling loop: `setInterval(() => void this.pollAndProcess(), opts.pollIntervalMs)` (default 1000ms)
- Start stale-claim sweeper: `setInterval(() => void this.sweepStaleClaims(), opts.staleSweeperIntervalMs)` (default 60s)
- Register SIGTERM handler

**`pollAndProcess()`:**
- If `this.shuttingDown` or `this.inFlight.size >= this.pool.concurrency`, return.
- Call `claimNext(this.pool.name)`. If `null`, return (nothing to do this tick).
- Otherwise call `processRun(claimed)` — tracked in `this.inFlight` so shutdown can await it.

**`claimNext(pool)` — ADR-022 pattern:**
```ts
return db.transaction(async (tx) => {
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
    .set({ status: 'running', claimedAt: new Date(), startedAt: new Date() })
    .where(eq(jobRuns.id, candidate.id))
    .returning();

  return claimed;
});
```

**`processRun(claimed)`:**

a. Resolve handler class from registry; if missing, transition run to `failed` (boot validator should have caught this — defensive only).
b. Concurrency queue enforcement: if `claimed.concurrency_key IS NOT NULL` and another run with same key is currently `running`, transition this row back to `pending` (release the claim) and return. Next poll will re-evaluate.
c. Build `JobContext`; assign `ctx.input = claimed.input`, `ctx.run = claimed`, `ctx.step = makeStepFn(claimed)`, `ctx.spawnChild = makeSpawnFn(claimed)`, `ctx.logger`.
d. `await handler.run(ctx)`. Capture return as `output`.
e. Success → `UPDATE job_run SET status='completed', output=$output, finished_at=now()`.
f. Error → increment `attempts`; check `non_retryable_errors`; if not exhausted, set `status='pending'`, `run_at=now()+delay` (next poll claims it after the delay window). If exhausted, set `status='failed'`. Apply parent-close-policy cascade.
g. Remove promise from `inFlight` in finally.

**`ctx.step(stepId, fn, opts?)` closure (`makeStepFn(run)`):**
- Call `stepService.findStep(run.id, stepId)`.
- If `status === 'completed'`, return `step.output` (memoized).
- Otherwise: record `running` step. Call `await fn()`. On success, upsert `completed` with `output`. On error, upsert `failed`; rethrow.

**`sweepStaleClaims()`:**
- `UPDATE job_run SET status='pending', claimed_at=null WHERE status='running' AND claimed_at < now() - $staleThresholdMs RETURNING id`. Log each at `warn`. Safe concurrency: each update is atomic; `WHERE claimed_at < threshold` prevents double-recovery.

**`onModuleDestroy()` / SIGTERM:**
- Set `shuttingDown = true`.
- Await `Promise.allSettled([...this.inFlight])` with `shutdownTimeoutMs` (default 30000).
- For runs still `running` past timeout: `UPDATE job_run SET status='pending', claimed_at=null`. Next worker reclaims.
- Clear stale sweeper interval.

## Transaction Boundaries

| Operation | Needs Tx? | Why |
|---|---|---|
| `claimNext` | Yes | Atomic select + update; two statements allow race |
| `cancel` cascade | No | Per-row updates are self-protecting |
| `replay` memoization reset | Yes | Step deletes + status reset must be atomic |
| `start` (single INSERT) | No | Single statement; polling worker discovers the row on next loop |
| `recordStep` upsert | No | Unique-index upsert is atomic at DB level |
| `findStep` | No | Read-only |
| `rescheduleForScope` | No | Bulk UPDATE is atomic |

## Error Handling Strategy

- **Non-retryable or exhausted:** structured error `{ message, stack, retryable, attempt, code? }` → `job_run.error`. Status → `failed`. Parent-close cascade fires if policy is `terminate`.
- **Retryable, not exhausted:** error written; status back to `pending`; `run_at = now() + backoff`; new tick enqueued.
- **No handler registered:** transition to `failed`; defensive (validator should catch this at boot per JOB-5).
- **Stale claim (crashed worker):** sweeper resets to `pending`; no `attempts` increment (memoization protects completed steps).
- **Cancel on terminal:** idempotent.

## Acceptance Criteria

- `claimNext(pool)` uses `FOR UPDATE SKIP LOCKED` in a transaction (verified via `.toSQL()` inspection + concurrent-worker integration test)
- Dedupe collapse returns existing `runId` within window
- Concurrency modes: `queue` serializes; `reject` throws; `replace` cancels incumbent
- `ctx.step` memoizes across retries
- `replay_from` modes: `scratch` clears all steps; `last_step` clears only failing; `last_checkpoint` preserves all
- Cascade cancel respects `parent_close_policy` (terminate/cancel/abandon)
- Stale sweeper: per-`JobWorker` instance, wired via `setInterval` in `onModuleInit`; uses `FOR UPDATE SKIP LOCKED` so concurrent sweepers across horizontally-scaled workers are safe (a row is recovered at most once); recovers stranded `running` rows back to `pending` (Q2 resolved 2026-04-19)
- SIGTERM drains in-flight, resets uncompleted runs on timeout

## Testing Strategy

**Integration (Docker Postgres):** enqueue→claim→complete round-trip; dedupe collapse; all three collision modes; step memoization spy; all three replay modes; cascade cancel with policy variations; stale-claim recovery; graceful shutdown drain.

**Unit:** `makeStepFn` memoization path (mocked `findStep`); error classification; backoff calculation; SIGTERM timeout exceeded (slow handler mock).

## Open Questions (with proposed resolutions)

**OQ-2 — Stale-claim sweeper placement. Resolved 2026-04-19.**
Resolution: sweeper runs on every `JobWorker` instance (per-pool), wired via `setInterval` in `onModuleInit`. The sweep query uses `FOR UPDATE SKIP LOCKED`, making concurrent sweepers across horizontally-scaled workers safe — a row is recovered at most once. Singleton rejected: adds coordination complexity (leader election) without meaningful advantage at Phase 1 scale. Document invariant: `staleThresholdMs >= 2 * max_handler_duration`.

**OQ-3 — `job` table upsert under horizontal scale.**
Proposed: `ON CONFLICT (type) DO UPDATE SET pool = EXCLUDED.pool, retry_policy = EXCLUDED.retry_policy, version = EXCLUDED.version, updated_at = now()`. Last-writer-wins. All instances of the same app version produce identical metadata — concurrent upserts are harmless. `DO NOTHING` is rejected: under rolling deploy, old-version instance A could leave a stale row that new-version instance B cannot overwrite. Advisory locks rejected: add latency + leak risk.

## Scope Boundaries

- **JOB-4** owns Memory backends (behavioural parity spec) + `JobWorker` unit tests
- **JOB-5** owns `JobsDomainModule`, `JobWorkerModule`, boot-time validator, handler registry scan, pool config
- `JobWorker` is backend-agnostic — used by both Drizzle and Memory via protocol injection

## Implementation Decisions (landed with JOB-3, 2026-04-20)

These were resolved during implementation. Kept here so JOB-4 (memory parity) and future maintainers see the rationale.

- **Template evaluation for `concurrency_key_template` and `dedupe_key_template`.** Simple `{{field}}` single-key substitution against the `input` payload — no dotted paths, no Mustache/Handlebars dependency. A missing field throws `JobTemplateFieldMissingError` synchronously at `start()` time, so misconfiguration surfaces to the caller rather than silently producing a literal `"undefined"` key that bypasses dedupe/collision checks. Exported as `evaluateKeyTemplate(template, input)` from `job-orchestrator.drizzle-backend.ts` for reuse by the Memory backend in JOB-4.

- **Error classes.** Four exported from `runtime/subsystems/jobs/jobs-errors.ts`: `JobTypeNotFoundError`, `JobCollisionError` (carries `incumbent: JobRun`), `JobNotReplayableError`, `JobTemplateFieldMissingError`. All re-exported from `runtime/subsystems/jobs/index.ts`. Memory backend (JOB-4) throws the same classes for behavioural parity.

- **`last_step` vs `last_checkpoint` collapse at Phase 1.** Both modes currently delete only non-`completed` step rows, because the `job_step_kind` enum carries only `'task'` at Phase 1. They diverge once ADR-027 adds `checkpoint` as a step kind: `last_checkpoint` will preserve steps up to the most recent `kind='checkpoint'` row, whereas `last_step` will continue to preserve every `completed` step. Flagged for JOB-4 parity and for the ADR-027 implementation.

- **Concurrency-queue release mechanism.** When a `queue`-mode run is claimed but another run with the same `concurrency_key` is already `running`, the worker releases the claim by transitioning the row back to `pending` with `claimed_at=null, started_at=null`. The next poll re-evaluates. No separate "queued" flag — the `status='pending'` + matching-key check is sufficient and keeps the state model flat.

- **Stale-sweeper placement (OQ-2).** Per-worker. The candidate select uses `FOR UPDATE SKIP LOCKED`, so simultaneous sweepers across multiple workers never collide on the same row. Invariant: `staleThresholdMs >= 2 × max_handler_duration`.

- **`nextStepSeq` allocation.** SELECT-max-plus-one at step-record time. Per-run step counts are typically <100; the in-memory counter alternative drifts if the worker crashes mid-run and a replacement worker resumes via stale-claim sweep.

## References

- ADR-022 "Claim query (Drizzle backend)", "Hierarchy and close policy", "Replay", "Worker lifecycle", "Policy"
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` — `@Inject(DRIZZLE)` style + `setInterval`/`onModuleInit`/`onModuleDestroy` lifecycle pattern
- (The legacy `runtime/subsystems/jobs/job-queue.*-backend.ts` files were referenced in earlier drafts as patterns to copy. They are being **deleted** in JOB-1; use `event-bus.drizzle-backend.ts` as the surviving pattern reference.)
