# Outbox & Transactions

The events subsystem uses the **transactional outbox pattern**: domain events are inserted into the `domain_events` table as part of the same database transaction as the domain write. A background polling loop drains pending rows and dispatches them to subscribers. This document covers the publish-inside-transaction pattern, polling semantics, idempotency, and common pitfalls.

## Why an outbox

Two things have to be consistent:
1. The domain row changes (e.g. a new `contact` row).
2. Downstream systems learn about it (a subscriber projects to a read model, another service reacts, a webhook fires).

If (1) commits but (2) fails — because the bus was down, or the process crashed between the commit and the publish — the domain drifts silently from its consumers. The outbox pattern fuses (1) and (2) into the same atomic write: the "publish" is just an INSERT into `domain_events` inside the same transaction. Either both happen or neither does. The separate drain loop handles delivery.

This is strictly stronger than `await db.commit(); await bus.publish(...)`. It survives process crashes; the latter doesn't.

## The publish-inside-transaction contract

Every use case that mutates domain state **MUST** pass the transaction to `IEventBus.publish`:

```ts
// src/modules/contacts/use-cases/create-contact.use-case.ts
async execute(input: CreateContactInput): Promise<Contact> {
  return this.db.transaction(async (tx) => {
    const contact = await this.contacts.create(input, tx);
    await this.eventBus.publish(
      {
        id: randomUUID(),
        type: 'contact_created',
        aggregateId: contact.id,
        aggregateType: 'contact',
        occurredAt: new Date(),
        payload: { contactId: contact.id, accountId: contact.accountId, createdBy: input.actorId },
      },
      tx, // ← CRITICAL: this is the outbox guarantee
    );
    return contact;
  });
}
```

Once the `TypedEventBus` facade ships (see `event-codegen.md`), the call collapses to:

```ts
await this.events.publish('contact_created', contact.id, {
  contactId: contact.id,
  accountId: contact.accountId,
  createdBy: input.actorId,
}, { tx });
```

Same guarantee; the facade stamps `id`, `occurredAt`, `metadata.pool`, `metadata.direction` from the generated registry.

**Dropping `tx` silently detaches the event from the transaction.** The backend uses `tx ?? this.db` — if you don't pass `tx`, the insert runs on the top-level connection, outside the domain transaction. You lose the atomicity guarantee. This is a footgun; there is no type-level enforcement yet (see open question in `events-codegen-plan.md`).

## The outbox table

`runtime/subsystems/events/domain-events.schema.ts`:

| Column              | Notes                                                  |
|---------------------|--------------------------------------------------------|
| `id` (uuid, PK)     | Event id. Used for idempotency / dedup.                |
| `type`              | Event type discriminator (`contact_created`)           |
| `aggregate_id`      | Producing aggregate's id                               |
| `aggregate_type`    | `'contact'`, `'opportunity'`, etc.                     |
| `payload` (jsonb)   | Event-specific payload                                 |
| `occurred_at`       | Wall-clock                                             |
| `processed_at`      | NULL until drained                                     |
| `status`            | `pending | processed | failed`                         |
| `error`             | Last dispatch error message                            |
| `metadata` (jsonb)  | Routing hints; will carry `pool` and `direction`       |

**Phase A additions** (from `events-codegen-plan.md` §3): `pool` (text, nullable, indexed) and `direction` (text, nullable, indexed) become first-class columns, populated at insert time from `metadata`. This lets the drain loop filter by pool without unpacking JSON on every poll.

**Indexes** to add via migration when deploying:
- `(status, occurred_at)` — polling query
- `(aggregate_id, aggregate_type)` — event replay for an entity
- `(pool, status, occurred_at)` — per-pool drain (Phase A)

## The polling loop

`runtime/subsystems/events/event-bus.drizzle-backend.ts`:

```sql
SELECT * FROM domain_events
WHERE status = 'pending'
ORDER BY occurred_at ASC
LIMIT 50
FOR UPDATE SKIP LOCKED
```

