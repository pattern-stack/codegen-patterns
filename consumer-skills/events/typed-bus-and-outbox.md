<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Publishing, the Outbox, and Subscribing

How to publish events transactionally, how the outbox drain works, how to subscribe, idempotency, and how to wire `EventsModule` into your app. Read the `events` `SKILL.md` first for the mental model and `authoring-events.md` for the YAML shape.

## Publishing inside a transaction

Every use case that mutates domain state and emits an event **must pass the transaction** so the event row is part of the same atomic write. Inject the typed facade:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { TypedEventBus, TYPED_EVENT_BUS } from '@shared/subsystems/events';

@Injectable()
export class CreateContactUseCase {
  constructor(
    @Inject(TYPED_EVENT_BUS) private readonly events: TypedEventBus,
    private readonly db: DrizzleClient,
    private readonly contacts: ContactRepository,
  ) {}

  async execute(input: CreateContactInput): Promise<Contact> {
    return this.db.transaction(async (tx) => {
      const contact = await this.contacts.create(input, tx);
      await this.events.publish(
        'contact_created',
        contact.id,
        {
          contactId: contact.id,
          accountId: contact.accountId,
          createdBy: input.actorId,
        },
        { tx }, // ← the outbox guarantee
      );
      return contact;
    });
  }
}
```

`TypedEventBus.publish(type, aggregateId, payload, opts?)`:
- Validates the payload against the generated Zod schema at the boundary (skippable with `CODEGEN_EVENT_VALIDATE=off`).
- Stamps `id`, `occurredAt`, and `metadata.pool` / `metadata.direction` / `metadata.version` from the registry.
- Inserts one `domain_events` row using `opts.tx` if provided, else the top-level connection.

**Dropping `tx` silently detaches the event.** The backend uses `tx ?? db`, so without `tx` the insert runs outside your domain transaction — the domain write can commit while the event insert fails independently. There is no compile-time guard; treat passing `tx` as non-negotiable.

### Raw `EVENT_BUS` for untyped publishes

The raw port stays available for forwarders that publish types not in the registry (e.g. proxying an external source):

```ts
import { EVENT_BUS, type IEventBus } from '@shared/subsystems/events';

@Inject(EVENT_BUS) private readonly bus: IEventBus;

await this.bus.publish(
  { id, type, aggregateId, aggregateType, payload, occurredAt },
  tx,
);
```

New code should prefer `TypedEventBus`.

## The outbox table and drain loop

`domain_events` is the outbox. Key columns: `id` (UUID, the idempotency key), `type`, `aggregate_id`, `aggregate_type`, `payload` (jsonb), `occurred_at`, `processed_at`, `status` (`pending | processed | failed`), `error`, `metadata`, and first-class `pool` / `direction` / `tier` columns (populated from `metadata` at insert so the drain can filter by lane without unpacking JSON). `tier` (`'domain'` | `'audit'`, default `'domain'`) is always emitted; the `domain_events_tier_routing_check` constraint enforces that `tier='audit'` rows have null `pool`/`direction`. `tenant_id` is the only conditional column — emitted only under `events.multi_tenant: true`.

The drain loop (Drizzle backend):
1. Claims a batch (default 50) of `pending` rows with `FOR UPDATE SKIP LOCKED`, optionally filtered by pool, ordered by `occurred_at ASC`. `SKIP LOCKED` lets multiple worker processes drain concurrently without double-dispatching.
2. For each row, invokes every registered handler for `event.type`.
3. On success: `status='processed'`, `processed_at=now()` — in the same transaction that locked the row, so nothing can strand half-claimed.
4. On failure: retries up to 3 attempts; if still failing, `status='failed'` with the error. No automatic retry after that — a permanently broken handler does not burn a worker forever.

Default poll interval is 1s, so there is a ~1s latency floor. There is no stale-event sweeper — it is unnecessary because the lock lifetime equals the dispatch transaction.

## Subscribing

```ts
import { TypedEventBus, TYPED_EVENT_BUS } from '@shared/subsystems/events';

@Inject(TYPED_EVENT_BUS) private readonly events: TypedEventBus;

