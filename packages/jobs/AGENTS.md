---
name: pattern-stack-jobs
summary: The shared job module — Job, Run, Step and Item, the deterministic step engine, its ports and the framework-free adapters.
owner: engineering
version: 0.1.0
last_reviewed: 2026-11-15
status: active
scope:
  applies_to:
    - "packages/jobs"
capabilities:
  - read-codebase
  - propose-patches
  - review-pull-requests
  - run-local-validation
permissions:
  repository:
    contents: read
    pull_requests: read
  external:
    network: false
inputs:
  - user_request
  - repository_docs
  - pull_request_diff
outputs:
  - patch
  - review_comments
dependencies:
  - zod
  - bun
security_privacy:
  data_classes:
    - source_code
  prohibited:
    - use-any-type
    - import-nest-drizzle-bullmq-or-other-packages-into-the-core
    - read-clock-randomness-or-io-outside-ports-in-the-engine
    - put-content-in-events
    - share-results-or-dedupe-across-tenants
audit_logging:
  log_locations:
    - github_pull_request_review
  correlation:
    - github.sha
    - pull_request_number
testing:
  required_smoke_tests:
    - "just test-jobs"
lifecycle:
  review_cadence: quarterly
deprecation:
  status: none
---

# @pattern-stack/jobs — Agent Instructions

## Scope

- **Owns:** `@pattern-stack/jobs`, the shared job module: the domain model (Job, Run, Step, Item), how a job is declared, the retry and stop policies, the ports, the engine, the framework-free adapters, the framework adapters on their own export paths (`./postgres`, `./bullmq`, `./redis`), a host's framework-free parts (`./host`: the budget rule, the span and fan-out sinks, the limiter boot check, which the Nest layer wraps and a plain host uses as they are), the Nest layer (`./nest`: one `JobsService`, the actor policy, input refs, the sinks and the module), the store, limiter and replay contracts, and the review rules below.
- **Defers to parent (`../../AGENTS.md`) for:** repo-wide commands, the CODE_CONTEXT contract, the PR delivery workflow and the strict rules.
- **Defers to [`JOBS_CONTRACT.md`](JOBS_CONTRACT.md) for:** how jobs, runs, steps, items, waits, gates, signals, child runs, limiters and stored values behave, how to add a job, and the review rules no check can hold (side effects, `ctx.signal`, version bumps).
- **History:** see sibling [`CODE_CONTEXT/`](./CODE_CONTEXT/).

## Read before changing

| Paths | Read |
| --- | --- |
| `src/**` | [`JOBS_CONTRACT.md`](JOBS_CONTRACT.md) |
| `src/engine/**`, `src/define/**` | [`JOBS_CONTRACT.md`](JOBS_CONTRACT.md) (Temporal-ready rules, Other review rules) |
| `src/postgres/**`, `src/bullmq/**`, `src/redis/**` | [`JOBS_CONTRACT.md`](JOBS_CONTRACT.md) (The framework adapters) |
| `src/nest/**` | [`JOBS_CONTRACT.md`](JOBS_CONTRACT.md) (The Nest layer) |
| `src/testing/**` | [`JOBS_CONTRACT.md`](JOBS_CONTRACT.md) (the store, limiter and replay contracts) |

## Temporal-ready rules

- Keep the engine's control flow deterministic: deciding the next step, planning chunks and reading the stop read the clock, randomness and I/O only through the ports; no `Date.now()`, `new Date()`, `Math.random()`, `setTimeout` or `fetch` in `src/engine/`. Guard: `src/__tests__/layers.test.ts`.
- A step returns a small value or a reference: a stored value is plain JSON of at most 1 MB; bulk data goes to a domain's tables or object storage and the step returns its id. Guard: `src/__tests__/engine.test.ts`.
- Claims, heartbeats and retries belong to the executor adapter; the engine says only what may be retried (`RetryPolicy`, `NonRetryableError`) and fences every chunk write by its claim's token. Guard: `src/__tests__/adapters.test.ts`.
- Ids come from the store, never the engine. Guard: `src/__tests__/layers.test.ts`.
- A spent budget pauses a run, never fails it; budget checks sit between steps and chunks, and a plain step re-reads its run before every attempt so a cancel or pause stops its retries. Guard: `src/__tests__/engine.test.ts`.
- The result never depends on how far ahead the engine worked: `stopWhen` reads only the contiguous settled prefix, and items past the stop are discarded. Guard: `src/__tests__/replay.test.ts`.
- A wait is durable state on the step's row, never in the executor: an executor only submits, and the advance decides. Guard: `src/__tests__/replay.test.ts`.

