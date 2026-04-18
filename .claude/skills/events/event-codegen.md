# Event Codegen (YAML → typed facade)

**Status: design in flight.** The full design lives in `docs/specs/events-codegen-plan.md` (draft, 2026-04-17). It has eight open questions (§7 of the plan) that are not yet resolved — the shape below may shift. Treat this file as orientation, not as a contract. When in doubt, read the plan.

This file covers: what the formalization is trying to do, the `events/*.yaml` shape, the generated artifacts in `src/generated/events/`, and the typed facade usage pattern. Cross-refs `outbox-and-transactions.md` (publish semantics) and `directions-and-pools.md` (what directions drive).

## Why formalize

Today's shape:
- `DomainEvent` is `{ type: string, payload: Record<string, unknown>, ... }` — untyped.
- Subscribers pass strings: `bus.subscribe('contact_created', handler)`. No compile-time validation of the type name or payload shape.
- No registry: the app cannot ask "what events do we emit?" at boot time.
- The entity `events:` block generates per-entity event classes, but inbound webhooks and outbound publishes have no first-class home — they aren't entity-owned.
- No `direction` concept → no way for the Drizzle drain to route by pool (see `directions-and-pools.md`).

Target shape:
- `events/*.yaml` declares every event, one file per type.
- Codegen produces `AppDomainEvent` (discriminated union), Zod schemas, a runtime registry, and `TypedEventBus` — an injectable typed wrapper over `IEventBus`.
- Every event carries `direction` in its declaration; the facade stamps `metadata.pool` and `metadata.direction` on every publish.
- The event-to-job bridge (ADR-023) reads the registry to validate triggers.

## Event YAML shape

Location: `events/*.yaml` at repo root, sibling to `entities/` and `jobs/`. One file per event. Filename matches the `type` field (snake_case).

```yaml
# events/stripe_payment_received.yaml
type: stripe_payment_received
direction: inbound
source: stripe              # inbound: external system name
version: 1
description: Stripe charge.succeeded webhook, post-signature-verification.
payload:
  event_id:      { type: string, description: "Stripe event id (evt_...)" }
  customer_id:   { type: string }
  amount_cents:  { type: number }
  currency:      { type: string }
  received_at:   { type: date }
retry:
  attempts: 5
  backoff: exponential
```

```yaml
# events/contact_created.yaml
type: contact_created
direction: change
aggregate: contact          # must match entities/contact.yaml
version: 1
payload:
  contact_id: { type: uuid }
  account_id: { type: uuid, nullable: true }
  created_by: { type: uuid }
```

```yaml
# events/webhook_outbound_contact_sync.yaml
type: webhook_outbound_contact_sync
direction: outbound
destination: crm
aggregate: contact
payload:
  contact_id:  { type: uuid }
  operation:   { type: string }   # "create" | "update" | "delete"
  occurred_at: { type: date }
```

**Fields:**
- `type` — unique snake_case business key, matches filename
- `direction` — `inbound | change | outbound`; drives default pool
- `aggregate` — entity name (required for `direction: change`; optional elsewhere)
- `source` — inbound only; logical origin ("stripe", "email")
- `destination` — outbound only; logical target ("crm", "slack")
- `payload` — snake_case keys → camelCase TS props; types `uuid | string | number | boolean | date | json`
- `pool` — optional override; constrained to the reserved pools of the *same category* (a `change` event cannot opt into `events_inbound`). User pools (`batch`, `interactive`) are NEVER valid targets for events.
- `retry` — `{ attempts, backoff }`, hints surfaced to the bus
- `version` — integer, defaults to 1 (schema evolution; not exercised yet)

**Default pool from direction:**

| direction  | default pool       |
|------------|--------------------|
| `inbound`  | `events_inbound`   |
| `change`   | `events_change`    |
| `outbound` | `events_outbound`  |

Override is rarely needed. If you find yourself overriding, revisit the direction.

## Entity `events:` block is sugar

Entity YAML keeps its `events:` block. At parse time the generator **desugars** each entry into an equivalent `events/<name>.yaml` file with `direction: change` and `aggregate: <entity_name>`. This means change events can be declared either inline (entity-owned sugar) or as standalone files (e.g. when multiple entities share a change event, which is rare). Both produce the same registry entry.

The current per-entity event *class* generation is replaced by the `src/generated/events/types.ts` union. Handlers (when `generate_handler: true`) still live under the entity module but import the generated interfaces.

## Entity `emits:` block (required for typed auto-emission)

Phase C design — not yet shipped:

```yaml
# entities/contact.yaml
emits:
  - contact_created
  - contact_updated
  - contact_deleted
```

Behavior:
- If present, each entry must resolve to an `events/<type>.yaml` with `direction: change` and `aggregate: contact`. Missing → codegen hard error.
- If absent, no typed auto-emission. The legacy `runtime/base-classes/lifecycle-events.ts` untyped fire-and-forget path is used (with a warning at codegen time).

Once shipped, generated use-cases call the facade explicitly inside the transaction:

```ts
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

## Generated artifacts — `src/generated/events/`

Five files, all generated, none hand-edited:

```
src/generated/events/
  types.ts         # Typed interfaces + discriminated union
  schemas.ts       # Zod runtime schemas
  registry.ts      # Metadata map keyed by type
  bus.ts           # TypedEventBus facade
  index.ts         # Re-export surface
```

### `types.ts`

```ts
export interface ContactCreatedEvent extends DomainEvent {
  readonly type: 'contact_created';
  readonly aggregateType: 'contact';
  readonly payload: {
    contactId: string;
    accountId: string | null;
    createdBy: string;
  };
}

