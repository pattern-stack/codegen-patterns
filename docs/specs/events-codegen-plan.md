# Events Codegen Formalization — Plan

**Status:** Draft (first pass, 2026-04-17)
**Owner:** Doug
**Related:** ADR-008 (subsystem architecture), Jobs Layers 1–4 plan
**Mirrors:** jobs codegen design (pools, generated `src/generated/` output, typed registry)

## 0. Context and framing

Today the events subsystem is scaffolded as a one-time copy under the consumer's
`src/shared/subsystems/events/` tree (via `just gen-subsystem events`). It ships:

- `IEventBus` — `publish / publishMany / subscribe`, transactional outbox aware
- `DomainEvent` — untyped `type: string` + `payload: Record<string, unknown>`
- `DrizzleEventBus` — outbox polling loop, no pool awareness
- `MemoryEventBus` / `RedisEventBus` — alternate backends
- `domain_events` Drizzle table — single table, no `direction` or `pool`
- Entity YAML `events:` block — already parsed; generates per-entity event
  classes + optional handlers via the existing entity templates

What is **missing** (and is the job of this plan):

1. Events are referenced by free-string `type`. There is no registry, no
   typed `publish<T>()`, no compile-time validation of subscriptions.
2. There is no `direction` concept on events — so the jobs bridge has no
   way to assign the right reserved pool (`events_inbound` / `events_change` /
   `events_outbound`).
3. Event payload shapes live inside a single entity YAML and only cover
   entity-CRUD cases. There is no first-class way to declare inbound webhooks
   or outbound publishes (which are not tied to any single entity).
4. Auto-emission from entity templates currently leans on
   `runtime/base-classes/lifecycle-events.ts` (fire-and-forget, untyped
   `entityName.created` strings). It works, but it does not produce typed
   events nor register them in the registry the jobs bridge will need.

The north star: events become **first-class, declared, typed, routable, and
referenceable** — exactly like jobs. Event YAML drives the generated registry;
the registry feeds the typed facade and the event-to-job bridge.

## 1. Event YAML shape

### Location and file naming

Events live under `events/*.yaml` at the repo root, alongside `entities/` and
(soon) `jobs/`. One file per event type. Filename matches the `type` (snake).

```
events/
  contact_created.yaml
  stripe_payment_received.yaml
  webhook_outbound_contact_sync.yaml
```

**Alternative considered:** inline under each entity's `events:` block. Kept
that block for `direction: change` auto-emission convenience (see §4) but
inbound/outbound events are **not** entity-owned, so they need their own
top-level files.

### Schema (Zod sketch)

```ts
const EventDirectionSchema = z.enum(['inbound', 'change', 'outbound']);

const EventPayloadFieldSchema = z.object({
  type: z.enum(['uuid', 'string', 'number', 'boolean', 'date', 'json']),
  nullable: z.boolean().optional().default(false),
  description: z.string().optional(),
});

const EventDefinitionSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  direction: EventDirectionSchema,

  // Aggregate / source binding.
  //   - for `change`: required, must be a declared entity name
  //   - for `inbound`: optional, names the logical source ("stripe", "email")
  //   - for `outbound`: optional, names the destination ("stripe", "crm")
  aggregate: z.string().optional(),
  source: z.string().optional(),      // inbound: external system name
  destination: z.string().optional(), // outbound: target system name

  // Payload fields — snake_case keys, generate camelCase TS properties.
  payload: z.record(z.string(), EventPayloadFieldSchema),

  // Pool is *derived* from direction unless explicitly overridden.
  // Override is constrained to reserved pools of the same category; a `change`
  // event cannot opt into `events_inbound`. User pools (batch/interactive) are
  // NOT valid targets for events.
  pool: z.enum(['events_inbound', 'events_change', 'events_outbound']).optional(),

  // Routing / retry metadata surfaced to the bus backend.
  retry: z.object({
    attempts: z.number().int().positive().default(3),
    backoff: z.enum(['linear', 'exponential']).default('exponential'),
  }).optional(),

  // Optional free-form metadata pinned at codegen time (e.g. schema version).
  version: z.number().int().positive().default(1),
  description: z.string().optional(),
}).strict();
```

