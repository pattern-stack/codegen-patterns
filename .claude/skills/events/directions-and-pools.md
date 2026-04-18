# Directions & Pools

The events subsystem has exactly three directions: `inbound`, `change`, `outbound`. Each drains through its own reserved pool in the jobs subsystem. This file explains the distinction, why the pools are kept separate, and how events and jobs connect across that boundary.

## The three directions

| direction  | what it carries                                               | example                         |
|------------|--------------------------------------------------------------|---------------------------------|
| `inbound`  | external → us; webhooks, pub/sub ingest, inbound email       | `stripe_payment_received`       |
| `change`   | internal domain mutations; drives projections / reactions    | `contact_created`               |
| `outbound` | us → external; webhooks fired, sync pushes, notifications    | `webhook_outbound_contact_sync` |

**Direction is a routing concern, not a payload concern.** The direction answers the question: *which lane does this event drain through?* Two events with identical payload shapes can have different directions. The payload is determined by the domain fact; the direction is determined by where that fact came from and where it needs to fan out.

Common confusions:
- *"A `change` event notifies an external system — isn't it really outbound?"* No. The change event is the internal fact. If the reaction fans out externally, **that reaction is a separate `outbound` event** (or a job triggered by the bridge into the `outbound` pool). Keep them distinct — one domain fact can spawn multiple directional events.
- *"An inbound webhook that mirrors a domain change — isn't it a change event?"* No. The `inbound` event records the external arrival. A handler/bridge may then publish a follow-up `change` event after it commits the domain update. Two events, two directions.

## Pools (jobs-side)

The jobs subsystem (ADR-022, jobs SKILL.md) defines five pools by default, three of which are **reserved** for the events subsystem:

| Pool              | Queue                    | Reserved? | Purpose                                     |
|-------------------|--------------------------|-----------|---------------------------------------------|
| `events_inbound`  | `jobs-events-inbound`    | yes       | Drains `direction: inbound` outbox events   |
| `events_change`   | `jobs-events-change`     | yes       | Drains `direction: change` outbox events    |
| `events_outbound` | `jobs-events-outbound`   | yes       | Drains `direction: outbound` outbox events  |
| `interactive`     | `jobs-interactive`       | no        | User-waiting work (renders, exports)        |
| `batch`           | `jobs-batch`             | no        | Background user work (onboarding, ingest)   |

**Reserved means:** a user `@JobHandler` class that targets a reserved pool fails at build time (caught by a module validator). Reserved pools exist *exclusively* to carry the IEventBus outbox drain traffic. No user code enqueues to them.

Concurrency limits per pool are configured in `codegen.config.yaml: jobs.pools`. Defaults ship in ADR-022 (20 / 30 / 10 for inbound / change / outbound).

## How event direction drives pool routing

1. Every event YAML declares a `direction`.
2. Codegen derives the default pool from direction (`inbound → events_inbound`, etc.).
3. `TypedEventBus.publish` stamps `metadata.pool` and `metadata.direction` on every event at publish time (and, Phase A, populates first-class `pool` and `direction` columns on `domain_events`).
4. The Drizzle outbox drain claims rows filtered by pool: each worker process drains a specific pool (or set of pools).
5. This is how lane isolation is enforced: a slow outbound HTTP handler cannot stall inbound webhook processing cannot stall change-event projection.

```
              ┌─────────────────────────────────┐
              │ Domain write (Drizzle txn)      │
              │ + events.publish(...)  ─── tx   │
              └────────────────┬────────────────┘
                               │
                               ▼
              ┌─────────────────────────────────┐
              │  domain_events outbox (Postgres)│
              │  (pool, direction, payload)     │
              └───────┬──────────┬──────────┬───┘
                      │          │          │
       events_inbound │   events_change     │ events_outbound
                      │          │          │
                      ▼          ▼          ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Inbound  │ │ Change   │ │ Outbound │
              │ drain    │ │ drain    │ │ drain    │
              │ worker   │ │ worker   │ │ worker   │
              └──────────┘ └──────────┘ └──────────┘
```

