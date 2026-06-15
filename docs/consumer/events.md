# Consumer Setup — Events subsystem

> Part of the [Consumer Setup](../CONSUMER-SETUP.md) reference, split out for focused reading. In-project coding agents get the same material (progressively disclosed) from the `events` skill under `.claude/skills/`.

## Events subsystem

The events subsystem (ADR-024) ships a transactional outbox, the `IEventBus`
protocol, Drizzle + Memory backends, and the generated `TypedEventBus` facade.
It is scaffolded into your project by the `subsystem install` command.

The event log always lives in Postgres (the Drizzle outbox) or in memory — it
never runs on BullMQ (ADR-041, option #2). BullMQ's role in an all-BullMQ stack
is the **jobs executor** (the jobs the events trigger run on BullMQ) and the
**scheduler/clock** (recurring `schedule:` events fire via a BullMQ Job
Scheduler) — selected by `events.scheduler.driver: bullmq`, *not* by an
`events.backend: bullmq`. See "Scheduler driver" below.

### Install

```bash
codegen subsystem install events
# or: bun /path/to/codegen-patterns/src/cli/index.ts subsystem install events
```

This copies the runtime files into `<paths.subsystems>/events/` (defaulting to
`shared/subsystems/events/`) and additionally:

- Injects an `events:` block into `codegen.config.yaml`:
  ```yaml
  events:
    backend: drizzle
    multi_tenant: false
    # pools: []  # optional: restrict this process's drain loop to specific lanes
  ```
- Writes `domain-events.schema.ts` via a Hygen template (the runtime file is
  skipped by `copyRuntime`). This template owns the scaffold-time `tenant_id`
  conditional — the column is emitted only when `events.multi_tenant: true`.
- Creates `<paths.subsystems>/events/generated/.gitkeep` so the directory
  exists in source control before `just gen-all` runs for the first time.

Switch the backend with `--backend memory` (useful in tests). The default is
`drizzle`. There is **no `bullmq` events backend** — the event log stays on the
Postgres outbox (or memory). The fire-and-forget Redis Pub/Sub backend was
removed (no history, bridge- and scheduler-incompatible — ADR-041), and is not
replaced: events are not transported over Redis. To run recurring `schedule:`
events on BullMQ's clock, set `events.scheduler.driver: bullmq` (the backend
stays `drizzle`) — see "Scheduler driver" below.

### Authoring events

Author one YAML file per event under `events/` at the repo root (sibling to
`entities/`):

```yaml
# events/contact_created.yaml
type: contact_created
direction: change
aggregate: contact
version: 1
payload:
  contact_id: { type: uuid }
  account_id: { type: uuid, nullable: true }
  created_by: { type: uuid }
```

See ADR-024 and `.claude/skills/events/event-codegen.md` for the full YAML
shape (directions, `source` / `destination`, pool overrides, entity `emits:`
integration). Regenerate the typed artifacts with:

```bash
just gen-all
```

This produces five files under `<paths.subsystems>/events/generated/`:
`types.ts` (the `AppDomainEvent` discriminated union), `schemas.ts` (Zod
payload schemas), `registry.ts` (the runtime metadata map), `bus.ts` (the
`TypedEventBus` facade), and `index.ts`.

### Register `EventsModule` in `AppModule`

```ts
import { EventsModule } from '@shared/subsystems/events/events.module';

@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    // ... other subsystems, GENERATED_MODULES, etc.
  ],
})
export class AppModule {}
```

`EventsModule` is `global: true`, so entity modules do not need to import it
individually. Options:

- `backend: 'drizzle' | 'memory'` — matches `events.backend` in your config for
  the default install; tests typically override to `'memory'`.
- `scheduler: { driver: 'poll' | 'bullmq' }` — which clock fires recurring
  `schedule:` events. Default `'poll'` (the in-process `setInterval`
  materializer). `'bullmq'` runs them via a BullMQ Job Scheduler. Orthogonal to
  `backend` — see "Scheduler driver" below.
- `multiTenant: true` — opt-in multi-tenancy (see below).
- `pools: ['events_change']` — restrict this process's drain loop to specific
  lanes. Typical split is one process per `events_inbound` / `events_change`
  / `events_outbound` so a slow outbound handler cannot stall change-event
  propagation. Undefined drains all pools.
- `redisUrl` / `queuePrefix` — only for `scheduler: { driver: 'bullmq' }` (the
  Redis connection the Job Scheduler uses; see below).

### Scheduler driver (ADR-041, option #2)

The **event log always lives on the Postgres outbox** (or memory). What BullMQ
can own is the **clock** for recurring `schedule:` events — not the event
transport. This is selected by `events.scheduler.driver`, which is **orthogonal**
to `events.backend` and `jobs.backend`: scheduling (when does a fact recur?) and
event transport (how is a fact stored and signaled?) are independent concerns.

```yaml
events:
  backend: drizzle            # event TRANSPORT — drizzle | memory (never bullmq)
  scheduler:
    driver: bullmq            # scheduler CLOCK — poll | bullmq (default: poll)
  extensions:
    bullmq:
      redis_url: redis://localhost:6379   # or env REDIS_URL (shared with jobs by default)
      queue_prefix: myapp                  # namespaces the events-scheduler queue on a shared Redis
```

- **`driver: poll`** (default) — the in-process `EventScheduler` `setInterval`
  loop materializes due ticks into the outbox (ADR-039). No Redis required.