## Review rules

- Decide a run's cache mode once, at `startRun` (the request's `cache`, else `cacheFor(input)`, else `read-write`), and store it on the run. Guard: `src/__tests__/engine.test.ts`.
- Never fence spend: a call that settles after a cancel or a lost claim records its cost; a call that paid and threw uses `withSpend`, and a batch failing items without throwing returns `BatchResult.failed`. Guard: `src/__tests__/engine.test.ts`.
- A deterministic failure fails its item alone, whatever the chunk size; a failure in `hydrate` or a batch of the wrong length is a definition error. Guard: `src/__tests__/engine.test.ts`.
- Events come from `JOB_EVENT_TYPES` and carry ids and counts, never content; an error appears only by its type. Guard: `src/__tests__/engine.test.ts`.
- Scope results, the cache and dedupe by tenant; never widen either across tenants. Guard: `src/__tests__/adapters.test.ts`.
- Refuse an open run made by another `definitionVersion` (`RunVersionConflictError`), never resuming it under new code. Guard: `src/__tests__/engine.test.ts`.
- A bump drains, then fails the old version's open runs (`JobVersionGoneError` once the process and the run are both older than `versionGraceMs`, `drainWindow`), never leaving them open; an old worker leaves a newer version's fresh run. Guard: `src/__tests__/engine.test.ts`.
- Keep a job's facts (`audience`, `authority`, `limits`, `admit`, `subject`, `cacheFor`) out of its `definitionVersion`. Guard: `src/__tests__/define.test.ts`.
- A public job declares `limits`, and a job with a `side-effect` step needs `start: 'admin'`; `defineJob` refuses either missing. Guard: `src/__tests__/define.test.ts`.
- `admit` runs inside `startRun` for every caller, after the input parses and before the run exists; a refusal creates nothing and holds no dedupe key. Guard: `src/__tests__/engine.test.ts`.
- An unknown run id throws `RunNotFoundError` in every store, so a surface tells not found by type, never by message. Guard: `src/__tests__/adapters.test.ts`.
- A step starts as a CAS on its attempts, so of two advancers racing on one attempt only one runs it and an ended step is never restarted. Guard: `src/__tests__/adapters.test.ts`.
- Keep gates and limiters out of a definition's version: they change when work runs, never what it computes. Guard: `src/__tests__/define.test.ts`.
- A gate's name is a code constant, and a closed gate is never a failure or a skip. Guard: `src/__tests__/engine.test.ts`.
- `GateClosedError` for a gate the step doesn't declare is a definition error. Guard: `src/__tests__/engine.test.ts`.
- A throttle is never a failed attempt: a 429 releases the permit throttled and the same batch is asked again in the same attempt. Guard: `src/__tests__/adapters.test.ts`.
- Every limiters adapter passes `limiterContract`. Guard: `src/__tests__/adapters.test.ts`.
- Every job passes `replayContract` in its tests. Guard: judgment.
- A side-effect step publishes nothing under `ctx.dryRun`, and the job's tests run it dry and assert no side-effect write. Guard: judgment.
- Every store adapter runs `storeContract`, and every behavioural change to the store port updates the contract in the same change. Guard: judgment.
- The single-run reads (`getRun`, `progress`, `stepStates`, `chunks`) are not tenant-scoped: a surface checks `run.tenantId` before returning anything. Guard: judgment.
- A map step's `key` depends only on what the work means and which item it is about, names everything its result depends on, and never embeds content. Guard: judgment.

## The framework adapters