Each drain worker is a pool-filtered instance of `DrizzleEventBus` (or the same process with per-pool concurrency budgets; operational choice). The key invariant: **each direction has its own drain lane**.

## Why isolation matters

From ADR-022's motivating failure mode:

> Outbound webhooks, inbound ingests, domain-change events, and user-triggered work all flow through the same BullMQ queue. A slow outbound handler stalls change-event propagation; a user's export queues up behind a batch onboarding job.

Collapsing the three directions into one pool re-creates exactly this problem. Concrete scenarios:

- **Outbound bleed.** An external webhook target goes slow (CRM rate-limits). The outbound drain's handler queue backs up. If it shares a pool with change events, the read-model projection stalls — user-facing reads start returning stale data. Symptom: "why does my contact not show up in the list" even though the create succeeded.
- **Inbound burst.** Stripe retries a week of webhooks during an incident. The inbound drain sees 10k events in a minute. If change events share the lane, internal consistency operations (projections, cache busts) are blocked behind a queue of external events. Symptom: app-wide latency spike, unrelated to domain load.
- **Change event avalanche.** A batch update to 50k contacts fires 50k change events. Those must not block an inbound Stripe webhook — money movement has to drain on its own schedule.

**The lane is the isolation primitive.** Priority-based scheduling within a single queue is strictly weaker — under sustained load, priority-based schedulers can still starve low-priority work. Separate lanes cannot.

## Event-triggered jobs — pool inheritance (OPEN QUESTION)

When the Event-to-Job Bridge (ADR-023) enqueues a user job in response to an event, which pool does the triggered job land in?

Proposed default (from `events-codegen-plan.md` §6 + §7 Q6): **triggered jobs default to `batch`, not the source event's reserved pool.** Rationale: the reserved `events_*` pools carry the bus drain itself; user work that reacts to an event is still user work and should land in user-pool isolation.

Example:
- Event `stripe_payment_received` drains in `events_inbound`.
- A job `start_onboarding` is triggered by that event.
- The bridge enqueues `start_onboarding` into `batch` (user pool), **not** `events_inbound`.
- `events_inbound`'s drain-loop handler only does the minimum work to hand off: unpack the event, enqueue the job, done.

**This is an open question in the plan.** An alternative is for triggered jobs to inherit the source pool, which simplifies back-pressure accounting but muddies reserved-pool semantics. Check `events-codegen-plan.md` §7 Q6 before assuming.

## Custom pools — not for events

Users can declare custom pools in `codegen.config.yaml` (e.g., an `agents` pool for long-running LLM jobs). Those pools **cannot be targets for events** — the reserved-pool set (`events_inbound | events_change | events_outbound`) is the whole legal universe of event pools. A user pool can host event-*triggered* jobs (after the bridge runs), but events themselves only ever drain through the three reserved lanes.

If you find yourself wanting a fourth event pool ("events_telemetry", "events_audit"), stop and model the underlying concern differently — either split into an existing direction, or treat the thing as an audit table rather than a domain event.

## Do not

- Do not route events through user pools (`batch`, `interactive`). User pools host event-triggered jobs, not events themselves.
- Do not collapse directions. "One queue with priority flags" is the failure mode the reserved-pools design exists to prevent.
- Do not do heavy work inside the outbox drain handler. The drain handler should enqueue a job into the appropriate downstream pool and return. Long-running reactions (HTTP calls, LLM calls, multi-step workflows) belong in jobs.
- Do not target a reserved pool from `@JobHandler`. Build-time error. The reserved pools are framework-owned.

## See also

- `outbox-and-transactions.md` — the drain loop pool filter
- `event-codegen.md` — how `direction` is declared and stamped
- Jobs SKILL.md + ADR-022 — pool definitions and worker concurrency
- `docs/specs/events-codegen-plan.md` §6 — bridge pool inheritance (open)