Derivation rule (`direction` → default `pool`):

| direction  | default pool       |
|------------|--------------------|
| `inbound`  | `events_inbound`   |
| `change`   | `events_change`    |
| `outbound` | `events_outbound`  |

### Worked examples

**1. Inbound webhook**

```yaml
# events/stripe_payment_received.yaml
type: stripe_payment_received
direction: inbound
source: stripe
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

**2. Change (entity CRUD)**

```yaml
# events/contact_created.yaml
type: contact_created
direction: change
aggregate: contact          # must match entities/contact.yaml
version: 1
payload:
  contact_id:  { type: uuid }
  account_id:  { type: uuid, nullable: true }
  created_by:  { type: uuid }
```

Change events may *also* be declared via the entity `events:` block (see §4)
— the entity block is sugar that generates the equivalent `events/*.yaml`
at codegen time.

**3. Outbound**

```yaml
# events/webhook_outbound_contact_sync.yaml
type: webhook_outbound_contact_sync
direction: outbound
destination: crm
aggregate: contact
version: 1
description: Fan out contact writes to the configured CRM provider.
payload:
  contact_id: { type: uuid }
  operation:  { type: string }  # "create" | "update" | "delete"
  occurred_at: { type: date }
retry:
  attempts: 3
  backoff: exponential
```

## 2. Generated artifacts in `src/generated/events/`

All generated files. Hand-edits discouraged; everything is reproducible from
`events/*.yaml`.

```
src/generated/events/
  types.ts         # Typed interfaces + discriminated union
  schemas.ts       # Zod runtime schemas (parity with types.ts)
  registry.ts      # Metadata map: type → { direction, pool, aggregate, ... }
  bus.ts           # Typed facade over IEventBus (publish<T>, subscribe<T>)
  index.ts         # Re-export surface
```

### `types.ts`

```ts
// Generated. Do not edit.
export interface StripePaymentReceivedEvent extends DomainEvent {
  readonly type: 'stripe_payment_received';
  readonly payload: {
    eventId: string;
    customerId: string;
    amountCents: number;
    currency: string;
    receivedAt: Date;
  };
}

export interface ContactCreatedEvent extends DomainEvent {
  readonly type: 'contact_created';
  readonly aggregateType: 'contact';
  readonly payload: {
    contactId: string;
    accountId: string | null;
    createdBy: string;
  };
}

// ... one interface per event yaml

export type AppDomainEvent =
  | StripePaymentReceivedEvent
  | ContactCreatedEvent
  | WebhookOutboundContactSyncEvent
  /* ... */;

export type EventTypeName = AppDomainEvent['type'];

export type EventOfType<T extends EventTypeName> =
  Extract<AppDomainEvent, { type: T }>;

export type PayloadOfType<T extends EventTypeName> =
  EventOfType<T>['payload'];
```

### `schemas.ts`

```ts
export const stripePaymentReceivedPayloadSchema = z.object({
  eventId: z.string(),
  customerId: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  receivedAt: z.coerce.date(),
});

export const eventPayloadSchemas = {
  stripe_payment_received: stripePaymentReceivedPayloadSchema,
  contact_created: contactCreatedPayloadSchema,
  /* ... */
} as const satisfies Record<EventTypeName, z.ZodTypeAny>;
```

### `registry.ts`

The runtime truth, keyed by `type`. The event-to-job bridge reads this.

```ts
export interface EventMetadata {
  type: EventTypeName;
  direction: 'inbound' | 'change' | 'outbound';
  pool: 'events_inbound' | 'events_change' | 'events_outbound';
  aggregate?: string;      // entity name (required for 'change')
  source?: string;         // inbound origin
  destination?: string;    // outbound target
  version: number;
  retry: { attempts: number; backoff: 'linear' | 'exponential' };
}

