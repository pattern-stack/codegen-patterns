# Orchestrator and Worker

Internals of the Drizzle backend, the worker loop, and the lifecycle hooks. Read this when you're changing how runs are claimed, how steps are recorded, how cascade cancel propagates, how shutdown drains, or how the stale-claim sweeper works.

Source of truth: `docs/specs/JOB-3.md` (Drizzle backends + `JobWorker`) and `docs/specs/JOB-4.md` (Memory backends — behaviour-parity contract).

## Layer diagram

```
Consumer use case
     │  @Inject(JOB_ORCHESTRATOR)
     ▼
IJobOrchestrator.start(type, input, opts)
     │   dedupe check → collision check → INSERT job_run
     │   NO tick enqueued — worker polls directly
     ▼
JobWorker (one per active pool)
     │   setInterval → claimNext(pool) → processRun(claimed) → loop
     ▼
handler.run(ctx) with memoised ctx.step
     │   UPDATE job_run SET status = …, output = … (or re-enter pending on retry)
     ▼
(Phase 4+) JobEventLogger → IEventBus selective broadcast
```

No transient ticks, no secondary transport table. `job_run` is the only claim source.

## Protocol surface (recap from JOB-2)

Three injectable protocols, three Symbol tokens:

- `JOB_ORCHESTRATOR` → `IJobOrchestrator` — `start` / `cancel` / `replay`.
- `JOB_RUN_SERVICE` → `IJobRunService` — `listForScope` / `cancelForScope` / `rescheduleForScope`.
- `JOB_STEP_SERVICE` → `IJobStepService` — `recordStep` / `findStep`.

`JobWorker` is not a protocol — it's a concrete Nest provider wired by `JobWorkerModule`. It consumes all three protocol tokens plus the pool config.

## `start(type, input, opts)` — the enqueue path

Order of operations (JOB-3 §1a–1e):

1. Load `job` row by `type`. Missing → `JobTypeNotFoundError`.
2. **Dedupe check.** If the job declares `dedupe_key_template`, evaluate it. Query `job_run` where `(job_type, dedupe_key)` match AND `created_at > now() - dedupe_window_ms` AND `status NOT IN ('canceled', 'failed')`. If a row exists, return it — no INSERT.
3. **Concurrency check.** If `concurrency_key_template` set, query non-terminal runs with that key. Branch on `collision_mode`:
   - `reject` — throw `JobCollisionError` with incumbent runId.
   - `replace` — call `this.cancel(incumbent.id, { cascade: true, reason: 'replaced' })` and proceed.
   - `queue` — proceed. No separate "queued" flag; the claim query naturally skips this row until the incumbent exits non-terminal (see `processRun` §concurrency gating below).
4. **Generate id client-side** via `randomUUID()`. Resolve `rootRunId`: if `opts.parentRunId` present, load parent's `root_run_id`; otherwise use the new `id` (self-reference). Both go into a single INSERT — no nullable, no self-FK race.
5. Return the inserted `JobRun`. Worker discovers it on next poll.

Key property: `start` is **one transaction-less INSERT** (dedupe/collision checks are reads; the INSERT is a single statement). No tick enqueue, no secondary writes.

## `cancel(runId, opts?)` — cascade mechanics

From JOB-3 §1:

1. Load target. If terminal, return (idempotent).
2. Atomic transition: `UPDATE ... WHERE id = $runId AND status NOT IN (terminal_statuses)` with `RETURNING`. If no row returned, the run was already terminal — return idempotently.
3. If `opts.cascade !== false` (default is to cascade from root cancellations), fetch descendants: `WHERE root_run_id = $rootRunId AND id != $runId AND status NOT IN (terminals)`. For each, branch on `parent_close_policy`:
   - `terminate` or `cancel` → transition descendant to `canceled`.
   - `abandon` → skip.

Note the per-row update is **self-protecting**: each `UPDATE ... WHERE status NOT IN (terminals)` is atomic. No outer transaction required.

`cancel` does **not** walk `parent_run_id` chains — it uses `root_run_id` to fetch the whole tree in one query. `idx_job_run_root` exists for this.

## Worker loop (`job-worker.ts`)

