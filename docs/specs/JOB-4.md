# JOB-4 — Memory Backends + Unit Test Suite

**Issue:** JOB-4
**Status:** Implemented
**Last Updated:** 2026-04-20
**Depends on:** JOB-2 (protocols), JOB-3 (behaviour spec to match)
**Phase:** ADR-022 Phase 1

## Overview

In-process, mutex-based implementations of `IJobOrchestrator`, `IJobRunService`, and `IJobStepService` using plain TypeScript `Map` structures. Exists solely for the unit test suite: reproduces the Drizzle backends' behavioural contract for all Phase 1 scenarios — claim ordering, collision modes, step memoization, cascade cancel, dedupe window, replay modes — without a database. The unit tests against these backends are the regression gate for both memory and Drizzle.

## Context

Memory backends are not a simplified subset; the contract is the same, only persistence differs. Acceptable non-parity: fsync/crash-recovery, claim latency, index-scan performance, distributed locking. Not acceptable: ordering of claimed runs, collision outcomes, memoization cache hits, cascade cancel propagation, dedupe short-circuit, replay row-clearing semantics.

## Architecture

```
Test module
  └── JobsDomainModule.forRoot({ backend: 'memory' })
        ├── MemoryJobOrchestrator   (IJobOrchestrator)
        ├── MemoryJobRunService     (IJobRunService)
        └── MemoryJobStepService    (IJobStepService)

MemoryJobOrchestrator
  ├── holds MemoryJobStore.runs:  Map<runId, JobRunRow>
  ├── holds MemoryJobStore.steps: Map<runId, JobStepRow[]>
  ├── holds MemoryJobStore.jobs:  Map<jobType, JobRow>
  ├── uses PromiseMutex           (serializes claim + collision checks)
  └── delegates to MemoryJobStepService (memoization)
```

All three services share the same `MemoryJobStore` instance via constructor injection. `PromiseMutex` is a private single-promise-chain mutex (not exported).

## Files

| File | Action | Purpose |
|---|---|---|
| `runtime/subsystems/jobs/job-orchestrator.memory-backend.ts` | create | `MemoryJobOrchestrator` + private `PromiseMutex` |
| `runtime/subsystems/jobs/job-run-service.memory-backend.ts` | create | `MemoryJobRunService` |
| `runtime/subsystems/jobs/job-step-service.memory-backend.ts` | create | `MemoryJobStepService` |
| `runtime/subsystems/jobs/memory-job-store.ts` | create | `MemoryJobStore` shared container (exported for test resets) |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export memory classes + `MemoryJobStore` |
| `src/__tests__/runtime/subsystems/job-orchestrator.unit.spec.ts` | create | All Phase 1 scenarios |
| `src/__tests__/runtime/subsystems/job-worker.unit.spec.ts` | create | `@JobHandler` + two-tick memoization proof |

> **Note (2026-04-20, implementation correction).** The original draft
> placed the unit tests under `runtime/subsystems/jobs/__tests__/`. That
> directory is excluded by `tsconfig.build.json` and — more importantly —
> `just test-unit` runs `bun test src/__tests__/` only. Co-locating the
> jobs unit tests with the rest of the subsystem tests (cache, events,
> storage, etc.) matches the established project convention and is what
> the build+test pipeline actually executes. Files live at the paths in
> the table above; the `*.spec.ts` suffix matches the other subsystem
> tests.

## Interfaces

```typescript
// memory-job-store.ts (exported)
export class MemoryJobStore {
  runs: Map<string, JobRunRow> = new Map();
  steps: Map<string, JobStepRow[]> = new Map();
  jobs: Map<string, JobDefinitionRow> = new Map();
  clear(): void { this.runs.clear(); this.steps.clear(); this.jobs.clear(); }
}

// job-orchestrator.memory-backend.ts (internal, not exported)
class PromiseMutex {
  private queue: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn());
    this.queue = next.then(() => {}, () => {});
    return next;
  }
}
```

## Implementation Steps

### 1. `MemoryJobStore` (`memory-job-store.ts`)

Plain class with three Maps + `clear()`. Not `@Injectable()` — wired as `useValue` provider so tests can hold direct reference for `beforeEach` resets. Export from `index.ts`.

### 2. `MemoryJobStepService`

- Step storage: `Map<runId, JobStepRow[]>` from shared store.
- `findStep(runId, stepId)`: scan array for run; return first match where `step_id === stepId AND status === 'completed'`. Return `null` if none. Non-completed steps invisible to memoization (matches Drizzle).
- `recordStep(input)`: assign monotonic `seq` per-run, `randomUUID()` id, push to array, return row. Conflict behavior: overwrite existing entry with same `step_id`.
- Helper methods: `clearStepsForRun(runId)` (replay=scratch), `clearIncompleteSteps(runId)` (replay=last_step / last_checkpoint — both collapse to "delete non-completed rows" in Phase 1, matching the Drizzle backend).

### 3. `PromiseMutex` (inline private in orchestrator file)

Single-promise chain queuing `fn`s. `run<T>(fn)` chains onto internal queue. Swallows errors on the chain pointer (not returned result) to prevent chain-breakage.