export const eventRegistry = {
  stripe_payment_received: {
    type: 'stripe_payment_received',
    direction: 'inbound',
    pool: 'events_inbound',
    source: 'stripe',
    version: 1,
    retry: { attempts: 5, backoff: 'exponential' },
  },
  contact_created: { /* ... */ },
  /* ... */
} as const satisfies Record<EventTypeName, EventMetadata>;

export function getEventMetadata<T extends EventTypeName>(type: T): EventMetadata {
  return eventRegistry[type];
}
```

### `bus.ts` — typed facade

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
    // Validate payload at the boundary (dev/test; optional prod flag)
    if (process.env['CODEGEN_EVENT_VALIDATE'] !== 'off') {
      eventPayloadSchemas[type].parse(payload);
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

### `index.ts`

Re-exports `AppDomainEvent`, `EventTypeName`, `eventRegistry`,
`getEventMetadata`, `eventPayloadSchemas`, `TypedEventBus`. Consumers import
from `@generated/events` — not from the subsystem directly.

### Additional files (considered, recommended)

- `src/generated/events/handlers-token.ts` — `Symbol`-keyed tokens per event
  type so NestJS DI can inject handler sets. Useful once we introduce the
  event-to-job bridge and want per-type handler registration.

## 3. Changes to `IEventBus`

**Decision: keep the protocol narrow. Put typed generics on the facade, not
the port.** The bus is the hexagonal port — it should not know about the
generated registry (circular coupling). The typed facade (`TypedEventBus`) is
what application code actually uses; it owns the typed generics.

### Required protocol changes

1. **Add `pool` to `DomainEvent.metadata` as a well-known key.** Not a
   dedicated field — we keep the protocol shape stable. The generated
   facade stamps `metadata.pool` and `metadata.direction` on every publish.
   Backends that want to route on pool can read it from metadata; backends
   that don't care just ignore it.

2. **Add a first-class column on the outbox table.** `domain_events` gets a
   `pool` column (nullable, indexed) and a `direction` column (nullable,
   indexed). This is a pure migration — no protocol change, but it lets
   the Drizzle poller query by pool.

3. **Drain by pool.** `DrizzleEventBus` polling gains an optional `pools`
   filter. When multiple processes poll (e.g. an inbound-webhook worker vs
   a batch-change worker), each can restrict itself. Default stays: drain
   all pools.

Protocol stays at its current 3 methods. No typed generic is added there.

### What does *not* change

- `publish(event, tx?)` / `publishMany(events, tx?)` / `subscribe(type, handler)`
  signatures stay identical. All existing scaffolds keep working.
- `DomainEvent` shape stays identical. `direction` lives in metadata
  (already precedent for `category`).

### Outbox drain pool routing

The drain loop:

```sql
SELECT * FROM domain_events
WHERE status = 'pending'
  AND (pool = ANY($1::text[]) OR $1 IS NULL)
ORDER BY occurred_at ASC
LIMIT $2
FOR UPDATE SKIP LOCKED
```

`pool` is populated from `metadata.pool` at insert time, or via a generated
trigger / in-memory fill during `publish` — preferred: the generated
`TypedEventBus.publish` passes pool both in metadata and as an explicit column
(the backend can pluck it).

## 4. Auto-emission from entity templates

### Today

`runtime/base-classes/lifecycle-events.ts` emits fire-and-forget
`${entityName}.created|updated|deleted` events with `entitySnapshot` payload,
and per-field `${entityName}.field_changed` events. Completely dynamic, no
registry knowledge.

### Target

Entity templates should:

1. Look up the entity's declared change events in the registry at codegen time.
2. Generate use-case-level `publish()` calls that hit the typed facade with a
   validated payload shape.
3. Fall back to the untyped lifecycle emission only when no matching
   declared event exists (bridge compatibility, clearly deprecated).

### Opt-in vs. silent skip

**Recommendation: require entity YAML to declare its emitted events.**

Add an `emits:` list to the entity YAML:

```yaml
# entities/contact.yaml
emits:
  - contact_created
  - contact_updated
  - contact_deleted
