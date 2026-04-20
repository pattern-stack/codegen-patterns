---
name: events
description: Use when working on IEventBus, domain event publishing, the transactional outbox (domain_events table), subscribers, the event-codegen formalization (events/*.yaml, AppDomainEvent union, typed TypedEventBus facade, direction routing into events_* pools), or anything in runtime/subsystems/events/. Load this before touching event shape, publish/subscribe call sites, outbox polling, or cross-subsystem wiring into jobs' reserved event pools.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Events Domain Skill

Events are the domain's immutable record of *something that happened*. They are written inside the same Drizzle transaction as the domain change (transactional outbox), drained asynchronously, and delivered to subscribers. This skill covers the current runtime (`IEventBus`, the `domain_events` outbox, Drizzle/Memory backends) **plus** the in-flight codegen formalization that will generate a typed event registry, typed `TypedEventBus` facade, and direction-based pool routing.

## Mental model

**Events vs. jobs — a sharp distinction, memorize it:**

- **Events are immutable facts.** "Contact was created." "Stripe webhook arrived." "Opportunity stage changed to `won`." They have no lifecycle of their own beyond pending → processed in the outbox. Nothing about an event retries or fails in the domain sense — what retries is a *handler* or a *downstream job*.
- **Jobs are stateful work.** They have status (`pending | running | waiting | completed | failed | canceled`), retry policies, hierarchy, scope, signals. They can be canceled, replayed, reorganized. See the jobs SKILL.md sibling.

If you are tempted to put `status`, `attempts`, or `retry_policy` fields on an event — stop. You want a job. The event is the *trigger*; the job is the *work*.

**Three event directions** — this is the single most important routing concern in the subsystem:

| direction  | what it carries                                     | example                          | default pool       |
|------------|-----------------------------------------------------|----------------------------------|--------------------|
| `inbound`  | external → us. Webhooks, pub/sub, inbound email     | `stripe_payment_received`        | `events_inbound`   |
| `change`   | internal domain mutations. Drives projections       | `contact_created`                | `events_change`    |
| `outbound` | us → external. Webhooks fired, sync pushes          | `webhook_outbound_contact_sync`  | `events_outbound`  |

Direction is a **routing** concern, not a payload concern. Payload shape is per-event-type. The same direction can carry wildly different payloads; two events with identical payloads can have different directions. Don't collapse them.

**Reserved `events_*` pools** — the jobs subsystem (ADR-022, jobs SKILL.md) reserves three pools — `events_inbound`, `events_change`, `events_outbound` — *exclusively* for the IEventBus outbox drain. User `@JobHandler` decorations that target a reserved pool fail at build time. These pools exist so a slow outbound handler cannot stall change-event propagation. The Drizzle outbox drain loop claims rows by pool (see `outbox-and-transactions.md`).

**The IEventBus + typed facade story:**

- `IEventBus` (protocol, `runtime/subsystems/events/event-bus.protocol.ts`) stays narrow: `publish(event, tx?)`, `publishMany(events, tx?)`, `subscribe(type, handler)`. It is the hexagonal port. Backends implement it. **It does not know about the generated registry** — that would be circular coupling.
- `TypedEventBus` (generated into `src/generated/events/bus.ts`, see `event-codegen.md`) is a thin injectable wrapper with typed overloads. It stamps `metadata.pool` and `metadata.direction` onto every publish based on the generated registry. Application code uses `TypedEventBus`; `IEventBus` is the lower-level port.

For Phase 1 of the events-codegen work, `IEventBus` is unchanged. The typed facade wraps it without breaking it.

## Task → L1 routing

| When the task involves…                                                             | Read                            |
|--------------------------------------------------------------------------------------|---------------------------------|
| Publishing inside a transaction, outbox semantics, idempotency, polling             | `outbox-and-transactions.md`    |
| The YAML formalization (`events/*.yaml`), generated types/schemas/registry, TypedEventBus facade | `event-codegen.md`  |
| Why there are three directions, why pools are isolated, cross-link to jobs pools    | `directions-and-pools.md`       |
| IEventBus contract, Drizzle/Memory backends, adding a new backend                   | `protocol-and-backends.md`      |

## Non-obvious rules (read twice)

1. **Direction is a routing concern, not a payload concern.** Two events with the same payload can have different directions because the drain lane matters. An `inbound` webhook that mirrors a `change` event is still `inbound` — the lane it drains through is what keeps external bursts from stalling internal projections.
2. **The outbox is transactional.** `IEventBus.publish(event, tx)` inside a Drizzle transaction means the event row is part of the same write. If the transaction rolls back, the event is never persisted. No phantom events. **Always pass `tx` when publishing from a use case that also writes domain state.** Dropping `tx` silently detaches the event from the transaction — the domain write can commit while the event insert fails independently.
3. **Events do not have a lifecycle; jobs do.** The `status` column on `domain_events` (`pending | processed | failed`) is a *delivery* state for the outbox drain, not a domain state. It is not a retry policy, not a scope, not a cancellable thing. If you need any of those, you want a job triggered by the event.
4. **The events-codegen formalization (`events/*.yaml`) generates the union, the registry, and the facade.** `events/<name>.yaml` produces entries in `src/generated/events/`:
   - `types.ts` — `AppDomainEvent` discriminated union, `EventOfType<T>`, `PayloadOfType<T>`
   - `schemas.ts` — Zod payload schemas, runtime-validated at the publish boundary
   - `registry.ts` — `eventRegistry` keyed by type with `direction`, `pool`, `aggregate`, etc.
   - `bus.ts` — `TypedEventBus` with typed `publish<T>()` and `subscribe<T>()`
   This system is **a plan in flight**, not yet an ADR. Shape may shift. See `event-codegen.md` for detail and `docs/specs/events-codegen-plan.md` for the source-of-truth design (8 open questions, unresolved).
5. **Phase ordering matters.** Events codegen is a hard prerequisite for the jobs Event-to-Job Bridge (ADR-023). The bridge reads the event registry to validate trigger references, extract typed scope from payloads, and auto-assign pools. Ship events registry → ship events typed facade → *then* land the bridge. Don't skip.
6. **Change events MAY be declared via the entity `events:` block.** At parse time the generator desugars the entity block into top-level `events/<name>.yaml` with `direction: change` and `aggregate: <entity>`. Per-entity inline blocks are sugar; they are not a second source of truth.
7. **Entity auto-emission requires opt-in via `emits:`.** The target design (Phase C) is: entities declare `emits: [contact_created, contact_updated, ...]` in their YAML; generated use-cases emit typed events via `TypedEventBus.publish(type, aggregateId, payload, { tx })` inside the transaction. Silent auto-emission by name is being phased out.

## Do not

- Do not put job-style fields on events (`retry_count`, `status: pending|running|waiting|completed`, `scope`, `parent_id`, `attempts`). Those belong on `job_run`.
- Do not call `IEventBus.publish` with untyped string types once the typed facade is generated for your project. Use `TypedEventBus.publish<'contact_created'>(...)`. The generated registry is the single source of truth for what the app emits.
- Do not collapse `inbound | change | outbound` into a single pool. Lane isolation is the whole point — a slow outbound handler must not stall change-event propagation.
- Do not couple two services via direct method calls when the second reacts to a state change in the first. Publish a domain event from the first service's use case (inside the transaction), subscribe from the second. Direct imports create retrograde coupling and make the reaction invisible in audit logs and tests.
- Do not drop the `tx` parameter in `publish(event, tx)` inside a use case. The outbox guarantee *is* the `tx`.
- Do not put arbitrary "notify Slack" / "call external API" logic in a subscriber directly. Subscribers should enqueue a job (via the jobs bridge) that lives in the `events_outbound` pool and carries retry/timeout. Handlers that make HTTP calls block the outbox drain.
- Do not create `*.deprecated.ts`, parallel "old + new" event shapes, or migration shims. There are no external consumers yet; replace cleanly. See CLAUDE.md operating principles.
- Do not add new protocol methods to `IEventBus` without an ADR. The narrow three-method port is deliberate — typing, routing, and metadata enrichment live in the typed facade.

## Current runtime snapshot

Files that ship to the consumer app (not templates):
- `runtime/subsystems/events/event-bus.protocol.ts` — `IEventBus`, `DomainEvent`
- `runtime/subsystems/events/domain-events.schema.ts` — outbox table (will gain `pool`/`direction` columns in Phase A)
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` — outbox poller (`FOR UPDATE SKIP LOCKED`)
- `runtime/subsystems/events/event-bus.memory-backend.ts` — sync test backend, exposes `publishedEvents[]`, `publishedEventsForPool()`, `publishedEventsForDirection()`, `clear()`; accepts `opts.pools` for pool-filtered dispatch that mirrors the Drizzle drain (EVT-5)
- `runtime/subsystems/events/event-bus.redis-backend.ts` — alternate backend
- `runtime/subsystems/events/events.module.ts` — `EventsModule.forRoot({ backend })`, `global: true`
- `runtime/subsystems/events/events.tokens.ts` — `EVENT_BUS` symbol
- `runtime/base-classes/lifecycle-events.ts` — legacy fire-and-forget auto-emission; being replaced by `emits:` declarations

Generator pieces (exist as templates + future generator code):
- `templates/subsystems/events/` — scaffolds the above into a consumer app
- `src/generated/events/` — produced by the events-codegen plan (not yet implemented; see `event-codegen.md`)

## Cross-links

- Jobs SKILL.md — the reserved `events_*` pools, the Event-to-Job Bridge (ADR-023 work), why handlers should enqueue jobs rather than do heavy work inline.
- `docs/adrs/ADR-008-subsystem-architecture.md` — the Protocol → Backend → Factory pattern events follows.
- `docs/adrs/ADR-022-job-orchestration-domain-model.md` — the job-side story for the pools and the bridge.
- `docs/specs/events-codegen-plan.md` — the plan for typed events, registry, facade, YAML. **Design in flight.**