### 4. `MemoryJobOrchestrator`

All mutating ops inside `mutex.run(...)`.

**`start(type, input, opts)`:**
- Resolve `JobDefinitionRow` from `store.jobs`; throw `UnknownJobTypeError` if absent.
- Dedupe check: scan `store.runs` for non-terminal matching `(job_type, dedupe_key)` within window. Return existing if found.
- Concurrency check (if `concurrency_key` set): find non-terminal run with matching key. Branch:
  - `reject` → throw `JobCollisionError`
  - `replace` → `cancel(incumbent, { cascade: true })`, then insert
  - `queue` → simulate Drizzle's claim-time gating by setting `run_at` to a sentinel future; register incumbent `runId` as blocker; when incumbent reaches terminal state, advance blocked run's `run_at` to `now()`
- Insert new `JobRunRow`: `status='pending'`, `created_at=now()`, `run_at=opts.runAt ?? now()`.
- Return row.

**`cancel(runId, opts)`:**
- Load; return if already terminal.
- Set `status='canceled'`, `finished_at=now()`.
- If `cascade === true`: find all with `root_run_id === run.root_run_id AND id !== runId AND parent_close_policy !== 'abandon'`; recursively cancel.
- `Cancel` policy: collect children first; cancel them before transitioning parent's `finished_at`.

**`claimNext(pool)` (used by worker):**
- Inside mutex. Filter `runs` for `status='pending' AND pool=$pool AND run_at <= now()`.
- Sort by `priority DESC, run_at ASC`. Take first. Set `status='running', claimed_at=now()`. Return row or `null`.

**`replay(runId)`:**
- Load; assert terminal. Determine `replay_from` from `JobDefinitionRow`.
- `scratch`: `stepService.clearStepsForRun(runId)`.
- `last_step`: delete every non-`completed` step row via `stepService.clearIncompleteSteps(runId)` — parity with the Drizzle backend, which the implementation of JOB-3 collapsed `last_step` onto `"delete where status != 'completed'"`.
- `last_checkpoint`: same as `last_step` in Phase 1 — `clearIncompleteSteps(runId)`. Phase 1 has no explicit checkpoint markers so the three modes collapse to two distinct behaviours (`scratch` vs. the `last_*` pair). Noted in JOB-3 "Implementation Decisions"; memory backend mirrors it.
- Reset run fields: `status='pending'`, `attempts++`, clear `started_at`, `finished_at`, `error`.

**`tick(runId)` (called by JobWorker):**
- Load run; assert `status='running'`.
- Resolve handler class from internal registry (populated via `registerHandler()` called by `JobWorkerModule.onModuleInit`).
- Build `JobContext`. `ctx.step(id, fn, opts?)` calls `stepService.findStep` → return cached or invoke `fn`, then `recordStep`.
- Execute `handler.run(ctx)`.
- Success: `status='completed'`, `output=result`, `finished_at=now()`.
- Error: increment `attempts`; if `< retry.attempts`, set `pending`; else `failed`, `error=serialized`.

### 5. `MemoryJobRunService`

- `listForScope`: linear scan of `store.runs.values()` with filters.
- `cancelForScope`: collect non-terminal; call `orchestrator.cancel(runId, { cascade: true })` each. Orchestrator injected via constructor.
- `rescheduleForScope`: update `run_at` on matching non-terminal runs.
- `findById`: direct `store.runs.get(runId)`.

### 6. Handler registration (memory mode)

- `MemoryJobOrchestrator.registerHandler(type, meta, HandlerClass)` — populates internal registry AND `store.jobs` with in-memory `JobDefinitionRow` (replaces Drizzle upsert in memory mode).
- `JobWorkerModule.onModuleInit` calls this for each discovered `@JobHandler`.

## Behavioural Parity Contract

| Scenario | Must match Drizzle |
|---|---|
| `claimNext` ordering (priority DESC, run_at ASC) | yes |
| `claimNext` skips `run_at > now()` | yes |
| Dedupe within window returns existing id, no new row | yes |
| Dedupe outside window creates new row | yes |
| Collision `queue` — second run stays pending until first terminal | yes |
| Collision `reject` — throws, no insert | yes |
| Collision `replace` — incumbent canceled, new run inserted | yes |
| `ctx.step` memoization cache hit on re-entry | yes |
| `replay_from: scratch` clears all prior steps | yes |
| `replay_from: last_step` clears only failing step | yes |
| `replay_from: last_checkpoint` preserves all | yes |
| Cascade `Terminate` — descendants canceled | yes |
| Cascade `Cancel` — parent waits for children | yes |
| Cascade `Abandon` — children untouched | yes |
| Run-level retry re-enters as `pending` | yes |
| `replay(runId)` produces new run with correct lineage | yes |

**Acceptable non-parity:** SKIP LOCKED semantics (single-process only), fsync, query perf, stale-claim sweeper (Drizzle-only; integration-test concern), tenant filtering (JOB-8).

## Unit Test Suite Design

### `src/__tests__/runtime/subsystems/job-orchestrator.unit.spec.ts`