- Each framework adapter is its own export path with its framework an optional peer, so the core and its importers never load Drizzle or BullMQ. Guard: `src/__tests__/fences.test.ts`.
- `PostgresJobStore` passes `storeContract` on real Postgres. Guard: `../../test/integration/jobs-postgres-store.integration.test.ts` (`just test-jobs-integration`).
- Every timestamp the Postgres store writes comes from its `now`, never SQL `now()`, and its claim token comes from the store. Guard: `src/postgres/__tests__/store-clock.test.ts`.
- A Postgres chunk claim is one `FOR UPDATE SKIP LOCKED` statement, and every chunk write is fenced by owner, token and an open run while its spend still lands. Guard: `../../test/integration/jobs-postgres-store.integration.test.ts` (`just test-jobs-integration`).
- A transaction that writes a run's chunks or items locks the run row first, then the chunk, and reads the run in a statement after the locking one. Guard: judgment.
- Copy every row's `tenant_id` from its run inside the statement that writes it; the operator reads that cross tenants serve a superuser surface only. Guard: judgment.
- `eventLogSink` keeps every event but `step.progress`; the store never emits. Guard: `src/postgres/__tests__/event-log-sink.test.ts`.
- BullMQ only dispatches: one deduplicated advance per run, so advances of one run never overlap and a submit mid-advance becomes the next one. Guard: `src/bullmq/__tests__/bullmq.test.ts`.
- Retries have one owner, the engine: every BullMQ job is added with `attempts: 1` and no BullMQ backoff. Guard: `src/bullmq/__tests__/bullmq.test.ts`.
- Every engine job is its own run's trace root: `submit` and `sweep()` enqueue with no context, and a handled job stamps what it enqueues with its own. Guard: `src/bullmq/__tests__/bullmq.test.ts`.
- Successive sweeps rotate through every open run, past runs of another version left open. Guard: `src/bullmq/__tests__/bullmq.test.ts`.
- `redisLimiters` passes `limiterContract` on Valkey, one quota across processes, two clients as two holders. Guard: `test/integration/jobs-redis-limiters.integration.test.ts` (codegen's `just test-jobs-integration`, a real Valkey); the in-memory limiters run the same contract in `src/__tests__/adapters.test.ts`.

## The Nest layer

- `@pattern-stack/jobs/nest` ships no controller: every surface is the host's, and each calls one `JobsService` method with the actor its view serves. Guard: `src/nest/__tests__/jobs.service.test.ts`.
- Every access rule over the `JobActor` union lives in the package's policy: a tenant actor reaches only public jobs at its kind's level, every miss the same 404, 403 only on a visible job. Guard: `src/nest/__tests__/jobs.policy.test.ts`.
- The operator reaches every registered job across tenants, and the system reaches its own tenant's registered jobs with no job authority. Guard: `src/nest/__tests__/jobs.policy.test.ts`.
- A start records the member, never the tenant key. Guard: `src/nest/__tests__/jobs.policy.test.ts`.
- One input-ref source per kind: a second one throws, and the boot stops when a registered job names a kind no module registered. Guard: `src/nest/__tests__/job-input-refs.test.ts`.
- A start refuses a ref id the run's tenant doesn't hold, by the field's path, creating nothing. Guard: `src/nest/__tests__/job-input-refs.test.ts`.
- A map step's or plain step's `present` runs at read time; a missing presenter, a throw or an answer its view schema refuses is `view: null`, never an error. Guard: `src/nest/__tests__/jobs.service.items.test.ts`; `src/nest/__tests__/jobs.service.steps.test.ts`.
- `activeSpanSink` annotates only the active span with ids, counts and an error type, never content, and opens no span. Guard: `src/nest/__tests__/event-sinks.test.ts`.
- `@nestjs/common` and `@opentelemetry/api` are optional peers resolved to the host's one copy: a second copy makes every jobs error a 500 or leaves the span sink writing nowhere. Guard: judgment.

## Layers and imports

- `src/model/` imports only `src/model/`; `src/ports/` and `src/policy/` import only `src/model/`; `src/define/` imports `src/model/`, `src/policy/` and the recorder port types; `src/engine/` never imports `src/adapters/`. Guard: `src/__tests__/layers.test.ts`.
- An executor adapter imports only the engine's entry points listed in the contract's Layers section, never a step's internals. Guard: `src/__tests__/layers.test.ts`.
- An executor guarantees at most one advancer per run at a time. Guard: `src/__tests__/adapters.test.ts`.
- The core's only runtime dependency is `zod`: nothing under `src/` imports Nest, Drizzle, BullMQ or another workspace package, or an adapter path. Guard: `src/__tests__/fences.test.ts`.
- Production code never imports `@pattern-stack/jobs/testing`; deep imports past the `exports` map are refused. Guard: `src/__tests__/fences.test.ts`; type.
