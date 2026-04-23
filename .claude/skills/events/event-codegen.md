# Event Codegen (YAML → typed facade)

**Status: shipped (Phase 1).** Delivered via EVT-1..EVT-8 under ADR-024. The plan draft at `docs/specs/events-codegen-plan.md` is superseded — ADR-024 is the authoritative design doc.

This file covers: the `events/*.yaml` shape, the generated artifacts under `runtime/subsystems/events/generated/`, and the typed facade usage pattern. Cross-refs `outbox-and-transactions.md` (publish semantics), `directions-and-pools.md` (what directions drive), and `phase-roadmap.md` (what shipped vs. what's deferred).

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
- `payload` — snake_case keys → camelCase TS props; types `uuid | string | number | boolean | date | json | array`. For `array`, an `items:` scalar type is required (`items: uuid | string | number | boolean | date`) and emits `T[]` + `z.array(T)`. `json` means "arbitrary JSON object" (`Record<string, unknown>` / `z.record(z.unknown())`) — do NOT use `json` for array-shaped payloads, Zod will reject them at validation time.
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

## Generated artifacts — `runtime/subsystems/events/generated/`

Five files, all generated, none hand-edited. In the codegen repo they sit under `runtime/subsystems/events/generated/`; when `subsystem install events` runs they land under `<paths.subsystems>/events/generated/` in the consumer project (default `shared/subsystems/events/generated/`).

```
runtime/subsystems/events/generated/
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

## Phase ordering

Phase 1 (EVT-1..EVT-8) is shipped. Everything else is deferred — see `phase-roadmap.md` for the split and the "do not build yet" list.

## Resolved decisions (ADR-024 EVT-Q1..EVT-Q7)

The plan draft called out eight open questions before implementation. They are now resolved; keep this list handy when orienting on why the shipped shape looks the way it does.

1. **Top-level `events/*.yaml` vs. inline entity `events:` — both, with desugar.** Entity `events:` blocks desugar to top-level `events/<name>.yaml` entries at parse time with `direction: change` and `aggregate: <entity>`. Both paths produce the same registry entry.
2. **Entity `emits:` required for typed auto-emission.** Absence falls back to the legacy `lifecycle-events.ts` untyped path (with a codegen warning). Each `emits:` entry must resolve to an `events/<type>.yaml` with `direction: change` and `aggregate: <entity>` — mismatch is a codegen hard error.
3. **Payload validation default-on, configurable off via env.** `TypedEventBus.publish` runs `eventPayloadSchemas[type].parse(payload)` unless `CODEGEN_EVENT_VALIDATE=off`. Boundary validation belongs at publish time, not per-handler.
4. **`TypedEventBus` is the preferred injection; raw `EVENT_BUS` remains available.** New code injects `TYPED_EVENT_BUS`. Legacy use cases and forwarders that need untyped publish keep working via `EVENT_BUS` — no forced migration. ADR-024 encourages `TypedEventBus` but does not delete the raw port.
5. **`pool` / `direction` are first-class columns on `domain_events`** (EVT-1) and mirrored in `metadata` for protocol stability. First-class columns unlock the pool-filtered drain query without unpacking JSON on every poll (EVT-4).
6. **Pool inheritance for the ADR-023 bridge is deferred** — the bridge itself is not in Phase 1, so pool-default policy lives with the bridge spec rather than here.
7. **Selective broadcast of `JobEvent` to the bus is Phase B, deferred** (ADR-026). Not in Phase 1 scope.
8. **Versioning coexistence (v1 + v2 of the same type) is deferred.** Phase 1 emits a `version` field on `EventMetadata`, stamped on every publish, but the registry currently maps one version per type. A future phase will decide on multi-version coexistence shape.

Also resolved in implementation:

- **EVT-Q7 (outbox sweeper):** no sweeper. `FOR UPDATE SKIP LOCKED` + same-transaction status update means nothing can strand in half-claimed state. See `outbox-and-transactions.md`.
- **Multi-tenancy column is a scaffold-time conditional** (EVT-8). The runtime `domain-events.schema.ts` always declares `tenantId`; the Hygen scaffold template emits it only when `events.multi_tenant: true`. Mirrors the JOB-6 precedent for `jobs.tenant_id`.

## Do not

- Do not invent codegen features beyond the plan. The plan has authority; this file is a summary.
- Do not generate user-pool events. Events are always in `events_*` pools. If you want "a user job runs when this event fires," that is the Event-to-Job Bridge (ADR-023) — the event drains in `events_*`, the *bridge* enqueues a user-pool job.
- Do not hand-edit `runtime/subsystems/events/generated/*.ts` (or the `<paths.subsystems>/events/generated/` copy in a consumer project). They are reproduced from `events/*.yaml` by `event-codegen-generator.ts`.

## See also

- `docs/adrs/ADR-024-events-domain-formalization.md` — authoritative Phase 1 ADR
- `docs/specs/events-codegen-plan.md` — superseded plan (historical context only)
- `outbox-and-transactions.md` — how the generated facade's `publish(tx)` inherits the outbox guarantee
- `directions-and-pools.md` — what `direction` drives downstream
- Jobs SKILL.md → ADR-023 (Event-to-Job Bridge) — consumer of the registry