Fresh `MemoryJobStore` in `beforeEach` (cheaper and more explicit than
`clear()`; matches the other subsystem test files). Direct instantiation
(no NestJS) for protocol-level tests.

**Group 1 — Claim / queue ordering**
- Insert three pending runs in same pool with priorities `[10, 5, 10]`, run_ats `[T-2s, T-1s, T-3s]`. Assert `claimNext` returns priority-10 with earliest run_at.
- Insert run with `run_at = now() + 60s`. Assert `claimNext` returns `null`.
- Two pools. Assert cross-pool isolation.

**Group 2 — Collision modes**
- `queue`: start A with `concurrency_key='acct:1'`; advance to `running`; second `start` returns new pending id; `claimNext` skips until A completes.
- `reject`: second `start` throws `JobCollisionError`.
- `replace`: second `start` transitions A to `canceled`; new run is pending and claimable.

**Group 3 — Step memoization**
- Run with handler invoking `ctx.step('fetch', fn)`. Tick once; assert `fn` called. Simulate second tick; assert `fn` not called again.
- Second step not previously completed: assert called on re-entry.

**Group 4 — Cascade cancel**
- Parent + two children (policies: `Terminate`, `Abandon`). Cancel parent. Terminate child `canceled`; Abandon child `pending`.
- Three-level `Terminate` tree: cancel root → all three canceled.
- `Cancel` policy: parent `finished_at` set only after child terminal.

**Group 5 — Dedupe**
- `dedupe_window_ms=60000`; second start within window returns same id, single row.
- Advance first `created_at` to `now() - 70s`; third start creates new row.

**Group 6 — Replay modes**
- `scratch`: two completed steps + failed run; replay clears steps; new run starts empty.
- `last_step`: step A completed, step B failed; replay clears B only.
- `last_checkpoint`: step A completed; replay + tick; `fn_A` not called (memoized); `fn_B` called.

### `src/__tests__/runtime/subsystems/job-worker.unit.spec.ts`

NestJS test module to prove decorator + DI integration.

- `TestOnboardingHandler` decorated with `@JobHandler('test_onboarding', { pool: 'batch' })`. A plain `AccountService` injectable captures invocations. Because `JobsDomainModule` lands with JOB-5, the test wires the three memory providers (`MemoryJobStore`, `MemoryJobOrchestrator`, `MemoryJobRunService`, `MemoryJobStepService`) directly via `Test.createTestingModule({ providers: [...] })` against the `JOB_ORCHESTRATOR` / `JOB_RUN_SERVICE` / `JOB_STEP_SERVICE` tokens — exactly the shape JOB-5's `forRoot({ backend: 'memory' })` will emit.
- `ctx.step` memoization: step fn invoked once across two ticks.

All tests run under `just test-unit` with no Docker.

## Acceptance Criteria

- [x] Three memory services implement their protocols with no public-API casts
- [x] All three collision modes have passing tests
- [x] Step memoization: fn not called on second tick if completed on first
- [x] Cascade cancel: `Terminate`/`Cancel`/`Abandon` behaviors correct
- [x] Dedupe: in-window collapse; outside-window new row
- [x] All three replay modes pass
- [x] `@JobHandler` decorated class instantiated in NestJS test module; memoizes across two ticks
- [x] `just test-unit` passes without Docker

## Scope Boundary

- BullMQ-specific claim logic: not touched; executor-layer `MemoryJobQueue` unchanged
- `JobsDomainModule.forRoot()`, `JobWorkerModule.forRoot()`: JOB-5
- Drizzle backends: JOB-3
- Stale-claim sweeper: Drizzle-only; integration test in JOB-3

## Open Questions (resolved)

**OQ-4 — Boot-time validator in memory mode (ADR-022 #4).** Validator skipped entirely in memory mode — no DB rows to validate. Instead, `MemoryJobOrchestrator.start()` throws `UnknownJobTypeError` synchronously when type is not in in-memory registry. Equivalent protection, no DB dependency.

**OQ — Concurrency `queue` simulation.** `start()` detects collision → new run stored with `run_at = MAX_DATE` (constant `QUEUED_RUN_AT = new Date(8_640_000_000_000_000)`, matching JavaScript's max-date sentinel); incumbent's `runId` registered as blocker via a private `queueBlockers: Map<incumbentId, dependentId[]>`; on incumbent terminal transition (`cancel`, `markCompleted`, `markFailed`) the orchestrator advances every dependent's `run_at` back to `now()` so the next `claimNext(pool)` picks them up. The Drizzle backend achieves the same effect differently — the worker's `processRun` re-checks the concurrency key and re-queues the row if another run is still `running` — but the observable semantics (second run stays un-claimed until the first terminates) match.

## References

- ADR-022: all sections relevant to Phase 1
- `runtime/subsystems/events/event-bus.memory-backend.ts` — memory backend style
- `runtime/subsystems/jobs/job-queue.memory-backend.ts` — executor-layer memory (unchanged)
- Protocols (dependency): JOB-2 output files
- Drizzle behaviour (matching target): JOB-3 spec
