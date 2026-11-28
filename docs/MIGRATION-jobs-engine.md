# Migrating a generated app to the `@pattern-stack/jobs` engine (JOBS-3)

The jobs subsystem of ADR-022 (`@JobHandler` classes, `JobsDomainModule`, `JobWorkerModule`, the orchestrator and
its `job` / `job_run` / `job_step` tables) is gone. Generated apps run jobs on `@pattern-stack/jobs`, a workspace
package in this repo (`packages/jobs`, spec `docs/specs/JOBS-3.md`): a job is a `defineJob` value, the store is the
app's Postgres (the package's own tables), and an in-process executor advances runs, with a lease so two replicas
never advance one run at once. The event bridge (ADR-023) starts a trigger's run in the event's own transaction.

An app generated before this change keeps compiling against nothing: every import of the old jobs runtime breaks.
To upgrade it:

## 1. Dependencies

```bash
bun add @pattern-stack/jobs        # the runtime and the generated code import it in both runtime modes
```

`@opentelemetry/api` comes with it. `bullmq` is no longer a peer of `@pattern-stack/codegen`; the in-process
executor needs no Redis.

## 2. `codegen.config.yaml`

The `jobs:` block is smaller. These keys are now errors that name themselves and point here:

| Removed | Instead |
|---|---|
| `jobs.backend` | Delete it. The store is always the app's Postgres. |
| `jobs.extensions` (`drizzle.listen_notify`, `drizzle.poll_interval_ms`, `bullmq.*`) | `jobs.poll_interval_ms`, `jobs.open_sweep_every`. There is no LISTEN wake or BullMQ option. |
| `jobs.worker_pools`, `jobs.all_pools` | Delete them. Every executor runs every pool. |
| `jobs.pools.<name>.queue`, `.reserved` | Delete them. A pool is a limiter named by its key; there are no reserved `events_*` pools. |
| `jobs.multi_tenant` | Delete it. A run's tenant is the one its start names (`JobStarter.start({ tenantId })`; the bridge passes the event's); none is `SYSTEM_TENANT`. |
| `entity.scopeable` (entity YAML) | Delete it. The engine has no job scopes. |

What stays: `jobs.worker_mode` (`embedded`, the default, or `standalone`) and `jobs.pools`,
where each entry is now `{ concurrency, description? }`: a limiter of that name whose `concurrency` is its in-flight
cap. `interactive` (20) and `batch` (5) always exist; an entry re-caps one or adds your own. A step names its pool
as `step({ limiter: '<name>' })`; a step naming a pool with no entry stops the boot. Priority is a pool: work that
must not wait behind other work gets a pool nothing else fills. New: `jobs.version_grace_ms` (how long a job's old
version keeps its open runs after a deploy bumps it).

## 3. Jobs: `@JobHandler` class → `defineJob` value

Before:

```ts
@JobHandler<{ contactId: string }>('send_welcome_email', {
  pool: 'interactive',
  triggers: [{ event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) }],
})
export class SendWelcomeEmailJob extends JobHandlerBase<{ contactId: string }, void> {
  async run(ctx) { await ctx.step('send', () => this.mailer.send(ctx.input.contactId)); }
}
```

After (`src/jobs/send-welcome-email.job.ts`):

```ts
import { defineJob, step } from '@pattern-stack/jobs';
import { jobTriggers } from '@pattern-stack/codegen/runtime/subsystems/bridge/index'; // vendored: '@shared/subsystems/bridge'
import { z } from 'zod';

export const sendWelcomeEmail = defineJob({
  key: 'send_welcome_email',
  input: z.object({ contactId: z.string() }),
  output: z.object({ sent: z.boolean() }),
  limits: { maxItems: 1, maxUsd: 1, maxCalls: 10, maxDurationMs: 60_000 },
  steps: (s) => s.add('send', step({ limiter: 'interactive', run: async ({ input }) => ({ sent: await send(input.contactId) }) })),
});

export const sendWelcomeEmailTriggers = jobTriggers('send_welcome_email', [
  { event: 'contact_created', map: (e) => ({ contactId: e.aggregateId }) },
]);
```

