<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Authoring a Job Handler

This is the surface your application code touches most: how to write a `@JobHandler` class, use `JobContext` correctly, and kick a job off from a use case. Read the `jobs` `SKILL.md` first for the mental model.

## Minimal handler

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

The handler class:
- **extends `JobHandlerBase<TInput, TOutput>`** and implements the single `run(ctx)` method.
- is decorated with `@JobHandler<TInput>('job_type', meta)`. The string is the unique job type — it is what you pass to `orchestrator.start(...)`.

### Register the class as a provider

The decorator registers the class with the job registry so the worker knows the type exists. It does **not** register it with Nest's DI container — that is on you. Add the handler to the `providers` array of its owning module (e.g. an entity/feature module). At runtime the worker resolves it via the Nest module tree; a handler that is not a registered provider fails when its first run is claimed. Constructor injection works like any provider, as long as the providing module is imported where your handler lives.

## Decorator metadata reference

Everything except the `type` positional argument is optional.

| Field | Shape | Notes |
|---|---|---|
| `pool` | `string` | Default `'batch'`. Must not be a reserved `events_*` pool — app boot throws `ReservedPoolViolationError`. `interactive` is allowed but must be explicit. See `pools-and-ordering.md`. |
| `scope` | `{ entity: ScopeEntityType; from: (input) => string }` | Ties each run to a domain entity id so you can later list/cancel "everything for this account". `entity` should be `'<name>' satisfies ScopeEntityType`. |
| `retry` | `{ attempts, backoff: 'fixed' \| 'exponential', baseMs, nonRetryableErrors? }` | Run-level retry across the whole handler. Independent of step-level retry. |
| `concurrency` | `{ key: (input) => string; collisionMode: 'queue' \| 'reject' \| 'replace' }` | Evaluated at enqueue. See collision modes below. |
| `dedupe` | `{ key: (input) => string; windowMs: number }` | Collapses duplicate enqueues inside the window — returns the existing run id, no new row. |
| `timeoutMs` | `number` | Hard wall-clock cap across all retries. Breach → `status='timed_out'`. |
| `replayFrom` | `'scratch' \| 'last_step' \| 'last_checkpoint'` | Default `'last_checkpoint'`. Only matters when a run is replayed. |
| `triggers` | `JobTrigger<TInput>[]` | Bind this job to domain events — covered by the `bridge` skill, not here. |

### Concurrency collision modes

Set once on the decorator, not per call site. Two runs collide when their `key(input)` matches and the incumbent is still in a non-terminal state.

- `queue` (default) — the new run is accepted as `pending`; it is only claimed once the incumbent leaves its non-terminal state. Serializes by key.
- `reject` — the new `start(...)` throws `JobCollisionError` carrying the incumbent's run id.
- `replace` — the incumbent is cancelled (cascade), the new run starts. The "latest wins" pattern.

Concurrency is orthogonal to dedupe: dedupe short-circuits (no new row); concurrency queues (new row exists, claim is gated).

### Replay modes

`replayFrom` is a memoization policy only — the same handler code runs in all cases. It controls what `job_step` rows survive when a run is replayed:

- `scratch` — clear all step rows, re-enter from empty. Your steps must be safe to re-run.
- `last_step` — clear only the failing step's row; completed steps stay memoized.
- `last_checkpoint` (default) — clear nothing; every completed step returns its cached output.

## Using `JobContext`

```ts
ctx.input    // your TInput, typed via @JobHandler<TInput> — no cast needed
ctx.run      // the JobRun row (id, rootRunId, parentRunId, scope, tags, attempts, ...)
ctx.step(id, fn, opts?)            // durable, memoized step
ctx.spawnChild(type, input, opts?) // launch a child run, returns its JobRun
ctx.logger   // a NestJS Logger scoped to this run — prefer it over console.log
```

### `ctx.step(stepId, fn, opts?)` — durable memoized step

Wrap anything slow, side-effectful, or externally costly. The first successful run persists `fn`'s output to `job_step`; on a retry or replay, the cached value is returned without calling `fn` again.

Rules:
- `stepId` must be **stable across replays** — hardcode (`'pull_emails'`) or derive deterministically (`` `recompute:${ctx.input.accountId}` ``). Never `Date.now()`, never random, never a mutable counter.
- `stepId` is unique within a run. Calling `ctx.step('x', …)` twice with the same id returns the cached value the second time.
- `fn`'s return value must be JSON-serializable — it is stored in a `jsonb` column.
- Design `fn` to be idempotent if you use `replayFrom: 'scratch'`.
- An error inside `fn` marks the step failed and rethrows. If the run has retries left, the whole run re-enters `pending`; on the next tick, completed sibling steps stay memoized and only this step retries.

