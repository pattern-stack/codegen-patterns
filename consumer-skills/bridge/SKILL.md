---
name: bridge
description: Load when wiring the event-to-job bridge or authoring `@JobHandler.triggers` in a project that ran `codegen subsystem install bridge`. Triggers include declaring `triggers:` on a `@JobHandler`; deciding between an in-process subscriber, `eventFlow.publishAndStart`, and a bridge trigger; registering `BridgeModule.forRoot()` in `app.module.ts`; wiring the reserved `events_*` pools via `BRIDGE_RESERVED_POOLS`; same-aggregate ordering with a `concurrency` key; or running `codegen events consumers <type>` to find who reacts to an event.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Event-to-Job Bridge

The bridge is the durable, typed, observable path from *"an event was
published"* to *"a job was started"* in your app. It is its own subsystem —
the combiner between the `events` and `jobs` subsystems, owned by neither. You
opt into it by running `codegen subsystem install bridge`, which vendors the
runtime into `<paths.subsystems>/bridge/` (imported as
`@shared/subsystems/bridge`) and adds a `bridge:` block to
`codegen.config.yaml`.

Use this skill when you want one event to fan out to one or more durable async
jobs, authored by teams that don't know about each other. If you only need a
cheap in-process reaction, or a request-path job the caller already knows by
name, you probably want a lower tier instead — see the decision table below.

## Mental model: three tiers of event-driven work

You pick the tier by use case. The bridge is Tier 3.

