# Directions & Pools

The events subsystem has exactly three **directions** for domain-tier events: `inbound`, `change`, `outbound`. Each drains through its own reserved pool in the jobs subsystem. This file explains the distinction, why the pools are kept separate, and how events and jobs connect across that boundary.

There is also a fourth class: **audit-tier events** (`tier: audit`), which have no direction and no pool. They flow through the outbox but the bridge refuses to bind jobs to them. See §Tier at the bottom.

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

## Event-triggered jobs — two pool layers (resolved by ADR-023)

ADR-023 (revised 2026-04-21) resolves this: bridge-driven fanout spans **two pool layers**, and user jobs land in their **declared `@JobHandler.pool`** — no inheritance, no `batch` default.

**Pool A (reserved `events_*`):** framework-owned `@framework/bridge_delivery` wrapper runs. Cheap (~1ms per wrapper: registry lookup, `when:` evaluation, `orchestrator.start`, ledger update). Run at high concurrency (e.g., 32). Not usually a bottleneck.

**Pool B (user pools):** the actual user job. Where contention happens. Author chooses the pool via `@JobHandler.pool`.

```
publish(user.signup)
   │
   ▼
┌──────────────────────┐
│ wrapper job_run      │ ← Pool A: events_change (reserved, framework)
└──────────┬───────────┘
           │ wrapper.handle() calls orchestrator.start(userJob)
           ▼
┌──────────────────────┐
│ user job_run         │ ← Pool B: @JobHandler.pool (e.g. outbound_email)
└──────────────────────┘
```

**Rule of thumb:** pool-per-class-of-work, not per-event-type. One event can fan out into many different user pools (see ADR-023 §*Pool alignment guidance*).

**Ordering guarantee.** Reserved-pool concurrency > 1 means no implicit ordering between sequential events for the same user pool. If a consumer needs "A before B" ordering:
- **Coarse**: set `jobs.pools.events_<direction>.concurrency = 1` — serializes ALL wrappers in that direction. Blunt.
- **Granular (preferred)**: set `concurrency_key` on the user `@JobHandler` (e.g. `account:{input.account_id}`) with `collisionMode: 'queue'` — serializes per-aggregate, parallel across aggregates.

Default configuration gives parallelism, not ordering.

## Custom pools — not for events

Users can declare custom pools in `codegen.config.yaml` (e.g., an `agents` pool for long-running LLM jobs). Those pools **cannot be targets for events** — the reserved-pool set (`events_inbound | events_change | events_outbound`) is the whole legal universe of domain-event pools. A user pool can host event-*triggered* jobs (after the bridge runs), but events themselves only ever drain through the three reserved lanes.

If you find yourself wanting a fourth *pool* for event traffic, stop — that's almost always the `tier: audit` case (see below), not a new pool.

## Tier: audit events have no direction and no pool

The tier field (`domain` | `audit`, default `domain`) is orthogonal to direction. It controls **whether the event is bridge-eligible**:

| tier     | direction       | pool           | can a job trigger on it? |
|----------|-----------------|----------------|--------------------------|
| `domain` | required        | from direction | yes                      |
| `audit`  | MUST be omitted | **null**       | **no — codegen error**   |

Audit events represent facts about the system itself ("a sync run completed," "a feature was used") rather than facts about domain data flow. They still land in `domain_events` and are queryable/replayable like any other event, but:

- Neither `pool` nor `direction` is stamped. Both columns are NULL.
- The bridge dispatcher refuses to bind jobs to them. A `triggers: [crm_sync_completed]` on a job YAML where that event is `tier: audit` fails codegen with a pointed error.
- Subscribers via `IEventBus.subscribe()` may still opt in directly. Audit events are not firewalled from in-process listeners, only from the bridge.

**When to reach for it:** polling/sync lifecycle events, feature-use telemetry, background-task cycle markers, anything where you want the outbox record but explicitly do NOT want downstream work to spawn. The motivating case: a CRM polling sync emitting a `found_row` event per scanned record was silently queuing thousands of inert bridge jobs per run. The `audit` tier fixes this cleanly.

**When NOT to use it:** anything a subscriber could legitimately react to by writing domain state or enqueuing work. That's a domain event.

Full design: `docs/specs/events-codegen-plan.md` §4.

## Do not

- Do not route events through user pools (`batch`, `interactive`). User pools host event-triggered jobs, not events themselves.
- Do not collapse directions. "One queue with priority flags" is the failure mode the reserved-pools design exists to prevent.
- Do not do heavy work inside the outbox drain handler. The drain handler should enqueue a job into the appropriate downstream pool and return. Long-running reactions (HTTP calls, LLM calls, multi-step workflows) belong in jobs.
- Do not target a reserved pool from `@JobHandler`. Build-time error. The reserved pools are framework-owned.

## See also

- `outbox-and-transactions.md` — the drain loop pool filter
- `event-codegen.md` — how `direction` is declared and stamped
- Jobs SKILL.md + ADR-022 — pool definitions and worker concurrency
- `docs/adrs/ADR-023-event-to-job-bridge.md` — two-pool-layer model, pool alignment guidance, ordering guarantees
- Bridge SKILL.md (`.claude/skills/bridge/SKILL.md`) — subsystem-specific guidance (pending BRIDGE-1..9 implementation)
