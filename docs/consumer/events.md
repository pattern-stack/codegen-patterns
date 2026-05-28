# Consumer Setup — Events subsystem

> Part of the [Consumer Setup](../CONSUMER-SETUP.md) reference, split out for focused reading. In-project coding agents get the same material (progressively disclosed) from the `events` skill under `.claude/skills/`.

## Events subsystem

The events subsystem (ADR-024) ships a transactional outbox, the `IEventBus`
protocol, Drizzle + Memory backends, and the generated `TypedEventBus` facade.
It is scaffolded into your project by the `subsystem install` command.

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

Switch the backend with `--backend memory` (useful in tests); the default is
`drizzle`. Only `drizzle | memory` are offered by the scaffold — the runtime
still includes a `RedisEventBus`, but Redis is not a scaffolded default in
Phase 1.

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

- `backend: 'drizzle' | 'memory' | 'redis'` — matches `events.backend` in your
  config for the default install; tests typically override to `'memory'`.
- `multiTenant: true` — opt-in multi-tenancy (see below).
- `pools: ['events_change']` — restrict this process's drain loop to specific
  lanes. Typical split is one process per `events_inbound` / `events_change`
  / `events_outbound` so a slow outbound handler cannot stall change-event
  propagation. Undefined drains all pools.

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