```

Behavior:

- If `emits:` is declared, the generator validates each entry resolves to
  an `events/<type>.yaml` with `direction: change` and `aggregate: contact`.
  Missing → codegen hard error.
- If `emits:` is absent, no typed auto-emission — we still ship the
  untyped `lifecycle-events.ts` fallback and warn once at codegen time:
  *"Entity contact has no `emits:` block. Falling back to untyped lifecycle
  events. See docs/specs/events-codegen-plan.md §4."*

Rationale: silent typed emission is surprising ("where did that event come
from?"); required declaration makes the registry the single source of truth
for what the app emits.

### Entity `events:` block (legacy sugar)

The existing entity `events:` block keeps working. At parse time the
generator **desugars** it into `events/<name>.yaml` files (with
`direction: change`, `aggregate: <entity>`). We stop generating per-entity
event *classes* from it — those are replaced by the `src/generated/events/`
types. Handlers (when `generate_handler: true`) still go into the entity's
module folder, but now import the generated types.

### Code shape (sketch)

Generated use case calls the facade explicitly:

```ts
// src/modules/contacts/use-cases/create-contact.use-case.ts (generated)
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

No more reliance on `BaseService` silently emitting events for declared
change types — that path becomes the fallback only.

## 5. Phase integration with the jobs plan

The jobs plan is Layers 1–6, with the Event-to-Job Bridge sitting at Phase 3
(triggers from event types). The bridge needs:

- a canonical list of event type names
- direction/pool metadata for pool auto-assignment
- typed payload shapes for scope extraction

Events codegen is therefore a **hard prerequisite for jobs Phase 3**. But
pieces of it are also useful earlier:

| When                              | What                                     |
|-----------------------------------|------------------------------------------|
| Jobs Phase 1 (definition/run)     | **Events Phase 0** — YAML + registry.ts only. Gives jobs codegen a `type-safe` lookup even before bridge. Lightweight — no facade, no auto-emission. |
| Jobs Phase 2 (policy/hierarchy)   | No events work needed.                   |
| **Jobs Phase 3 (event bridge)**   | **Events Phase A** — `types.ts`, `schemas.ts`, `bus.ts` facade; pool column on `domain_events`; `TypedEventBus.publish` stamps metadata. Bridge consumes registry directly. |
| Jobs Phase 4 (waits)              | No events work needed.                   |
| Jobs Phase 5 (JobEvent audit)     | **Events Phase B** — registry gains selective-broadcast declarations (which `JobEvent` types fan out to `IEventBus`). |
| Jobs Phase 6 (agent extensions)   | No events work needed.                   |

After jobs Phase 3 lands, do **Events Phase C** independently:

- Auto-emission rewrite in entity templates (§4)
- `emits:` validation
- Entity `events:` block desugaring into `events/*.yaml`

This final phase is independent of jobs and can slip without blocking.

### Proposed ordering

1. Events Phase 0 (registry-only) — block jobs Phase 1
2. Jobs Phase 1, 2 proceed
3. Events Phase A (typed facade + pool routing) — block jobs Phase 3
4. Jobs Phase 3 (bridge) lands
5. Jobs Phase 4, 5, 6 proceed; Events Phase B interleaves at jobs Phase 5
6. Events Phase C (entity auto-emission rewrite) ships standalone

## 6. Connection to the Event-to-Job Bridge

### Safe reference from Job YAML

```yaml
# jobs/onboarding.yaml
name: onboarding
triggers:
  - event: stripe_payment_received
    scope:
      entity: account
      from: payload.customer_id   # resolved against the typed payload shape
```

