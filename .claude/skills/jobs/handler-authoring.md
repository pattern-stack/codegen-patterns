# Handler Authoring

How to write a `@JobHandler` class, use `JobContext` correctly, and plug the handler into a use case via the injected orchestrator. This is the surface most application code interacts with.

Prerequisite reading: `SKILL.md` (same folder). Source of truth for shapes: `docs/specs/JOB-2.md` (protocol + decorator definitions) and `docs/adrs/ADR-022-job-orchestration-domain-model.md` §Handler API.

## Minimal handler shape

```ts
import {
  JobHandler,
  JobHandlerBase,
  JobContext,
  ParentClosePolicy,
} from '@shared/subsystems/jobs';
import type { ScopeEntityType } from '@shared/jobs/scope-entity-type';

interface OnboardingInput {
  accountId: string;
}

interface OnboardingOutput {
  emailCount: number;
}

@JobHandler<OnboardingInput>('onboarding', {
  pool: 'batch',
  scope: {
    entity: 'account' satisfies ScopeEntityType,
    from: (input) => input.accountId,
  },
  retry: { attempts: 3, backoff: 'exponential', baseMs: 1000 },
  concurrency: {
    key: (input) => `account:${input.accountId}`,
    collisionMode: 'queue',
  },
  dedupe: {
    key: (input) => `onboarding:${input.accountId}`,
    windowMs: 24 * 60 * 60 * 1000,
  },
  timeoutMs: 60 * 60 * 1000,
  replayFrom: 'last_checkpoint',
})
export class OnboardingHandler extends JobHandlerBase<OnboardingInput, OnboardingOutput> {
  constructor(
    private readonly emails: EmailService,
    private readonly facts: FactService,
  ) {
    super();
  }

  async run(ctx: JobContext<OnboardingInput>): Promise<OnboardingOutput> {
    const emails = await ctx.step('pull_emails', () =>
      this.emails.pullForAccount(ctx.input.accountId),
    );

    await ctx.spawnChild(
      'process_facts',
      { emailIds: emails.map((e) => e.id) },
      { closePolicy: ParentClosePolicy.Terminate },
    );

    return { emailCount: emails.length };
  }
}
```

The decorator registers the class into a module-local `JOB_HANDLER_REGISTRY` at class-evaluation time. `JobWorkerModule.onModuleInit` walks the registry to upsert `job` rows and validate reserved-pool assignment. For the handler to be visible at runtime it must be imported from somewhere reachable in the Nest module tree (standard provider wiring; no runtime container scan in Phase 1 — see `phase-roadmap.md`).

## Decorator metadata reference

All fields optional except `type` (the string positional arg). Defaults come from `FRAMEWORK_DEFAULTS` in `pool-config.loader.ts` or from the `job` table columns.

| Field | Shape | Notes |
|---|---|---|
| `pool` | string | Default `'batch'`. Must not be `reserved: true` (`events_inbound`, `events_change`, `events_outbound`) — module init throws `ReservedPoolViolationError`. `interactive` is user-available but must be explicit. |
| `scope` | `{ entity: TScope; from: (input) => string }` | `entity` should be `'<name>' satisfies ScopeEntityType`. `from` extracts the scoped entity's id from input at enqueue time. |
| `retry` | `{ attempts, backoff: 'fixed' \| 'exponential', baseMs, nonRetryableErrors? }` | Run-level retry. Orthogonal to step-level retry (`ctx.step` opts). |
| `concurrency` | `{ key: (input) => string; collisionMode: 'queue' \| 'reject' \| 'replace' }` | See `SKILL.md` for semantics. Evaluated at enqueue. |
| `dedupe` | `{ key: (input) => string; windowMs: number }` | Collapses duplicate enqueues inside the window. Returns incumbent run id — no new row. |
| `timeoutMs` | number | Hard wall-clock cap across all retries. Breach → `status='timed_out'`. |
| `replayFrom` | `'scratch' \| 'last_step' \| 'last_checkpoint'` | Default `'last_checkpoint'`. Only affects behaviour on `replay(runId)`. |