Run inside a transaction so the row is locked for the duration of dispatch. `SKIP LOCKED` means multiple worker processes can poll concurrently without double-dispatching. Default interval: 1000ms. Default batch size: 50.

**Per-batch dispatch flow:**
1. Claim rows with `FOR UPDATE SKIP LOCKED` in a read transaction.
2. For each row: invoke all registered handlers for `event.type`.
3. On success: `UPDATE domain_events SET status='processed', processed_at=now() WHERE id=...`.
4. On failure: retry up to `MAX_RETRIES` (3); if still failing, `UPDATE ... SET status='failed', error=...`. Row is not re-claimed.

Phase A adds pool filtering:

```sql
SELECT * FROM domain_events
WHERE status = 'pending'
  AND (pool = ANY($1::text[]) OR $1 IS NULL)
ORDER BY occurred_at ASC
LIMIT $2
FOR UPDATE SKIP LOCKED
```

Each worker process can restrict itself to a subset of pools. E.g. an inbound-webhook worker drains `events_inbound` only; a change-event worker drains `events_change` only. This is how lane isolation is enforced at the bus layer — the jobs-side pools are the destination for event-triggered work; the bus-side pool-filtered drain is what carries events into those jobs.

## Idempotency

**Event `id` is the idempotency key.** The outbox row is keyed by UUID, generated once at publish time. When you need to detect "did we already handle this?" — for downstream systems, for replay scenarios, for handler reruns — the `id` is the dedup token.

Rules:
- **Do not regenerate `id` on replay.** If you re-publish an event (e.g. a webhook backfill), compute the id deterministically from the source event (Stripe's `evt_...`, Salesforce's `ReplayId`, etc.) so the outbox insert hits `ON CONFLICT (id) DO NOTHING`.
- **Handlers should be idempotent.** The drain loop can redeliver (process crashes between dispatch and `status='processed'` update). Handlers should be safe to call twice with the same event.id. A common pattern: handlers track seen ids in a small table and short-circuit duplicates.
- **Inbound webhook events should reuse the source system's event id.** If Stripe sends `evt_123` twice, you want the second outbox insert to fail uniquely, not create a duplicate event.

## Ordering guarantees

- **Events for the same aggregate arrive in insertion order** — `ORDER BY occurred_at ASC` + `SKIP LOCKED` gives FIFO per aggregate under a single worker. With multiple workers, ordering holds *probabilistically* per aggregate (same aggregate_id rarely fans to two workers in one poll cycle) but is not guaranteed.
- **Events across aggregates are NOT strictly ordered.** Treat cross-aggregate ordering as "roughly" wall-clock, not exact. If you need strict global ordering, you're on the wrong tool.

If your handler depends on strict cross-aggregate ordering — it probably shouldn't. Re-shape the computation to tolerate independent aggregate timelines.

## Failure modes & what to check

- **Events published outside a transaction.** Look for `publish(event)` (no `tx`) inside a `db.transaction(async (tx) => ...)` block. That's a bug — the publish is not part of the transaction.
- **Handlers doing heavy I/O synchronously.** A handler that makes an HTTP call on every event blocks the drain batch. The drain loop serially dispatches a batch of 50. Handlers should be fast; slow work belongs in a job (see `directions-and-pools.md` — subscriber enqueues a job into `events_outbound` or a user pool).
- **`status='failed'` rows pile up.** Something is permanently broken. Check `error` column, fix the handler, and requeue (set `status='pending'`). There's no automatic retry after the 3-attempt limit — that's intentional; infinite retry on a broken handler burns a worker.
- **Throughput ceiling.** The outbox drain maxes around ~1000 events/s on a modest Postgres. If you blow through that, the escape hatch is a backend swap (Redis Streams, NATS) — `IEventBus.forRoot({ backend: '...' })`, no use-case changes.

## See also

- `protocol-and-backends.md` — IEventBus surface and backend choices
- `directions-and-pools.md` — why the drain loop will filter by pool
- `event-codegen.md` — how `TypedEventBus.publish` stamps metadata
- `docs/adrs/ADR-008-subsystem-architecture.md` — the outbox-pattern rationale, memory backend semantics