export type AppDomainEvent =
  | StripePaymentReceivedEvent
  | ContactCreatedEvent
  | WebhookOutboundContactSyncEvent
  /* ... */;

export type EventTypeName = AppDomainEvent['type'];
export type EventOfType<T extends EventTypeName> = Extract<AppDomainEvent, { type: T }>;
export type PayloadOfType<T extends EventTypeName> = EventOfType<T>['payload'];
```

### `schemas.ts`

Zod schemas per payload, plus a keyed map for boundary validation:

```ts
export const eventPayloadSchemas = {
  stripe_payment_received: stripePaymentReceivedPayloadSchema,
  contact_created: contactCreatedPayloadSchema,
} as const satisfies Record<EventTypeName, z.ZodTypeAny>;
```

### `registry.ts`

The runtime source of truth. Read by `TypedEventBus`, by the jobs Event-to-Job Bridge, by startup validation.

```ts
export interface EventMetadata {
  type: EventTypeName;
  direction: 'inbound' | 'change' | 'outbound';
  pool: 'events_inbound' | 'events_change' | 'events_outbound';
  aggregate?: string;
  source?: string;
  destination?: string;
  version: number;
  retry: { attempts: number; backoff: 'linear' | 'exponential' };
}

export const eventRegistry = { /* one entry per yaml */ } as const satisfies Record<EventTypeName, EventMetadata>;

export function getEventMetadata<T extends EventTypeName>(type: T): EventMetadata {
  return eventRegistry[type];
}
```

### `bus.ts` — `TypedEventBus` facade

```ts
@Injectable()
export class TypedEventBus {
  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus) {}

  async publish<T extends EventTypeName>(
    type: T,
    aggregateId: string,
    payload: PayloadOfType<T>,
    opts?: { tx?: DrizzleTransaction; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const meta = getEventMetadata(type);
    if (process.env['CODEGEN_EVENT_VALIDATE'] !== 'off') {
      eventPayloadSchemas[type].parse(payload); // boundary validation
    }
    const event: DomainEvent = {
      id: randomUUID(),
      type,
      aggregateId,
      aggregateType: meta.aggregate ?? meta.source ?? meta.destination ?? type,
      payload: payload as Record<string, unknown>,
      occurredAt: new Date(),
      metadata: {
        ...opts?.metadata,
        pool: meta.pool,
        direction: meta.direction,
        version: meta.version,
      },
    };
    await this.bus.publish(event, opts?.tx);
  }

  subscribe<T extends EventTypeName>(
    type: T,
    handler: (event: EventOfType<T>) => Promise<void>,
  ): () => void {
    return this.bus.subscribe<EventOfType<T>>(type, handler);
  }
}
```

**Key properties:**
- Typed `publish<T>()`: if you pass `'contact_created'`, the `payload` parameter must match `{ contactId, accountId, createdBy }`. Misspelled event names are compile errors.
- Typed `subscribe<T>()`: the handler's event parameter is narrowed to `EventOfType<T>` — `event.payload.contactId` is typed without casts.
- Every publish stamps `metadata.pool` and `metadata.direction` from the registry. The Drizzle backend reads these and populates the outbox columns at insert time; the drain loop then filters by pool.
- The generic `IEventBus` port is unchanged. The facade wraps it.

## Phase ordering (from `events-codegen-plan.md` §5)

Not all of the above lands at once. The plan sequences against the jobs plan:

| When                           | Events work                                              |
|--------------------------------|----------------------------------------------------------|
| Before jobs Phase 1            | **Phase 0** — YAML parser, registry.ts only. No facade.  |
| Before jobs Phase 3 (bridge)   | **Phase A** — types, schemas, facade, pool columns on outbox |
| During jobs Phase 5 (audit)    | **Phase B** — selective broadcast of JobEvent to bus     |
| Independent of jobs            | **Phase C** — `emits:` validation, entity template rewrite |

Phase 0 unblocks jobs Phase 1. Phase A unblocks the bridge. Phase C is independent and slips freely.

## The 8 open questions (flagged in the plan)

Do not assume these are answered:
1. Top-level `events/*.yaml` vs. inline entity `events:` block — keep both with desugar, or drop one?
2. `emits:` required vs. optional vs. inferred by name?
3. Payload validation: dev-only, always-on, or configurable?
4. `TypedEventBus` fully replaces `@Inject(EVENT_BUS)` in generated code, or they coexist?
5. `pool` / `direction` as metadata only vs. first-class columns vs. protocol fields?
6. Pool inheritance for event-triggered jobs — default to `batch` or the source `events_*` pool?
7. Selective broadcast of `JobEvent` to the bus — flag on jobs YAML or codegen-config allowlist?
8. Versioning — schema-evolution coexistence (v1/v2) or defer?

If a task depends on one of these, check `docs/specs/events-codegen-plan.md` §7 first; the plan will likely be updated before implementation.

## Do not

- Do not invent codegen features beyond the plan. The plan has authority; this file is a summary.
- Do not generate user-pool events. Events are always in `events_*` pools. If you want "a user job runs when this event fires," that is the Event-to-Job Bridge (ADR-023) — the event drains in `events_*`, the *bridge* enqueues a user-pool job.
- Do not hand-edit `src/generated/events/*.ts`. They are reproduced from `events/*.yaml`.

## See also

- `docs/specs/events-codegen-plan.md` — full design, open questions, alternatives
- `outbox-and-transactions.md` — how the generated facade's `publish(tx)` inherits the outbox guarantee
- `directions-and-pools.md` — what `direction` drives downstream
- Jobs SKILL.md → ADR-023 (Event-to-Job Bridge) — consumer of the registry
