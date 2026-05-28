<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Authoring Events

How to declare an event in YAML, what each field means, what gets generated, and when to reach for the `audit` tier. Read the `events` `SKILL.md` first for the outbox/direction mental model. For publishing and subscribing, see `typed-bus-and-outbox.md`.

## One YAML file per event

Events live in `events/` at your repo root, sibling to `entities/`. One file per type; the filename matches the `type` field (snake_case).

```yaml
# events/contact_created.yaml
type: contact_created
direction: change
aggregate: contact          # must match an entity name
version: 1
payload:
  contact_id: { type: uuid }
  account_id: { type: uuid, nullable: true }
  created_by: { type: uuid }
```

```yaml
# events/stripe_payment_received.yaml
type: stripe_payment_received
direction: inbound
source: stripe              # inbound: logical origin
version: 1
description: Stripe charge.succeeded webhook, post-signature-verification.
payload:
  event_id:     { type: string, description: "Stripe event id (evt_...)" }
  customer_id:  { type: string }
  amount_cents: { type: number }
  currency:     { type: string }
  received_at:  { type: date }
retry:
  attempts: 5
  backoff: exponential
```

```yaml
# events/webhook_outbound_contact_sync.yaml
type: webhook_outbound_contact_sync
direction: outbound
destination: crm            # outbound: logical target
aggregate: contact
payload:
  contact_id:  { type: uuid }
  operation:   { type: string }   # "create" | "update" | "delete"
  occurred_at: { type: date }
```

After editing any `events/*.yaml`, re-run codegen (e.g. `codegen entity new --all`) to regenerate the typed artifacts.

## Field reference

| Field | Required | Notes |
|---|---|---|
| `type` | yes | Unique snake_case business key; matches the filename. Becomes the discriminator and the `publish<T>()` key. |
| `direction` | for `tier: domain` | `inbound \| change \| outbound`. Drives the default pool. **Omit for `tier: audit`.** |
| `tier` | no | `domain` (default) or `audit`. Audit events are outbox-only and never spawn jobs — see below. |
| `aggregate` | for `change` | The owning entity name. Required for `change` events; optional elsewhere. Lets you query/replay events for a given entity id. |
| `source` | inbound only | Logical origin ("stripe", "email"). |
| `destination` | outbound only | Logical target ("crm", "slack"). |
| `payload` | yes | Map of snake_case keys → field specs. Keys become camelCase TS props. |
| `pool` | no | Override the direction's default pool. Only valid within the same category (a `change` event can't opt into `events_inbound`). User pools are never valid. Rarely needed — if you reach for it, revisit the direction. **Must be omitted for `tier: audit`.** |
| `retry` | no | `{ attempts, backoff }`; hints surfaced to the bus. |
| `version` | no | Integer, defaults to 1. Stamped on every publish; multi-version coexistence is not exercised yet. |

### Payload field types

`uuid | string | number | boolean | date | json | array`.

- `nullable: true` makes the TS prop `T | null`.
- `array` requires an `items:` scalar type (`items: uuid | string | number | boolean | date`) and emits `T[]` + `z.array(T)`.
- `json` means an arbitrary JSON object (`Record<string, unknown>`). **Do not use `json` for array-shaped data** — Zod will reject it at the publish boundary.

### Default pool from direction (domain tier)

| direction | default pool |
|---|---|
| `inbound` | `events_inbound` |
| `change` | `events_change` |
| `outbound` | `events_outbound` |

## Tier: domain vs. audit

`tier` classifies the *kind* of fact and controls whether a job can be bound to the event.

| tier | direction | pool | can a job trigger on it? |
|---|---|---|---|
| `domain` (default) | required | from direction | yes |
| `audit` | omitted | null | no — codegen rejects it |

Use `audit` for high-volume **observational** events that should exist in the outbox (so you can query/replay them) but must never spawn downstream work. The motivating case: a polling CRM sync emitting one "I scanned this row" event per record would otherwise queue thousands of inert bridge jobs per run.

```yaml
# events/crm_sync_completed.yaml
type: crm_sync_completed
tier: audit                  # outbox-only; not bridge-eligible
aggregate: integration       # still scoped for query-by-id
version: 1
description: A CRM sync run finished. Observational — no domain state changed.
payload:
  integration_id: { type: uuid }
  provider:       { type: string }
  counts:         { type: json }
  duration_ms:    { type: number }
```

For an `audit` event the generated registry entry has `pool: null` and `direction: null`; both columns land NULL. In-process subscribers (`subscribe(...)`) may still listen to audit events — only the bridge refuses to bind jobs to them.

**The discipline:** if a well-behaved consumer would write another row or enqueue work, it is a `domain` event; if it would only bump a counter or update a dashboard, it is `audit`.

Codegen hard-errors on misuse:
- `tier: audit` with a `pool` → error naming the event.
- `tier: audit` with a `direction` → error naming the event.
- A job whose `@JobHandler.triggers` points at an audit event → `AuditEventTriggerError`. Use a domain event or remove the trigger.

## Entity `events:` block is sugar for change events

An entity's YAML may keep an `events:` block. At parse time each entry desugars into an equivalent `events/<name>.yaml` with `direction: change` and `aggregate: <entity>`. Both paths produce the same registry entry — inline blocks are convenience, not a second source of truth.

## Entity `emits:` for typed auto-emission

An entity can declare which change events its generated use cases emit:

```yaml
# entities/contact.yaml
emits:
  - contact_created
  - contact_updated
  - contact_deleted
```

Each entry must resolve to an `events/<type>.yaml` with `direction: change` and `aggregate: contact`, or codegen hard-errors. With `emits:` present, generated use cases call the typed facade inside the domain transaction:

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

## What gets generated

Five files under `<paths.subsystems>/events/generated/`, all reproduced from your YAML — never hand-edited:

| File | Contents |
|---|---|
| `types.ts` | Per-event interfaces, the `AppDomainEvent` discriminated union, and helpers `EventTypeName`, `EventOfType<T>`, `PayloadOfType<T>`. |
| `schemas.ts` | A Zod schema per payload, plus a keyed map for boundary validation. |
| `registry.ts` | `eventRegistry` — the runtime metadata map (direction, pool, aggregate, version, retry) read by the facade, the bridge, and startup validation. |
| `bus.ts` | The `TypedEventBus` facade with typed `publish<T>()` / `subscribe<T>()`. |
| `index.ts` | Re-export surface. |

The typed payload flows end to end: declaring `payload.contact_id: { type: uuid }` makes `PayloadOfType<'contact_created'>` require `contactId: string`, and `publish('contact_created', id, { ... })` typechecks the object against it.