this.events.subscribe('contact_created', async (event) => {
  // event is narrowed to ContactCreatedEvent — event.payload.contactId is typed
  await this.readModel.upsert(event.payload.contactId);
});
```

`subscribe<T>()` returns an unsubscribe function. Subscriptions are **per-process** in the Drizzle backend — a subscriber registered in process A does not receive events drained in process B. In a multi-process deployment, each process runs its own subscribers.

**Keep subscribers fast.** The drain dispatches a batch serially; a subscriber doing HTTP or other slow I/O stalls the whole batch. For anything slow, durable, or that needs retry, do not work inline — enqueue a job. For durable async fanout from an event to a job, use the `bridge` skill; for fire-and-forget cheap reactions (metrics, cache busts), an in-process subscriber is fine.

## Idempotency

The event `id` is the dedup token. Handlers can redeliver (a process can crash between dispatch and the `processed` update), so:

- **Make handlers idempotent** — safe to call twice with the same `event.id`. A common pattern is a small "seen ids" table the handler checks first.
- **For inbound webhooks, reuse the source system's id.** If Stripe sends `evt_123` twice, deriving the outbox `id` from `evt_123` means the second insert hits `ON CONFLICT (id) DO NOTHING` instead of creating a duplicate.
- **Never regenerate `id` on replay/backfill** — compute it deterministically from the source event.

## Ordering

- Same aggregate, single worker: FIFO (`ORDER BY occurred_at ASC`). With multiple workers, same-aggregate ordering holds only probabilistically.
- Across aggregates: not strictly ordered — treat it as roughly wall-clock.

If a handler depends on strict cross-aggregate ordering, reshape it to tolerate independent timelines.

## Wiring `EventsModule`

Register once in `AppModule`; it is `global: true`, so entity modules need not import it individually:

```ts
import { EventsModule } from '@shared/subsystems/events';

@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    // ...
  ],
})
export class AppModule {}
```

`forRoot` options:
- `backend: 'drizzle' | 'memory' | 'redis'` — match `events.backend` in your config. Tests override to `'memory'`.
- `multiTenant: true` — opt-in multi-tenancy (see below).
- `pools: ['events_change']` — restrict this process's drain loop to specific lanes. A common split is one process per direction so a slow outbound handler cannot stall change-event propagation. Undefined drains all lanes.

### Backend notes

- **`drizzle`** (default) — Postgres outbox; transactional, crash-safe; ~1s polling floor.
- **`memory`** — synchronous, in-process, for tests. `publish` dispatches immediately (no `tx` semantics); exposes `publishedEvents[]`, `publishedEventsForPool()`, `publishedEventsForDirection()`, and `clear()` for assertions. Because dispatch is synchronous, tests need no timers.
- **`redis`** — present but not a scaffold default. **It does not participate in the Drizzle transaction** — passing `tx` is a silent no-op, so you lose the outbox guarantee. Only reach for it after measuring an actual throughput bottleneck (the Drizzle outbox tops out around ~1000 events/s).

### Multi-tenancy

Set `events.multi_tenant: true` in config, re-run `codegen subsystem install events --force` to re-emit the schema with a `tenant_id` column (then cut a migration), and pass `multiTenant: true` to `EventsModule.forRoot(...)`:

```ts
EventsModule.forRoot({ backend: 'drizzle', multiTenant: true });
```

When on, `publish` throws `MissingTenantIdError` (naming the event type) if `opts.metadata.tenantId` is absent. Explicit `null` is permitted for tenant-less background events. Keep the config flag and the module option in agreement.

## Testing with events

Swap the backend to memory and assert on what was published:

```ts
Test.createTestingModule({
  imports: [EventsModule.forRoot({ backend: 'memory' })],
});

// in a test:
expect(bus.publishedEvents).toContainEqual(
  expect.objectContaining({ type: 'contact_created' }),
);
```

Call `bus.clear()` in `beforeEach`. For Drizzle integration tests, `DrizzleEventBus.drainOnce()` runs exactly one drain cycle so you do not have to sleep past the poll interval.