`JobWorker` is `@Injectable()`. One instance per active pool. Holds:
- `pool: PoolDefinition`
- `orchestrator`, `runService`, `stepService` (from DI)
- `inFlight: Set<Promise<void>>` — tracks active `processRun` calls for shutdown drain
- `shuttingDown: boolean`

### `onModuleInit`

1. `setInterval(() => void this.pollAndProcess(), opts.pollIntervalMs ?? 1000)`.
2. `setInterval(() => void this.sweepStaleClaims(), opts.staleSweeperIntervalMs ?? 60_000)`.
3. Register SIGTERM handler → `this.gracefulStop(...)`.

`pollAndProcess()`:
- If `shuttingDown` or `inFlight.size >= pool.concurrency`, return immediately.
- `const claimed = await this.claimNext(pool.queue)`. If `null`, return.
- Wrap `processRun(claimed)` in a promise, add to `inFlight`, remove in `.finally`.

### The claim query

The canonical form (JOB-3 §4 and ADR-022 §"Claim query"):

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

Properties to preserve when editing:
- **`FOR UPDATE SKIP LOCKED`** is non-negotiable. It's how multiple workers share the table without serialising on locks.
- Two statements inside **one transaction**. Two statements without a tx would race: another worker could claim the same row between select and update.
- `ORDER BY priority DESC, run_at ASC` — priority first, earliest-first as tiebreak. Matches ADR-022 invariant.
- `lte(runAt, now())` — rows with `run_at > now()` are treated as scheduled-for-later and not eligible yet.
- Index `idx_job_run_claim` on `(status, pool, run_at)` must cover this query. If you change the WHERE, re-audit the index.

### `processRun(claimed)` — the execution hot path

1. Resolve handler class from `JOB_HANDLER_REGISTRY`. Missing → transition run to `failed` (defensive — JOB-5 boot validator should have caught this).
2. **Concurrency queue gate.** If `claimed.concurrency_key` is non-null and another run with the same key is currently `running`, transition this row back to `pending` (release the claim, clear `claimed_at`) and return. Next poll reconsiders after the incumbent transitions.
3. Build `JobContext`:
   - `ctx.input = claimed.input`
   - `ctx.run = claimed`
   - `ctx.step = makeStepFn(claimed)` (see below)
   - `ctx.spawnChild = makeSpawnFn(claimed)` (wraps `orchestrator.start` with `parentRunId` + inherited `rootRunId`)
   - `ctx.logger = new Logger(`JobRun:${claimed.id}`)`
4. `await handler.run(ctx)`. Capture `output`.
5. Success: `UPDATE job_run SET status='completed', output=$output, finished_at=now()`.
6. Error path:
   - Increment `attempts`.
   - Check `retry_policy.nonRetryableErrors` (matches on error class name or `.code`).
   - If retryable and `attempts < retry_policy.attempts`: set `status='pending'`, `run_at = now() + backoff_delay(attempts)`. Next poll picks it up after delay.
   - If exhausted: `status='failed'`, `error = serialised`. Apply parent-close-policy cascade (if this run has a parent whose policy is `terminate`, cascade).
7. Remove from `inFlight` in `finally`.

### `makeStepFn(run)` — the memoization primitive

```
fn(stepId, fn, opts?) {
  const existing = await stepService.findStep(run.id, stepId);
  if (existing?.status === 'completed') return existing.output;   // cache hit

  await stepService.recordStep({ runId: run.id, stepId, status: 'running', ... });
  try {
    const output = await fn();
    await stepService.recordStep({ runId: run.id, stepId, status: 'completed', output, ... });
    return output;
  } catch (err) {
    await stepService.recordStep({ runId: run.id, stepId, status: 'failed', error: serialise(err), ... });
    throw err;
  }
}
```

`recordStep` is an upsert on the `(job_run_id, step_id)` unique index — the same row is written as `running` first, then transitioned. This is intentional conflict-update behaviour; don't replace it with insert-then-update without re-auditing memoization parity across Drizzle + Memory.

`findStep` returns only `completed` rows for the memoization cache (see JOB-4 §2). A step row with `status='running'` or `status='failed'` is *not* a cache hit — the handler re-runs it.

## Replay modes

`replay(runId)` (JOB-3 §1 equivalent, detailed in JOB-4 §4):