| Tier | Mechanism | Durability | Latency | Use for |
|---|---|---|---|---|
| 1. Subscribe | `@OnEvent('x.y')` / `IEventBus.subscribe()` in-process | None (at-most-once) | ~ms | metrics, cache busts, logs |
| 2. Direct invoke | `eventFlow.publishAndStart(event, jobType, input)` | Yes (caller's tx) | ~1 poll cycle | request-path work, caller knows the job |
| 3. Bridge | `@JobHandler({ triggers: [{ event, map, when }] })` | Yes (outbox + ledger) | 2–3 poll cycles | durable async fanout, decoupled authors |

Tier 1 is events-only and never touches the bridge. Tier 2 and Tier 3 both
flow through the bridge at runtime — the difference is *who declares the
link*. In Tier 2 the caller writes the `publishAndStart` call explicitly; in
Tier 3 the job declares `triggers:` and the link fires automatically whenever
the event is published anywhere.

**How a trigger actually runs (Tier 3).** When the events outbox drain claims
a `domain_events` row, it inserts — in one per-event transaction — one ledger
row in `bridge_delivery` plus one *wrapper* job in a reserved `events_*` pool,
per matched trigger. A normal job worker claims the wrapper. The wrapper reads
the ledger, evaluates your `when:` predicate, applies your `map:` function, and
calls the orchestrator to start your real job in *its* declared pool, parented
to the wrapper so cascade-cancel works. Then it marks the delivery `delivered`.
The reserved `events_*` pools thus host cheap wrappers (high concurrency); your
own pools host the actual work (concurrency tuned to its scarce resource).

**The ledger is the source of truth.** `bridge_delivery` has a
`UNIQUE (event_id, trigger_id)` constraint. That is the idempotency primitive
— it dedups outbox replay, and it dedups the case where a caller uses
`publishAndStart` AND the same job also declares a matching `triggers:` entry
(exactly one execution per event/trigger pair, whichever path got there first).

## Install and wiring

```bash
codegen subsystem install bridge
```

Config block (`codegen.config.yaml`):

```yaml
bridge:
  backend: drizzle       # 'drizzle' (production) or 'memory' (tests)
  multi_tenant: false    # pair with BridgeModule.forRoot({ multiTenant: true })
```

Register the module in `app.module.ts`:

```ts
import { BridgeModule } from '@shared/subsystems/bridge';

BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),
```

### Wire the reserved `events_*` pools

The bridge wrappers run in three reserved pools — `events_inbound`,
`events_change`, `events_outbound`. A worker process must actually *drain* them,
or wrappers sit `pending` forever (and `BridgeModule` fails fast at boot). The
exported `BRIDGE_RESERVED_POOLS` is the list of those three pool names — spread
it into the active-pools list of your `JobWorkerModule.forRoot` (see the
`subsystems` skill for the full wiring + order):

```ts
import { BRIDGE_RESERVED_POOLS } from '@shared/subsystems/bridge';
import { JobWorkerModule } from '@shared/subsystems/jobs';

JobWorkerModule.forRoot({
  mode: 'embedded',
  backend: 'drizzle',
  // active pool names this worker drains — include the reserved lanes:
  pools: ['interactive', 'batch', ...BRIDGE_RESERVED_POOLS],
}),
```

Pool *definitions* (concurrency per lane) live in `codegen.config.yaml` under
`jobs.pools`, not in `forRoot`; `JobWorkerModule.forRoot({ pools })` only names
which lanes this process drains. (Alternatively, `JobWorkerModule.forRoot({
allPools: true })` drains every pool including the reserved ones — that's what
the standalone `worker.ts` uses.) Wrappers are cheap (read ledger → evaluate
`when:` → start the user job → update ledger), so the reserved lanes can run at
high concurrency safely.

## Authoring triggers

Triggers are **job-owned**. Declare them on the `@JobHandler` decorator of the
job you want to run — never on the event side.

```ts
@JobHandler<SendWelcomeEmailInput>('send_welcome_email', {
  pool: 'outbound_email',
  triggers: [
    {
      event: 'user.created',
      map: (e) => ({ userId: e.aggregateId, email: e.payload.email }),
      when: (e) => e.payload.email !== undefined,  // optional
    },
  ],
})
export class SendWelcomeEmailJob extends JobHandlerBase<SendWelcomeEmailInput> {
  // ...
}
```

`map:` and `when:` are typed TS callbacks — they typecheck against the payload
type of the event you named. They must be **self-contained**: no calls to
project helpers, services, or imports. The codegen inlines the arrow body
verbatim into the generated bridge registry, so anything outside the arrow's
own scope will not be in scope there.

After authoring or changing a trigger, regenerate the registry
(`codegen entity new --all` or your project's gen-all task). Unknown event
types referenced in `triggers[].event` fail the build at generation time —
that is the build-time validation against the event registry, and it is the
primary safety net.

If `when:` returns false at runtime, the wrapper records the delivery as
`skipped` (with a reason) and does not start your job.

## Ordering

**The default configuration gives parallelism, not ordering.** Two events of
the same type may be processed concurrently; same-aggregate ordering is NOT
guaranteed out of the box. Pick the knob that matches your real requirement:

1. **`concurrency` key on the user job** *(recommended when ordering matters)*
   — granular per-aggregate serialization, parallelism preserved across
   unrelated aggregates. The `key` callback receives the job input:

   ```ts
   @JobHandler<ProvisionInput>('provision_workspace', {
     concurrency: { key: (input) => input.accountId, collisionMode: 'queue' },
     triggers: [/* ... */],
   })
   ```

2. **`events_<direction>` pool `concurrency: 1`** *(blunt)* — serializes
   **every** wrapper in that direction, i.e. every bridge fanout for that
   direction end to end. Simplest config, highest throughput cost. Use only
   when every event in the direction genuinely needs strict order.

## When NOT to use the bridge

The bridge adds 2–3 outbox poll cycles of latency (typically 1–3 s). If you
need request-path durability at lower latency and the caller already knows the
job, use the `IEventFlow` facade directly (Tier 2 — runs off the next poll
cycle, in the caller's transaction):

```ts
constructor(private eventFlow: IEventFlow) {}

async signup(input: SignupInput, tx: Tx): Promise<void> {
  await this.eventFlow.publishAndStart(
    'user.created',
    'provision_workspace',
    { userId: input.id },
    { tx },
  );
}
```

`IEventFlow` exposes exactly two verbs: `publish()` and `publishAndStart()`.
All request-path publishing goes through this facade, not through `IEventBus`
directly. Tier 1 subscribers stay declarative (`@OnEvent`) and bypass it.

Decision table:

| Need | Tier | Pattern |
|---|---|---|
| Cheap in-process reaction (metrics, cache bust) | 1 | `@OnEvent('x.y')` or `IEventBus.subscribe` |
| Request-path durable, caller knows the job | 2 | `eventFlow.publishAndStart(...)` |
| Async fanout, decoupled authors, multiple handlers per event | 3 | `@JobHandler.triggers[]` (the bridge) |

## Discovering fanout: `codegen events consumers <type>`

```bash
codegen events consumers user.created
```

Prints a greppable report with all three tiers and file:line citations:

```
Event: user.created
Tier 3 — Bridge triggers (2):
  - send_welcome_email#0     (src/jobs/send-welcome-email.job.ts:14)
  - provision_workspace#0    (src/jobs/provision-workspace.job.ts:18)
Tier 2 — Direct invoke via publishAndStart (1):
  - src/use-cases/signup.uc.ts:42
Tier 1 — Subscribers (1):
  - MetricsListener.onCreate @OnEvent('user.created') at src/observability/metrics.ts:28
```

Unknown event types print a suggestion-bearing warning to stderr but the
command still exits 0. If the scan finds zero `publishAndStart` call sites but
`EventFlowService` exists in the codebase, a fallback warning prints — the AST
scan can miss non-standard injection (property injection, dynamic dispatch);
grep for `publishAndStart` to verify Tier 2 manually.

## Multi-tenancy

Set `multi_tenant: true` in the config block and pass
`BridgeModule.forRoot({ backend: 'drizzle', multiTenant: true })`. When on,
three write-side sites throw `MissingTenantIdError` if `tenantId === undefined`
(explicit `null` passes, for deliberate cross-tenant work): the
`publishAndStart` request-path entry, the wrapper handler entry, and the
delivery-repo write boundary. Event metadata carries `tenantId` from the typed
event bus; the bridge threads it into the job's `tenant_id` when it starts your
job. Your bridge, events, and jobs configs must all agree on the flag.

## Renaming or removing a trigger

The generated `trigger_id` is `<jobType>#<index>` — stable across generations,
so replays resolve to the same ledger row. Renaming a `@JobHandler('<name>')`
changes that id, so in-flight `pending` deliveries with the old `trigger_id`
become orphans: the wrapper detects the missing registry entry, marks the
delivery `skipped` with `skip_reason='trigger_unregistered'`, and stops. No
auto-migration, no replay. If you need the old deliveries to run under the new
name, drain the queue before deploying the rename.

## Do not

- **Do not collapse the three tiers** into "the bridge is the only path."
  Tier 1 stays valid for cheap in-process reactions; Tier 2 is the request-path
  durable option; Tier 3 is async fanout. The right tool depends on durability
  and latency.
- **Do not put your `@JobHandler` classes on reserved `events_*` pools.**
  Module init rejects it. Those pools host framework wrappers only; your work
  lives in a pool you declare.
- **Do not declare triggers on the event side.** Triggers are job-owned. The
  events subsystem stays zero-knowledge about jobs.
- **Do not reference helpers, services, or imports inside `map:` / `when:`.**
  They are inlined verbatim into the generated registry and must be
  self-contained.
- **Do not skip regenerating the registry** after changing a trigger. The
  build-time validation against the event registry only runs at generation; a
  stale registry silently drifts from your decorators.
- **Do not expect ordering from the default config.** Add a `concurrency` key
  (granular) or set a reserved pool's `concurrency: 1` (blunt) when
  same-aggregate order matters.
- **Do not drop `tenantId`** when `multi_tenant: true`. Missing tenant context
  throws `MissingTenantIdError` at the write-side enforcement sites.