- Every `export const X = defineJob(...)` under the jobs directory (`<backend_src>/jobs`) is listed in the generated
  `<generated>/jobs.ts`, which the subsystem barrel hands `JobsEngineModule`. Two exports with one name are a
  generation error.
- Triggers move out of the decorator into `jobTriggers('<key>', [...])` beside the job. `map` and `when` are copied
  into the generated bridge registry, so they must be self-contained arrow functions, as before.
- **A job whose steps need the app's services is a factory** (what a handler got by constructor injection):
  `export const x = jobFactory({ deps: { sync: injected<ExecuteIntegrationUseCase<…>>('<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>'), clock: Clock }, create: ({ sync, clock }) => defineJob({ … }) })`.
  A dependency is named by its class or `injected<T>(token)`; the app resolves each from any module at boot (a
  missing one stops the boot, naming it). Use a dependency inside a step, never while building the job.
- A step's code runs inside the repositories' requester scope, entered from the run's own tenant (`tenantRunScope`;
  `SYSTEM_TENANT` is the null tenant partition, the user axis is `superuser`), as the old worker did.

YAML jobs (`definitions/jobs/*.yaml`, RFC-0005) are emitted the new way: `<type>.job.generated.ts` holds
`define<Type>Job(arms)`, and the emit-once `<type>.job.ts` is `export const <type>Job = define<Type>Job({ … })`.
**An existing emit-once `<type>.job.ts` is not rewritten**: replace its `@JobHandler` class with that one export,
moving each `runArm<Arm>` body into the matching arm function. The YAML keys `scope`, `concurrency`, `timeoutMs`,
`replayFrom` and `dedupe.key` are removed; `collision: join | queue | replace` and `dedupe: { windowMs }` are new.

## 4. Starting runs

| Before | After |
|---|---|
| `@Inject(JOB_ORCHESTRATOR) orchestrator: IJobOrchestrator` | `jobs: JobStarter` (from the jobs subsystem index) |
| `orchestrator.start(type, input, { tenantId, parentRunId }, tx?)` | `jobs.start(key, input, { tenantId, dedupeKey, collision, trigger }, tx?)` |
| `eventFlow.publishAndStart(event, jobType, input, { tenantId, parentRunId })` | `eventFlow.publishAndStart(event, jobKey, input, { tenantId, dedupeKey })` |
| a child run via `parentRunId` | a step's `children(...)` in the parent job |

`start` inside a transaction (`tx`) creates the run in that transaction; the executor's open-run sweep finds it
after the commit. Outside one, the run is submitted to this process's executor at once. A run with no tenant is
`SYSTEM_TENANT`'s.

## 5. The standalone worker

`src/worker.ts` is emit-once, so an old one is not rewritten; `codegen subsystem install jobs` prints the edit when
it finds one. The new worker boots the app's own `AppModule` with no HTTP listener and starts the executor:

```ts
import { JOBS_EXECUTOR } from '@pattern-stack/jobs/nest';
const app = await NestFactory.createApplicationContext(AppModule);
await app.get(JOBS_EXECUTOR).start();   // replaces WorkerAppModule + JobWorkerModule.forRoot(jobWorkerOptions)
```

Or delete `src/worker.ts` and re-run `codegen subsystem install jobs`.

## 6. Regenerate and migrate the database

```bash
codegen update                 # re-vendor the jobs and bridge runtime (vendored mode)
codegen entity new --all       # the subsystem barrel, app-config, the job registry, YAML jobs
```

Then generate a migration. The job tables are new (`job_runs`, `job_run_steps`, `job_run_items`, `job_run_chunks`,
`job_run_events`, `job_run_values`, `job_item_results`, all `timestamptz`, tenant `text`), re-exported by the
schema barrel. The old `job`, `job_run`, `job_step` tables and their enums are no longer declared: drop them once no
run in them matters (the engine does not read them). `bridge_delivery.wrapper_run_id` is gone.

## 7. Observability

`IObservability.getPoolDepths`, `getRecentFailedJobs` and `listJobRuns` are removed, and the correlation timeline
lists events only. `JobsService` (`@pattern-stack/jobs/nest`) is the operator view of runs: list, read, cancel,
pause, resume and signal, with its access rules.