1. Load run; assert it's in a terminal state.
2. Read `job.replay_from`.
3. Branch:
   - `scratch` — delete (or archive) all `job_step` rows for this run. Next tick re-enters with empty step table.
   - `last_step` — find the failing step; clear its row only. Completed steps remain memoised.
   - `last_checkpoint` (default) — no step modification.
4. Reset run fields: `status='pending'`, `attempts++`, clear `started_at` / `finished_at` / `error`. Leave `run_at` unchanged (or advance if the caller wants).

**Step-clearing must be atomic with the run status reset.** See JOB-3 transaction-boundary table: replay memoization reset needs a transaction.

## Stale-claim sweeper

Crashed workers strand their `claimed_at` rows. Each `JobWorker` runs an interval:

```sql
UPDATE job_run
SET status='pending', claimed_at=null
WHERE status='running' AND claimed_at < now() - $staleThresholdMs
RETURNING id;
```

Each `UPDATE` is atomic, and the `WHERE claimed_at < threshold` clause prevents double-recovery — once a row resets to `pending`, it no longer matches. Multiple workers running their own sweeper is safe (per JOB-3 OQ-2 resolution). No leader election needed.

Invariant: **`staleThresholdMs >= 2 * max_handler_duration`.** Otherwise live work gets "recovered" mid-flight and runs twice. If your handler can legitimately run for hours, raise the threshold accordingly or split the work.

`attempts` is **not** incremented by stale recovery — memoization is what protects already-completed steps. Treat sweep as "release the claim," not "count a failure."

## Graceful shutdown

`onModuleDestroy` / SIGTERM path:

1. `shuttingDown = true` — `pollAndProcess` short-circuits.
2. `await Promise.allSettled(inFlight)` bounded by `shutdownTimeoutMs` (default `30_000`).
3. For any run still `running` past the timeout: `UPDATE job_run SET status='pending', claimed_at=null`. Next worker reclaims and benefits from step memoization.
4. Clear both intervals (poll + sweep). Exit.

Do not try to "finish the current step" during shutdown — `ctx.step`'s memoization is what makes aborting safe. Completed steps persist; an incomplete step's `running` row won't cache-hit on resume, so `fn` reruns.

## Transaction boundaries (JOB-3 reference)

| Operation | Tx? | Why |
|---|---|---|
| `claimNext` | Yes | Two statements must be atomic. |
| `cancel` cascade | No | Per-row UPDATEs are self-protecting. |
| `replay` memoization reset | Yes | Step clear + status reset must be atomic. |
| `start` (single INSERT) | No | Single statement; poll finds the row. |
| `recordStep` upsert | No | Unique-index upsert is atomic at DB. |
| `findStep` | No | Read-only. |
| `rescheduleForScope` | No | Bulk UPDATE is atomic. |

When in doubt: if you can write the thing in one SQL statement and it's the only thing happening, no tx. If you have a read followed by a dependent write (or two dependent writes), tx.

## Memory-backend parity

`MemoryJobOrchestrator` uses a `PromiseMutex` (single-promise chain) to serialise mutating ops. Parity contract is in JOB-4 — claim ordering, dedupe, collision, memoization, cascade, replay must behave identically. Acceptable divergence: fsync/crash-recovery, index-scan perf, SKIP-LOCKED semantics (memory is single-process by definition), stale-claim sweeper (Drizzle-only; tested in integration only).

If you add behaviour to the Drizzle backend, add the mirror in memory **and** update `JOB-4.md` §"Behavioural Parity Contract".

## Error classification

From JOB-3 §"Error Handling Strategy":

- **Non-retryable / exhausted** → `job_run.error = { message, stack, retryable, attempt, code? }`, `status='failed'`, cascade fires if policy is `terminate`.
- **Retryable, remaining attempts** → error written, `status='pending'`, `run_at = now() + backoff`.
- **No handler** → `status='failed'` (defensive; validator should have caught at boot).
- **Stale** → sweeper resets to `pending`; no attempts increment.
- **Cancel on terminal** → no-op (idempotent).

`retry_policy.nonRetryableErrors` is an array of error class names or `.code` strings. Match at error-capture time; if any match, skip the retry branch and go straight to `failed`.
