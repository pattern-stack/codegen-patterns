# JOB-3 — Drizzle Backends: `IJobOrchestrator`, `IJobRunService`, `IJobStepService`, and `JobWorker`

**Issue:** JOB-3
**Status:** Draft
**Last Updated:** 2026-04-18
**Depends on:** JOB-1 (schema), JOB-2 (protocols + base types)
**Blocks:** JOB-4 (memory backends must match this behaviour spec), JOB-5 (module wiring)

## Overview

Production Postgres layer for all three orchestration-domain protocols plus the tick-processing worker loop. The densest issue in Phase 1: it owns the claim query (`FOR UPDATE SKIP LOCKED`), dedupe/concurrency enforcement at enqueue time, step memoization via `job_step` upsert, parent-close-policy cascade traversal, stale-claim recovery, and graceful shutdown on `SIGTERM`. The executor-layer `IJobQueue` is not modified; it is consumed as a dependency to schedule `job_run_tick` messages that wake the worker.

## Context — Orchestration Layer vs. Executor Layer

`IJobQueue` (executor layer) is a narrow port: `enqueue`, `process`, `schedule`, `cancel`. It knows nothing about `JobRun` hierarchy, scoping, retries, or memoization. It is the substrate that moves ticks between Postgres rows (or Redis, or BullMQ).

The orchestration layer sits above it:

```
App use case
     │
     ▼
IJobOrchestrator.start(type, input, opts)
     │   dedupe check → collision check → insert job_run row
     ▼
IJobQueue.enqueue('job_run_tick', { runId })   ← executor, unchanged
     │
     ▼
JobWorker: claim job_run → run handler → record steps → transition state → re-enqueue tick
```

`IJobQueue` holds transient tick pointers. `job_run` and `job_step` in Postgres hold the durable domain state. Backend swap on the executor layer does not affect orchestration logic.

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

d. Insert `job_run` row. Resolve `rootRunId`: if `opts.parentRunId` set and `opts.rootRunId` absent, load parent's `root_run_id`; otherwise use new run's own `id` (self-reference).

e. Call `this.jobQueue.enqueue('job_run_tick', { runId }, { priority: opts.priority })`.

f. Return the created `JobRun`.

**`cancel(runId, opts)`:**

a. Load target. If terminal, return (idempotent).

b. Transition target to `canceled` atomically: `UPDATE ... WHERE id = $runId AND status NOT IN (terminal_statuses)` with `RETURNING`.

c. If `opts.cascade !== false`: fetch descendants via `WHERE root_run_id = $rootRunId AND id != $runId AND status NOT IN (terminals)`. For each, branch on `parent_close_policy`:
- `terminate` or `cancel` → transition to `canceled`
- `abandon` → skip

### 2. `job-run-service.drizzle-backend.ts`

- **`listForScope`:** query `job_run WHERE scope_entity_type AND scope_entity_id` with filters. Read-only, no tx.
- **`cancelForScope`:** fetch non-terminal runs; for each, call `orchestrator.cancel(runId, { cascade: true })`. Reuses cascade logic.
- **`rescheduleForScope`:** bulk `UPDATE run_at = $newRunAt WHERE scope AND status = 'pending'`.
- **`findByRootRunId`:** helper for cascade cancel; not on public protocol.

### 3. `job-step-service.drizzle-backend.ts`

- **`recordStep`:** upsert on `(job_run_id, step_id)` unique index. On insert, generate UUID. On conflict, update `status`, `output`, `error`, `finished_at`, `attempts`. Intentional conflict-update because step row is written as `running` first, then updated to terminal.
- **`findStep`:** `SELECT ... WHERE job_run_id = $runId AND step_id = $stepId LIMIT 1`. Returns `null` if absent. Hot path for memoization.

### 4. `job-worker.ts`

`JobWorker` is `@Injectable()`, wired by `JobWorkerModule` (JOB-5). Holds references to all three service tokens plus `IJobQueue`.

