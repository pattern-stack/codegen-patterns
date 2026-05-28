---
name: events
description: Load when authoring a domain event, publishing one from a use case, or subscribing to one in a project that ran `codegen subsystem install events`. Triggers include `events/*.yaml` files, the generated `TypedEventBus` facade, injecting `TYPED_EVENT_BUS` / `EVENT_BUS`, `publish(...)` inside a Drizzle transaction (the outbox), `subscribe(...)`, the `domain_events` table, and event directions / pools.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Events

The events subsystem is the transactional event backbone vendored into your app by `codegen subsystem install events`. You declare each event type as a YAML file; codegen generates a typed `TypedEventBus` facade, a discriminated union of every event, Zod payload schemas, and a runtime registry. You publish events inside the same database transaction as your domain write (the outbox pattern); a background loop drains them and delivers to subscribers.

The vendored code lives under `<paths.subsystems>/events/` (default `src/shared/subsystems/events/`), imported as `@shared/subsystems/events`. The generated files live under `<paths.subsystems>/events/generated/` and are reproduced from `events/*.yaml` on every `codegen` run — do not hand-edit them.

## Mental model

**An event is an immutable fact** — "contact was created", "Stripe webhook arrived", "opportunity moved to `won`". It has no lifecycle beyond being delivered. **A job is the stateful work** that reacts to a fact. If you are tempted to put `status`, `attempts`, `retry_count`, or `scope` on an event, stop — you want a job (see the `jobs` skill). The event is the trigger; the job is the work.

### The outbox

Publishing an event is an `INSERT` into the `domain_events` table, performed **inside the same transaction as your domain write**. Either both commit or neither does — no phantom events, no domain drift if the process crashes between commit and publish. A separate polling loop drains pending rows and dispatches them to subscribers. This is strictly stronger than `await commit(); await publish()`.

The single most important rule: **always pass the transaction (`tx`) when publishing from a use case that also writes domain state.** Dropping it silently detaches the event from the transaction.

### Directions and pools

Every domain event declares a **direction**, which determines the lane it drains through:

| direction | carries | example |
|---|---|---|
| `inbound` | external → us (webhooks, pub/sub, inbound email) | `stripe_payment_received` |
| `change` | internal domain mutations (drive projections/reactions) | `contact_created` |
| `outbound` | us → external (webhooks fired, sync pushes) | `webhook_outbound_contact_sync` |

Direction is a **routing** concern, not a payload concern — two events with identical payloads can have different directions. Each direction drains through its own reserved lane so a slow outbound handler can't stall internal change-event propagation.

There is also an `audit` **tier** (orthogonal to direction) for observational facts that should live in the outbox but must never spawn work — see `authoring-events.md`.

### Typed facade vs. raw port

- `IEventBus` (token `EVENT_BUS`) is the narrow underlying port: `publish`, `publishMany`, `subscribe`. It knows nothing about your specific event types.
- `TypedEventBus` (token `TYPED_EVENT_BUS`) is the generated, injectable wrapper. Its `publish<T>()` enforces the typed payload for `T` and stamps `metadata.pool` / `metadata.direction` / `metadata.version` from the registry. **Use `TypedEventBus` in new code.** The raw port stays available for forwarders that publish types not in the registry.

## Routing table

| For this task | Read |
|---|---|
| Declaring an `events/*.yaml`, payload types, directions, `tier: audit`, entity `emits:` | `authoring-events.md` |
| Publishing inside a transaction, the outbox, idempotency, subscribing, wiring `EventsModule` | `typed-bus-and-outbox.md` |

To run a durable background job *when an event fires*, that is the Event-to-Job Bridge — see the `bridge` skill. To do the work directly (not via an event), see the `jobs` skill.

## Non-obvious rules

- **Always pass `tx` to `publish` inside a use-case transaction.** It is the entire outbox guarantee. There is no type-level enforcement of this yet — it is a discipline.
- **Events have no lifecycle; jobs do.** The `status` column on `domain_events` (`pending | processed | failed`) is delivery state for the drain loop, not a domain state machine.
- **Use `TypedEventBus.publish<'type'>(...)` once the type is generated.** Misspelled event names and wrong payload shapes become compile errors.
- **Subscribers must be fast.** A subscriber that makes an HTTP call blocks the drain batch (it dispatches ~50 rows serially). Heavy reactions belong in a job — subscribe, then enqueue.
- **The event `id` is the idempotency key.** For replays/backfills, derive the id deterministically from the source event (e.g. Stripe's `evt_...`) so a re-insert is a no-op rather than a duplicate.
- **Regenerate after editing YAML.** Re-run `codegen` (e.g. `codegen entity new --all`) after touching any `events/*.yaml` to refresh the generated facade, union, schemas, and registry.

## Do not

- Do not put job-style fields on an event (`status: running`, `attempts`, `scope`, `parent_id`). Those belong on a job.
- Do not drop the `tx` argument in `publish(...)` inside a transaction.
- Do not collapse the three directions into one pool — lane isolation is the point.
- Do not couple two services with a direct method call when the second merely reacts to a state change in the first. Publish a `change` event from the first, subscribe (or bridge a job) from the second.
- Do not do heavy I/O directly in a subscriber. Enqueue a job instead.
- Do not hand-edit anything under `<paths.subsystems>/events/generated/`. It is regenerated from `events/*.yaml`.
- Do not route events through user pools (`batch`, `interactive`) — events only ever drain through the reserved `events_*` lanes.