- **`driver: bullmq`** — a BullMQ Job Scheduler fires the ticks (reconciled on
  boot, orphans pruned). On each tick it emits the **same** scheduled domain
  event into the **Drizzle outbox** (via `materializeScheduledEvent`), which then
  drains the normal way: `pg_notify` → bridge → job. The clock moves to BullMQ;
  the fact still lands in Postgres. Requires the `bullmq` peer dep
  (`npm install bullmq`) and Postgres (the outbox). Pairs naturally with
  `jobs.backend: bullmq` for an all-BullMQ stack — Drizzle owns the outbox,
  BullMQ owns the clock and the job execution.

`align: false` / `catchUp` schedules are **not supported** under
`driver: bullmq` (it is an epoch-aligned interval clock with no missed-slot
replay) — they fail loud at boot. Use `driver: poll` for those semantics.

> There is no `events.backend: bullmq`. An earlier draft carried events over a
> BullMQ wake queue; that was dropped (a Redis wake cannot be atomic with a
> Postgres commit, so it was slower and weaker than `pg_notify`). The event bus
> never runs on BullMQ.

### The three dispatch speeds

When you turn data into started work, there are exactly three sanctioned speeds
(typed as `DispatchMode = 'direct' | 'eager' | 'deliberate'`). Pick by the
**choice rule**: *if actionability is proven before the data reaches you →
`direct` or `eager`; if you must inspect state to decide → `deliberate`.*

| Speed | Call | What it does | Use when |
|---|---|---|---|
| **`direct`** | `IJobOrchestrator.start()` | enqueue a job, no event (1 `job_run` + enqueue, instant) | the source already proves the work is warranted (e.g. a Slack webhook payload) |
| **`eager`** | `IEventFlow.publishAndStart()` | event + job + `bridge_delivery`, in ONE tx (recorded AND started, ~instant) | you want the fact recorded and the work started together, in the request path, durably |
| **`deliberate`** | `IEventFlow.publish()` + bridge | event recorded; jobs spawned async by the bridge at a bounded pull rate | you must inspect state to decide; durable async fanout; the flood-resistant / storm path |

A **raw `queue.add` / Postgres-free ephemeral path is not a public option** —
every sanctioned speed writes to Postgres (a `job_run` and/or a `domain_events`
row), which is the durable terminus that makes the system flood-resistant.
Pushing work into a transport with no durable terminus is the failure mode the
three-speed surface exists to prevent.

(Declaring a per-trigger speed in YAML — `dispatch: eager | deliberate` on an
event-arm trigger — is a proposed fast-follow; see `docs/specs/DISPATCH-1.md`.
Today you pick the speed by choosing which call to make.)

### `TypedEventBus` vs. raw `EVENT_BUS`

Prefer injecting `TypedEventBus` in use cases — its `publish<T>()` overload
enforces the typed payload shape from the generated registry and stamps
`metadata.pool` / `metadata.direction` / `metadata.version` from the same
source.

```ts
import { TypedEventBus, TYPED_EVENT_BUS } from '@shared/subsystems/events';

constructor(
  @Inject(TYPED_EVENT_BUS) private readonly events: TypedEventBus,
  // ...
) {}

async execute(input: CreateContactInput): Promise<Contact> {
  return this.db.transaction(async (tx) => {
    const contact = await this.contacts.create(input, tx);
    await this.events.publish('contact_created', contact.id, {
      contactId: contact.id,
      accountId: contact.accountId,
      createdBy: input.actorId,
    }, { tx });
    return contact;
  });
}
```

The raw `EVENT_BUS` token (`IEventBus`) is still exported for use cases that
predate the typed facade or that need to publish types not in the registry
(e.g. a forwarder that proxies events from an external source). New code
should prefer `TypedEventBus`.

### Multi-tenancy opt-in

Flip `events.multi_tenant: true` in `codegen.config.yaml`, then re-run
`subsystem install events --force` to re-emit the schema with a `tenant_id`
column, and cut an Atlas migration (see [Atlas migration workflow](../CONSUMER-SETUP.md#atlas-migration-workflow)).
Also pass `multiTenant: true` to `EventsModule.forRoot(...)` so
`TypedEventBus.publish` enforces the column at publish time:

```ts
EventsModule.forRoot({ backend: 'drizzle', multiTenant: true });
```

When `multiTenant: true` and `opts.metadata.tenantId` is missing from a
`publish` call, the facade throws `MissingTenantIdError` naming the event
type. Explicit `null` is permitted for tenant-less background events.

The first-class routing columns that land on `domain_events` (reviewed in the
Atlas diff) are `pool`, `direction`, `tier` (always emitted; `'domain'` |
`'audit'`, defaulting to `'domain'`), and — when `multi_tenant: true` —
`tenant_id`, plus the supporting indexes and the
`domain_events_tier_routing_check` constraint. `tier` is always present
regardless of the tenancy flag; only `tenant_id` is conditional. No runtime
toggle exists for enabling tenancy after initial install; always pair the
config flip with a scaffold re-run and an Atlas migration.

### Entity `emits:` integration

Entities can opt into typed auto-emission by declaring `emits: [...]` in
their YAML. Generated use cases then call `TypedEventBus.publish(type, ...)`
inside the domain transaction. See ADR-024 and the events skill
(`.claude/skills/events/event-codegen.md`) for the shape and constraints.