Codegen-time validation:

1. `event` value must exist in `eventRegistry`. Missing → hard error with
   the closest match suggested.
2. `scope.from` is a dotted path into the event's payload. The generator
   walks the registry's payload shape and fails if the path doesn't exist
   or the leaf type is not `uuid`/`string`.
3. `scope.entity` must match an entity name; if the event is a `change`
   event, the bridge can default `scope.entity` to the event's `aggregate`.

### Generated bridge wiring

For each `triggers[]` entry, generate a subscriber:

```ts
// src/generated/jobs/bridge/onboarding.trigger.ts
@Injectable()
export class OnboardingEventTrigger implements OnModuleInit {
  constructor(
    private readonly bus: TypedEventBus,
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<'stripe_payment_received'>(
      'stripe_payment_received',
      async (event) => {
        const accountId = event.payload.customerId; // typed!
        await this.jobs.enqueue('onboarding', { accountId }, {
          concurrencyKey: `account:${accountId}`,
        });
      },
    );
  }
}
```

Because `TypedEventBus.subscribe<'stripe_payment_received'>` narrows the
handler param to `StripePaymentReceivedEvent`, `payload.customerId` is
type-checked at build time. No `as` casts in generated code.

### Pool assignment on the job side

When a job is triggered by an event, the generator can **auto-assign** the
job's pool from the event's pool metadata — unless the job YAML explicitly
overrides. This keeps user jobs off the reserved pools by default:

- event `direction: inbound` → triggered job inherits `pool: batch` (user work
  after the webhook lands), **not** `events_inbound`.
- The reserved `events_*` pools drain the bus itself, not user jobs.

This is a subtle point and probably worth an open question (#Q6).

## 7. Open questions

1. **Top-level `events/*.yaml` vs. inline entity `events:` block — keep both,
   desugar, or drop one?** Proposal above keeps both, with inline as sugar
   that desugars. Is that the right ergonomic bet, or should `change` events
   also live in top-level files for uniformity?

2. **`emits:` required, optional, or both with warning?** I proposed
   required-with-codegen-error for declared events and a warning-with-fallback
   for undeclared entities. Alternative: make `emits:` optional and auto-infer
   from the entity's name (`<entity>_created` etc.), failing only if the
   inferred YAML is missing.

3. **Payload validation: dev-only, always-on, or configurable?** I sketched an
   env-flag gate. Safer default might be always-on parse in dev/test and
   always-off in prod, or always-on with a `.safeParse()` that logs but does
   not throw.

4. **Should `TypedEventBus` replace `@Inject(EVENT_BUS)` entirely in generated
   code, or live alongside it?** Replacing means use cases never touch the
   raw bus. Coexisting means handlers still use the raw bus for unknown
   event types (e.g. from third-party subsystems). Recommendation: replace.

5. **`pool` / `direction` as metadata fields vs. columns.** I proposed both
   — metadata for protocol stability, columns for index-friendly drain
   queries. Is the duplication worth it, or should we promote to protocol
   fields and do a one-shot migration?

6. **Pool inheritance for event-triggered jobs.** Should a job triggered by
   an `events_inbound` event default to `batch` (my current proposal) or to
   `events_inbound` (runs "inside" the event drain)? The latter simplifies
   back-pressure accounting but muddies the reserved-pool semantics.

7. **Selective broadcast of `JobEvent` to the bus (Phase 5).** Do we model
   that via a `broadcast: true` flag on jobs YAML event declarations, or via
   an allowlist in a jobs-codegen config block? Lower priority but needs a
   call before jobs Phase 5.

8. **Versioning.** I added `version` on event YAML but didn't use it. Do we
   want schema-evolution support now (v1 and v2 coexist in the registry with
   separate TS types) or defer? Punting feels safe; the field costs nothing.