**`onModuleInit()`:**
- Register `IJobQueue.process('job_run_tick', this.handleTick)` — payload `{ runId }`
- Start stale-claim sweeper: `setInterval(() => void this.sweepStaleClaims(), opts.staleSweeperIntervalMs)`
- Register SIGTERM handler

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

**`handleTick({ runId })`:**

a. If `this.shuttingDown`, return.
b. Load `job_run`; return if absent or terminal.
c. Resolve handler class from registry; fail run if missing.
d. Concurrency queue enforcement: if `concurrency_key IS NOT NULL` and another run with same key is `running`, transition back to `pending` and return.
e. Build `JobContext`; assign `ctx.input`, `ctx.run`, `ctx.step`, `ctx.spawnChild`, `ctx.logger`.
f. Track promise in `this.inFlight: Set<Promise>` for shutdown.
g. `await handler.run(ctx)`. Capture return as `output`.
h. Success → `UPDATE job_run SET status='completed', output=$output, finished_at=now()`.
i. Error → increment `attempts`; check `non_retryable_errors`; if not exhausted, set `status='pending'`, `run_at=now()+delay`, enqueue new tick with delay. If exhausted, set `status='failed'`. Apply parent-close-policy cascade.
j. Remove promise from `inFlight` in finally.

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
| `start` (insert + enqueue tick) | Best-effort | Insert first, enqueue second; failed enqueue → stale sweeper surfaces orphan |
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
- Stale sweeper recovers stranded `running` rows
- SIGTERM drains in-flight, resets uncompleted runs on timeout

## Testing Strategy

**Integration (Docker Postgres):** enqueue→claim→complete round-trip; dedupe collapse; all three collision modes; step memoization spy; all three replay modes; cascade cancel with policy variations; stale-claim recovery; graceful shutdown drain.

**Unit:** `makeStepFn` memoization path (mocked `findStep`); error classification; backoff calculation; SIGTERM timeout exceeded (slow handler mock).

## Open Questions (with proposed resolutions)

**OQ-2 — Stale-claim sweeper placement: per-worker vs. singleton.**
Proposed: run sweeper on every `JobWorker` instance. The update is self-protecting: `WHERE status='running' AND claimed_at < threshold` — a row only transitions once; subsequent sweepers find no matching rows. Singleton adds coordination complexity (leader election) without meaningful advantage at Phase 1 scale. Document invariant: `staleThresholdMs >= 2 * max_handler_duration`.

**OQ-3 — `job` table upsert under horizontal scale.**
Proposed: `ON CONFLICT (type) DO UPDATE SET pool = EXCLUDED.pool, retry_policy = EXCLUDED.retry_policy, version = EXCLUDED.version, updated_at = now()`. Last-writer-wins. All instances of the same app version produce identical metadata — concurrent upserts are harmless. `DO NOTHING` is rejected: under rolling deploy, old-version instance A could leave a stale row that new-version instance B cannot overwrite. Advisory locks rejected: add latency + leak risk.

## Scope Boundaries

- **JOB-4** owns Memory backends (behavioural parity spec) + `JobWorker` unit tests
- **JOB-5** owns `JobsDomainModule`, `JobWorkerModule`, boot-time validator, handler registry scan, pool config
- `JobWorker` is backend-agnostic — used by both Drizzle and Memory via protocol injection

## References

- ADR-022 "Claim query (Drizzle backend)", "Hierarchy and close policy", "Replay", "Worker lifecycle", "Policy"
- `runtime/subsystems/jobs/job-queue.drizzle-backend.ts` — stale sweeper pattern (`recoverStaleJobs`, `setInterval`, `onModuleInit`/`onModuleDestroy`)
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` — `@Inject(DRIZZLE)` style
- `runtime/subsystems/jobs/job-queue.bullmq-backend.ts` — graceful shutdown drain pattern