Step-level retry (separate from run-level retry, wraps just this step):

```ts
await ctx.step('fetch_profile', () => api.get(...), {
  retry: { attempts: 2, backoff: 'fixed', baseMs: 500 },
  timeoutMs: 30_000,
});
```

### `ctx.spawnChild(type, input, opts?)` — launch a child run

```ts
const child = await ctx.spawnChild(
  'process_facts',
  { emailIds },
  {
    closePolicy: ParentClosePolicy.Terminate, // default; children die if the parent does
    runAt: new Date(Date.now() + 5_000),       // optional delay
    priority: 10,
    tags: { triggeredBy: 'onboarding' },
  },
);
```

- `parent_run_id` and `root_run_id` are wired automatically.
- `closePolicy` is recorded on the child at spawn time; later changes to the parent do not retroactively rewrite it.
  - `ParentClosePolicy.Terminate` (default) — running children are cancelled when the parent reaches any terminal state.
  - `ParentClosePolicy.Cancel` — same effect, but the parent's `finished_at` is held until children finish transitioning.
  - `ParentClosePolicy.Abandon` — children are left running (fire-and-forget).
- Do not wrap `spawnChild` in a `ctx.step` — the child is its own memoization root. If you need cross-invocation idempotency on a child, put `dedupe` on the child job type.
- There is **no built-in "await child completion"** primitive. If you need sequencing, split the parent's logic: the parent spawns the child (with its own scope) and completes; a follow-up handler watches for child completion via `listForScope`.

## Kicking a job off from a use case

Inject the orchestrator token and call `start`:

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

- `start` returns the inserted `JobRun` immediately; the worker picks it up on its next poll.
- If `dedupe` matches an in-window prior run, `start` returns the existing run id — free idempotency for the caller.
- With `collisionMode: 'reject'`, `start` throws `JobCollisionError` synchronously — catch it in the use case.
- Pass `triggerSource: 'manual' | 'schedule' | 'event' | 'parent'` so the run's `trigger_source` is accurate for observability.

## Managing runs by entity — `IJobRunService`

`scope` on the decorator makes "everything for this account" queryable:

```ts
import { JOB_RUN_SERVICE, type IJobRunService } from '@shared/subsystems/jobs';

@Inject(JOB_RUN_SERVICE) private readonly runs: IJobRunService;

await this.runs.listForScope('account', accountId, { status: 'running' });
await this.runs.cancelForScope('account', accountId);      // cascades per close policy
await this.runs.rescheduleForScope('account', accountId, tomorrow);
```

The entity type is a plain string at the database layer; type safety comes from `satisfies ScopeEntityType` at the call site. `ScopeEntityType` is a generated union of every entity that declared `scopeable: true` in its YAML — re-run codegen after adding a new scopeable entity to refresh `@shared/jobs/scope-entity-type`.

## Common shapes

- **Fan-out** — parent `ctx.step`s a batch, then `ctx.spawnChild` per item with `ParentClosePolicy.Terminate`. Cancel the parent → children die.
- **Sequenced pipeline** — chain `ctx.step` calls in one handler (simplest), or split into dedicated handler types with `ParentClosePolicy.Abandon` so each hop is independently queryable and retryable.
- **Latest-wins loop** — `concurrency.collisionMode: 'replace'`, keyed by the entity id. A newer trigger cancels the incumbent.
- **Webhook ingestion** — `dedupe.key: (input) => input.externalId` collapses replays within the window, no app-level idempotency table needed.
- **Long batch with safe resume** — `replayFrom: 'last_checkpoint'` (the default) + one `ctx.step` per work unit → a crash only repeats unfinished work.

## Testing a handler

`@JobHandler` classes work inside `Test.createTestingModule` with the memory backend, which is behavior-parity with the production backend for claim order, collision modes, step memoization, cascade cancel, dedupe, and replay:

```ts
const moduleRef = await Test.createTestingModule({
  imports: [JobWorkerModule.forRoot({ mode: 'embedded', backend: 'memory' })],
  providers: [OnboardingHandler, /* ...deps */],
}).compile();
```

Then `orchestrator.start('onboarding', input)`, advance a few ticks, and assert on the stored runs and steps.

## When NOT to use a handler

- **Synchronous request/response** — if the caller awaits the result, write a use case, not a job.
- **Reacting to every domain event** — those flow through the events subsystem and (for durable async fanout) the bridge, not a direct handler. See the `events` and `bridge` skills.
- **Per-request rate limiting** — there is no built-in request rate-limit primitive in the core contract.
