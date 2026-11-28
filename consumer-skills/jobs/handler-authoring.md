<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Authoring a job

How to declare a `@pattern-stack/jobs` job in a generated app, start it, and what its code may assume. Read the
`jobs` `SKILL.md` first. The engine's rules in full (waits, gates, children, map steps, values, determinism) are in
`node_modules/@pattern-stack/jobs/JOBS_CONTRACT.md`.

## A job file

```ts
// src/jobs/send-welcome-email.job.ts
import { defineJob, step } from '@pattern-stack/jobs';
import { z } from 'zod';

export const sendWelcomeEmail = defineJob({
  key: 'send_welcome_email',
  input: z.object({ contactId: z.string() }),
  output: z.object({ sent: z.boolean() }),
  limits: { maxItems: 1, maxUsd: 1, maxCalls: 10, maxDurationMs: 60_000 },
  steps: (s) =>
    s
      .add('load', step({ run: ({ input }) => ({ email: lookUp(input.contactId) }) }))
      .add('send', step({
        limiter: 'interactive',
        retry: { initialIntervalMs: 1_000, backoffCoefficient: 2, maximumAttempts: 3 },
        run: async ({ load }) => ({ sent: await deliver(load.email) }),
      })),
});
```

- **`key`** is the job's name everywhere (runs, triggers, `JobStarter.start`). Keep it stable.
- **Steps run in order**; each reads the input and every earlier step's output by name, typed. The last step's
  output is the job's, checked by `output`.
- **`limits`** caps one run (items, spend, calls, duration). A job without it can only be started with an explicit
  `budget: { maxItems }`; the bridge passes none, so a bridge-triggered job needs `limits`.
- **`limiter`** is the pool (see `pools-and-ordering.md`). A step with none takes no slot.
- **`retry`** is Temporal's shape. A throttle (a `ThrottledError`, or a provider 429) never uses an attempt.
- Run `codegen entity new` after adding the file: the generated `<generated>/jobs.ts` lists the export and
  `JobsEngineModule` registers it at boot.

Beyond `step`: `mapStep` (one function over many keyed items, results cached per key), `waitFor({ gate })` /
`waitFor({ signal })` (park until a condition or a person), `children` / `child` (start runs of other jobs and wait).
See the contract.

## Starting a run

```ts
import { JobStarter } from '@shared/subsystems/jobs';   // package mode: '@pattern-stack/codegen/runtime/subsystems/jobs/index'

@Injectable()
export class SignupUseCase {
  constructor(private readonly jobs: JobStarter) {}

  async execute(contactId: string, tenantId: string, tx: DrizzleTransaction) {
    const { run } = await this.jobs.start('send_welcome_email', { contactId }, { tenantId, dedupeKey: contactId }, tx);
    return run.id;
  }
}
```

- With `tx`, the run is created in your transaction and the executor's open-run sweep picks it up after the commit
  (about a second). Without it, the run is submitted to this process's executor at once.
- **`tenantId`** is the run's; omit it (or pass `null`) for `SYSTEM_TENANT`.
- **`dedupeKey`**: at most one open run per tenant, job and key. What a second start does is `collision`: `join`
  (default, returns the open run), `queue` (a new run held until the ones ahead end), `replace` (cancels the open
  one). `dedupeWindowMs` makes a start shortly after a run ended return that run too.
- To publish an event and start a job in one transaction, use `eventFlow.publishAndStart` (the `bridge` skill).
- The operator view of runs (list, read, cancel, pause, resume, signal) is `JobsService` from
  `@pattern-stack/jobs/nest`.

## What a step's code may assume

- It runs inside the repositories' requester scope for the run's tenant, as superuser on the user axis:
  entity-repository reads and writes inside a step are scoped to that tenant with no plumbing. `SYSTEM_TENANT` is the
  null tenant partition.
- Its input and earlier outputs are plain JSON (no `Date`; times are ISO strings), at most 1 MB each.
- It may run again after a crash before its output was recorded: make side effects idempotent (a dedupe key at the
  provider, an upsert).
- It reaches the app's services through a **job factory** (below), never by importing an instance.

## A job that needs the app's services: `jobFactory`

```ts
import { defineJob, injected, jobFactory, step } from '@pattern-stack/jobs';

export const reindex = jobFactory({
  deps: {
    search: SearchService,                                             // a class: its Nest provider
    sync: injected<ExecuteIntegrationUseCase<Doc>>('DOCUMENT_INTEGRATION_USE_CASE__DRIVE'), // a string / symbol token
  },
  create: ({ search, sync }) =>
    defineJob({ key: 'document.reindex', /* … */ steps: (s) => s.add('run', step({ run: () => sync.execute(/* … */) })) }),
});
```

The registry lists it like any job; `JobsEngineModule` resolves each dependency from any of the app's modules
(through `ModuleRef`), and a dependency no module provides stops the boot naming the job and the dependency. A
dependency is an object, and handed as a stand-in that reaches the instance on first use: use it inside a step,
never while `create` builds the job. In a test, call `reindex.create({ search: fake, sync: fake })`.

## YAML jobs (`definitions/jobs/<type>.yaml`)

`codegen entity new` emits `<type>.job.generated.ts` (`@generated`: the input, each arm's detection config, and
`define<Type>Job(arms)`, one step per arm on the YAML `pool`) and, once, `<type>.job.ts`, where you write the arm
bodies: `export const <type>Job = jobFactory({ deps: { … }, create: (deps) => define<Type>Job({ <arm>: async (ctx) => { … } }) })`,
naming in `deps` the provider's integration use case the arms call. The YAML's `triggers` reach
the bridge registry declaratively. A YAML job needs the integration subsystem; an invalid job YAML stops
`entity new`, naming the file.