Constructor injection works like any Nest provider — no special setup. Declare the handler in `providers` (or an entity/feature module's providers) so Nest can resolve its deps.

## Using `JobContext`

`ctx.input` is typed via the decorator generic (`@JobHandler<OnboardingInput>`). No cast needed inside `run`.

`ctx.run` is the current `JobRun` row: id, rootRunId, parentRunId, scope, tags, attempts, etc. Read-only from the handler's perspective.

`ctx.logger` is a NestJS `Logger` scoped to the run — prefer it over `console.log` so logs carry run context.

### `ctx.step(stepId, fn, opts?)` — memoised durable step

Use for anything that is slow, side-effectful, or pays an external cost. The first successful run persists `output` to `job_step`; replays/retries return the cached value without calling `fn`.

Rules:
- `stepId` must be **stable across replays**. Hardcode for once-per-run work (`'pull_emails'`) or derive deterministically from input (`` `recompute:${ctx.input.accountId}` ``). Never `Date.now()`, never random, never a mutable counter.
- `stepId` is unique per run (`(job_run_id, step_id)` unique index). Calling `ctx.step('x', …)` twice in a single run with the same id will hit the cached value the second time.
- `fn` should return JSON-serialisable output — it's stored in a `jsonb` column.
- Design `fn` to be effectively idempotent: under `replayFrom='scratch'` it will be called again after a replay.
- Errors inside `fn` mark the step `failed` and rethrow. If the run has retries remaining, the whole run re-enters as `pending`; on next tick, completed siblings remain memoised and this step retries.

Step-level retry (opt):

```ts
await ctx.step('fetch_profile', () => api.get(...), {
  retry: { attempts: 2, backoff: 'fixed', baseMs: 500 },
  timeoutMs: 30_000,
});
```

Step retry wraps the step call only; it does not re-run the whole handler.

### `ctx.spawnChild(type, input, opts?)` — launch a child run

```ts
const child = await ctx.spawnChild(
  'process_facts',
  { emailIds },
  {
    closePolicy: ParentClosePolicy.Terminate, // default; children die if parent does
    runAt: new Date(Date.now() + 5_000),      // optional delay
    priority: 10,
    tags: { triggeredBy: 'onboarding' },
  },
);
```

- `parent_run_id` and `root_run_id` are wired automatically.
- `closePolicy` is recorded on the child at spawn time; later parent mutation does not retroactively change it.
- Do not use `ctx.step` to wrap `ctx.spawnChild` — the child run is its own memoisation root. Spawning is already idempotent within a handler invocation via the orchestrator's enqueue path (use `dedupe` on the child job type if you need cross-invocation idempotency).
- `spawnChild` returns the `JobRun` row. For Phase 1 there is no built-in "await child completion" primitive — if you need sequencing, split the parent's logic across runs: parent spawns child with its own `scope`, completes immediately; a follow-up handler watches for child completion via `listForScope` (or waits for Phase 3 `ctx.waitFor`, see `phase-roadmap.md`).

### What's NOT on `ctx` in Phase 1

`ctx.waitFor`, `ctx.signal`, `ctx.sleep` — these land in Phase 3 (ADR-025). The `waiting` status, `wait_kind`, `resume_token`, and `wait_deadline` schema fields exist from Phase 1 as placeholders; the protocol file has an explicit comment listing them as deferred. Do not call, reference, or simulate them. If you need a delay, use `spawnChild(..., { runAt })`. If you need external coordination, split into parent + child runs and let a later tick pick up the next step.

## Plugging into a use case

Use cases kick off runs through the injected orchestrator token:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { JOB_ORCHESTRATOR, type IJobOrchestrator } from '@shared/subsystems/jobs';

@Injectable()
export class StartOnboardingUseCase {
  constructor(
    @Inject(JOB_ORCHESTRATOR) private readonly jobs: IJobOrchestrator,
  ) {}

  async execute(accountId: string) {
    return this.jobs.start(
      'onboarding',
      { accountId },
      {
        scope: { entityType: 'account', entityId: accountId },
        triggerSource: 'manual',
        tags: { source: 'admin-ui' },
      },
    );
  }
}
```

Notes:
- `start` returns the inserted `JobRun` immediately; the worker picks it up on its next poll.
- Dedupe: if `@JobHandler.dedupe` matches an in-window prior run, `start` returns the existing run id — the caller gets idempotency for free.
- Concurrency collision: `collisionMode: 'reject'` surfaces `JobCollisionError` synchronously; catch and handle in the use case.
- Prefer passing `triggerSource: 'manual' | 'schedule' | 'event' | 'parent'` so the `trigger_source` column is accurate for observability.

## Scope queries (managing runs by domain entity)

`IJobRunService` answers "everything for this account" questions:

```ts
@Inject(JOB_RUN_SERVICE) private readonly runs: IJobRunService;

await this.runs.listForScope('account', accountId, { status: 'running' });
await this.runs.cancelForScope('account', accountId);      // cascades per close policy
await this.runs.rescheduleForScope('account', accountId, tomorrow);
```

`entityType` is a string at the DB layer; type safety comes from `satisfies ScopeEntityType` on the caller side.

## Testing a handler

`@JobHandler`-decorated classes work inside `Test.createTestingModule` with `JobsDomainModule.forRoot({ backend: 'memory' })`. The memory backend is behaviour-parity with Drizzle for all Phase 1 scenarios (claim order, collision modes, step memoization, cascade cancel, dedupe, replay). See `docs/specs/JOB-4.md` §"Unit Test Suite Design" for the canonical patterns, and `runtime/subsystems/jobs/__tests__/job-worker.unit.test.ts` (added by JOB-4) for the two-tick memoization proof.

Quick recipe:
1. `Test.createTestingModule({ imports: [JobsDomainModule.forRoot({ backend: 'memory' })], providers: [YourHandler, ...deps] }).compile()`.
2. Manually register via `MemoryJobOrchestrator.registerHandler` if your test bypasses `JobWorkerModule` — otherwise import `JobWorkerModule.forRoot({ mode: 'embedded', backend: 'memory' })` and let the normal init path register.
3. Call `orchestrator.start('type', input)`; spin a few ticks; inspect `store.runs` + `store.steps`.

## Common handler shapes

- **Fan-out** — parent `ctx.step`s to load a batch, then `ctx.spawnChild` per item with `closePolicy: Terminate`. Cancel the parent → children die.
- **Sequenced pipeline** — either chain `ctx.step` calls inside one handler (simpler) or split into dedicated handler types and `spawnChild` with `parentClosePolicy: Abandon` so each hop is independently queryable and retryable.
- **Latest-wins agent loop** — `concurrency.collisionMode: 'replace'` serialises by `accountId` but cancels the incumbent when a newer trigger arrives.
- **Webhook ingestion** — `dedupe.key: (input) => input.externalId` collapses replays within the window without any app-level idempotency table.
- **Long batch with safe resume** — `replayFrom: 'last_checkpoint'` (default) + `ctx.step` per work unit → crash recovery is free, only unfinished work repeats.

## When NOT to use a handler

- **Synchronous request/response** — if the caller is waiting on the result, you probably want a use case, not a job. Jobs are durable because they're asynchronous.
- **Every emission of a domain event** — those flow through `IEventBus`, not a direct `@JobHandler`. The events subsystem drains them into the reserved `events_*` pools via the bridge (Phase 2 / ADR-023).
- **Per-request rate limiting** — the framework has no built-in request rate-limit primitive. If you need it, it's a BullMQ extension (Phase 6+), not a core contract feature.
