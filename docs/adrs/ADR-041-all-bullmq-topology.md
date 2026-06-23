# ADR-041 — All-BullMQ Topology: Drizzle `IEventBus` + BullMQ `IJobOrchestrator` + BullMQ Scheduler Clock + Bridge Seam

**Status:** Accepted
**Date:** 2026-06-15
**Owner:** Doug
**Related:** ADR-022 (Job Orchestration Domain Model), ADR-023 (Event-to-Job Bridge), ADR-024 (Events Domain Formalization), ADR-039 (Declarative Time-Based Scheduling), ADR-008 (Subsystem Architecture)
**Depends on:** BULLMQ-1 (the BullMQ `IJobOrchestrator` backend — shipped, port-promotion gate pending), ADR-039 (the `schedule:` contract + `EventScheduler` materializer), ADR-023 (the bridge + `bridge_delivery` ledger)
**Specs:** `docs/specs/BULLMQ-2.md` (the BullMQ scheduler **driver** for events — `event-scheduler.bullmq-backend.ts`), `docs/specs/DISPATCH-1.md` (the codegen-declarative `dispatch:` knob — fast-follow)

---

## Revision (2026-06-15) — option #2 pivot

> **The original text of this ADR (Decision 2) described a now-abandoned design: a durable `BullMQEventBus` that carried published events over a BullMQ wake queue, "events on BullMQ = durable dispatch over the Postgres outbox." That design is superseded. This revision records the option-#2 pivot per CLAUDE.md §"living documentation" — it does not silently rewrite the decision.**
>
> **What changed.** During implementation we found a structural blocker, not a tuning problem: **a Redis enqueue cannot be made atomic with a Postgres commit.** The Drizzle outbox commits the `domain_events` row and signals readers via `pg_notify` *in the same transaction* — the notify fires exactly when (and only when) the row becomes visible, by Postgres's own commit machinery. A BullMQ wake enqueued inside the caller's transaction can fire *before* the row is visible (or never, if the tx rolls back), so the bespoke backend needed a slow polling heartbeat as a correctness backstop. Making BullMQ the commit-signal was therefore **slower and weaker** than the Drizzle + `pg_notify` path it replaced — it bought a Redis dependency and a heartbeat to be *worse* than `pg_notify`.
>
> **The locked conclusion (option #2).** Events stay on Drizzle + `pg_notify`; **BullMQ is never the event transport.** The bespoke `BullMQEventBus` was **deleted** — there is no `event-bus.bullmq-backend.ts`, no `events.backend: 'bullmq'` arm, no `loadBullMqEventBus`. What moves onto BullMQ is the *scheduler/clock*, not the event log: a standalone `runtime/subsystems/events/event-scheduler.bullmq-backend.ts` (`BullMqEventSchedulerLifecycle`), selected by a new, orthogonal config knob `events.scheduler.driver: 'poll' | 'bullmq'` (default `poll`). Cron runs on BullMQ while events run on Postgres; the two are independent.
>
> Decisions 1, 3, 5, 6, 7 are unchanged in substance (lightly reworded to match option #2). Decision 2 flips (no events transport on BullMQ). Decision 4 updates (the materializer relocates from a deleted events backend into a standalone scheduler-driver file behind `events.scheduler.driver`). Two new sections — **The data-flow seam** and **The three canonical dispatch speeds** — mirror `docs/specs/BULLMQ-2.md` and are the canonical framing. Status stays **Accepted**.

---

## Context

Three subsystems already exist and meet at a single seam: events (`IEventBus`, `domain_events` outbox), jobs (`IJobOrchestrator`, `job_run` source of truth), and the bridge between them (`bridge_delivery` ledger, ADR-023). BullMQ has landed for **jobs only** (BULLMQ-1): `BullMQJobOrchestrator extends DrizzleJobOrchestrator` (`runtime/subsystems/jobs/job-orchestrator.bullmq-backend.ts:80`), keeping Postgres `job_run` as the domain source of truth and layering `queue.add` / `job.remove` on top. Three things are still missing for a consumer who wants to run automation/scheduling end-to-end on one Redis:

1. **The dead `RedisEventBus` is the only "Redis events" code that exists.** `runtime/subsystems/events/` ships drizzle (outbox, default), memory (test), and a `RedisEventBus` (`event-bus.redis-backend.ts`) Pub/Sub variant whose `findById` returns `null` (`:181`), ignores `tx` (non-transactional, `:137`), and is documented as bridge- and scheduler-incompatible. We have to say whether events get a Redis transport at all (option #2: **no**) and what becomes of the dead bus (deleted).
2. **Scheduling is Postgres-outbox-bound.** ADR-039 materializes `schedule:` ticks via an in-process `EventScheduler` `setInterval` (`runtime/subsystems/events/event-scheduler.ts:257`) + an `ON CONFLICT DO NOTHING` slot insert against a partial UNIQUE expression index (`event-bus.drizzle-backend.ts:375`). There is no BullMQ clock. ADR-039 §159 already commits the mapping (`schedule:` → `upsertJobScheduler`, reconcile-on-boot, prune-orphans) but leaves it unbuilt — and leaves open *where* that materializer lives.
3. **The bridge presupposes a Postgres outbox drain.** `BridgeOutboxDrainHook` runs trigger-match + `bridge_delivery` insert + wrapper `job_run` insert inside the Drizzle drain's per-event transaction (`event-bus.drizzle-backend.ts:631-646`). On an all-BullMQ stack the *wrapper rows* still need to reach a BullMQ worker — we have to say how, without a poll.

This ADR decides the topology. It does **not** re-open BULLMQ-1's jobs decisions or ADR-039's scheduling contract — it composes them into a coherent all-BullMQ end state and closes the three gaps above. The load-bearing decision is that **BullMQ is the jobs executor and the scheduler clock, and is never the event transport** — events stay on Drizzle + `pg_notify`.

## The data-flow seam (the big idea)

The system is two halves, and the seam between them is what makes this design flood-resistant.

```
┌──────────────── EXTERNAL INTEGRATION (pull) ────────────────┐      ┌──────── INTERNAL APP (react) ────────┐
│  provider → conform → reconcile → admission-check → write PG │  ⇒  │  pull backlog from PG at bounded rate │
└──────────────────────────────────────────────────────────────┘      └────────────────────────────────────┘
                                              │                              ▲
                                   PG is the DURABLE TERMINUS                │
                                   of the external half                     coalesce + meter
                                              │                              │
                                              └──── coarse pg_notify ────────┘
                                       ("there's work in lane X", NOT per-row)
```

- **PG is the durable terminus of the external half.** Everything inbound — pulled from a provider, conformed, reconciled, **admission-checked** (does this data prove actionability?), written — lands in Postgres before the internal app sees it.
- **A coarse `pg_notify` signals "we landed admitted data in lane X."** It is a *doorbell per lane*, not a per-row push. The notify says "there is work to pull"; it does not carry the work. This is the same `pg_notify`-on-commit signal the Drizzle event bus already uses — fired by Postgres, on commit, in the caller's transaction.
- **The app pulls the backlog from PG at its own bounded rate and coalesces.** Drain rate is metered by worker concurrency + lane isolation. The backlog lives in PG, durable; the app pulls it down as fast as it safely can, collapsing redundant reactions.

**Why this is flood-resistant.** The dealbrain 20k-item event-queue flood came from *push + events==work*: every landed item pushed a work-item into a transport, so a backfill of 20k rows became 20k queued work-items hammering the broker (`docs/specs/dealbrain-bullmq-audit.md`). Here the backlog stays in PG and is *pulled* — bounded by concurrency and lane isolation — so a 20k-row backfill is a 20k-row table the app drains at its chosen rate, not 20k pushed messages. The coarse per-lane notify means a flood produces *one* doorbell per lane, not one per row.

**Two regimes.** *Backfill* (20k rows land at once) and *steady-state* (a trickle) are different problems. The storm path needs deliberate **coalescing on reaction-cardinality, not item-cardinality**: if 5,000 messages land for one channel and the reaction is "re-summarize the channel," that is *one* reaction, not 5,000. Coalescing collapses to the cardinality of distinct reactions, which is what bounds the storm.

This seam is **why events stay on Drizzle** (Decision 2): the durable terminus *is* the Postgres outbox, and the doorbell *is* `pg_notify`. Putting the event log in Redis would move the durable terminus off the database that already owns the admitted data — re-introducing the push-flood failure mode the seam exists to prevent.

## The three canonical dispatch speeds

The system exposes exactly **three** sanctioned ways to turn data into started work, typed as a single vocabulary — a real exported type, `DispatchMode`, in `runtime/subsystems/bridge/bridge.protocol.ts`:

```ts
export type DispatchMode = 'direct' | 'eager' | 'deliberate';
```

| Mode | Call | What happens | Writes | Latency | Use when |
|---|---|---|---|---|---|
| **`direct`** | `IJobOrchestrator.start()` | enqueue a job, no event | 1 `job_run` + enqueue | instant | actionability is already proven *before* the data reaches you (pre-admitted sources — e.g. a Slack webhook whose payload is itself the proof) |
| **`eager`** | `IEventFlow.publishAndStart()` | event + job + `bridge_delivery`, in ONE tx | outbox row + `job_run` + ledger row, atomically | ~instant | you want the fact *recorded* AND the work *started* together, in the request path, durably |
| **`deliberate`** | `IEventFlow.publish()` + bridge drain | event recorded, fanout async | outbox row; jobs spawned by the bridge | flood-resistant pull (2–3 poll/drain hops) | you must inspect state to decide what (if anything) runs; durable async fanout; the storm path |

**Choice rule.** *If actionability is proven before the data reaches you → `direct` or `eager`. If you must inspect state to decide → `deliberate`.* `direct` skips the event entirely (the source already proved the work is warranted); `eager` records the fact alongside the work (you want both, atomically); `deliberate` records the fact and lets the bridge decide the fanout asynchronously at a bounded pull rate.

**Raw `queue.add` / a Postgres-free ephemeral path is explicitly NOT a public option.** Every sanctioned speed writes to Postgres (a `job_run` and/or a `domain_events` row) — the durable terminus of the seam. A bare `queue.add` would push work into a transport with no durable terminus and no ledger, which is precisely the dealbrain push-flood failure mode. The three speeds are the whole surface; there is no fourth "fire and forget into Redis" option. (This is the same reason Decision 2 keeps events off BullMQ: an enqueue that races the commit is not a durable terminus.)

**Per-trigger declarative knob is a fast-follow (DISPATCH-1).** This ADR locks the typed `DispatchMode` vocabulary and the three runtime call shapes — all of which already exist (`IJobOrchestrator.start` / `IEventFlow.publishAndStart` / `IEventFlow.publish`+bridge). It does **not** ship a way to *declare* per-trigger dispatch speed in YAML; that is `docs/specs/DISPATCH-1.md`. **DISPATCH-1 reopens ADR-023's rejected alternatives F/G** (per-trigger eager-vs-deliberate selection on the event arm), so it requires an **ADR-023 revision** before it can land — flagged here so the dependency is explicit, not discovered later.

## Decision

### 1. Separation on one Redis — not "events and jobs are the same BullMQ thing"

The architectural end state is **separation on one Redis**: a narrow, durable `IEventBus` (on Drizzle) + a BullMQ-orchestrated `IJobOrchestrator` + a BullMQ scheduler clock + the bridge as the seam between them. We explicitly reject collapsing events and jobs into a single BullMQ dispatch path.

This is the dealbrain audit's core conclusion. The audit (`docs/specs/dealbrain-bullmq-audit.md` §"Is BullMQ also the event bus?") found dealbrain has *no* separate event bus — every `BaseEvent` hardcodes a `queueName` and is enqueued as a BullMQ job — and records Doug's own architecture doc verdict verbatim:

> "In our system, **events and jobs are the same thing.** … We should invest in separating a narrow event bus and a dedicated job queue…"
> "Define `IEventBus` and `IJobQueue` as distinct interfaces — today both resolve to the same BullMQ-backed implementation under the hood."

The audit's recommendation for codegen-patterns is the split this ADR adopts: keep BullMQ at the high-level `IJobOrchestrator` port (the executor) and as the scheduler clock, pair it with a separate `IEventBus` on Drizzle, and let the bridge connect them. Dealbrain migrates to this on day one.

### 2. Events stay on Drizzle + `pg_notify` — BullMQ is NEVER the event transport

**Events are stored, signalled, drained, and bridged on Drizzle.** `events.backend` is `drizzle | memory` only — there is no `bullmq` value. The transactional outbox is the proven, instant-on-commit signal, and the bespoke `BullMQEventBus` was **deleted** (see [Revision](#revision-2026-06-15--option-2-pivot) and [§What was removed](#what-was-removed)).

The load-bearing insight, stated plainly:

> **A Redis enqueue cannot be atomic with a Postgres commit.** The Drizzle outbox commits the `domain_events` row and fires `pg_notify` *in the same transaction* — by Postgres, on commit — so the notify fires exactly when (and only when) the row becomes visible. `pg_notify` is the **only** non-polling way to associate a *committed* write with a downstream fire. A BullMQ wake enqueued in the caller's transaction races the commit: it can fire before the row is visible, or never (if the tx rolls back), so it needs a slow heartbeat backstop. That makes a BullMQ event transport **slower and weaker** than `pg_notify` — a strictly worse trade that adds a Redis dependency and a heartbeat to under-perform the Drizzle path.

Consequences that carry over for free because events stay on the outbox:

- `domain_events` stays the committed-event store and the `findById` source of truth.
- `publish`/`publishMany` write the outbox row in the caller's transaction (the established transactional-outbox spine), then `pg_notify` signals the drain — exactly as today.
- The bridge's single-Postgres-transaction exactly-once guarantee is preserved **verbatim**: outbox insert + `bridge_delivery` `UNIQUE(event_id, trigger_id)` + wrapper `job_run`, all in one tx (ADR-023 §"Outbox drain atomicity", §"`publishAndStart` + existing `triggers:` collision"). There is no cross-store transaction to invent.

The core `IEventBus` surface (`publish`/`publishMany`/`subscribe`/`findById`, `event-bus.protocol.ts:43`) stays narrow and unchanged; `materializeScheduledEvent` / `lastScheduledSlotMs` stay optional extension methods (`event-bus.protocol.ts:106,115`). "BullMQ events" therefore means only that the *jobs that events trigger* run on BullMQ (Decision 6) and that recurring/cron events *fire* via BullMQ's clock (Decision 4) — **not** that the event log lives in Redis.

**Alternative considered — a durable `BullMQEventBus` over the outbox** (the original Decision 2: write the outbox row in the caller's tx, then enqueue a BullMQ wake instead of relying on the drain). **Rejected** — the wake cannot be atomic with the commit, so it needs a heartbeat backstop, making it slower and weaker than `pg_notify` for zero portability gain. **Alternative considered — a Redis-resident durable log** (BullMQ Queue / Redis Streams as the event store). **Rejected** — it forks the source-of-truth story away from jobs (Postgres), forces a hand-rolled re-derivation of the `bridge_delivery` ledger and same-tx idempotency, and moves the durable terminus off the database that already owns the admitted data (see [§The data-flow seam](#the-data-flow-seam-the-big-idea)).

### 3. Delete `RedisEventBus` — no deprecation shim

`RedisEventBus` (`event-bus.redis-backend.ts`) is deleted under the project's no-backwards-compat principle (CLAUDE.md §"Operating Principles"). It is:

- **un-installable via the CLI** (the events subsystem descriptor never advertised `redis`);
- **non-transactional** — `publish` ignores `tx` (`:137`), so a rolled-back caller transaction still fires the event (no outbox semantics);
- **bridge-incompatible** — `findById` always returns `null` (`:181`), and the bridge re-fetches the committed event at claim time;
- **scheduler-incompatible** — it implements no `materializeScheduledEvent`, so ADR-039's slot-key idempotency cannot be enforced.

No consumer depends on Pub/Sub semantics, and there is no architectural reason to keep a fire-and-forget bus alongside the durable Drizzle one. **No deprecation callout, no parallel old-and-new arm.** Deleting it also retires the `REDIS_URL` event-bus token, the `redis` arm of `EventsModule.forRoot`/`forRootAsync`, `loadRedisEventBus`, and the redis backend tests. Option #2 does not revive it: `events.backend` is `drizzle | memory`, full stop.

### 4. Scheduling = a standalone BullMQ scheduler **driver**, behind `events.scheduler.driver`

The YAML `schedule:` contract — `{ every, align, catchUp, maxCatchUpSlots }` (`event-scheduler.ts:152` `RegistrySchedule`; ADR-039 Decision 1) — is **unchanged and identical across drivers**. What swaps is the *clock* that fires ticks, governed by a **new, orthogonal config knob**:

```yaml
events:
  backend: drizzle            # event TRANSPORT — drizzle | memory (NOT bullmq)
  scheduler:
    driver: bullmq            # scheduler CLOCK — poll | bullmq (default: poll)
  extensions:
    bullmq:
      redis_url: redis://localhost:6379   # or env REDIS_URL (shared with jobs by default)
```

| `events.scheduler.driver` | Clock |
|---|---|
| **`poll`** (default) | the in-process `EventScheduler` `setInterval` loop (`event-scheduler.ts:257`) + slot insert via `materializeScheduledEvent` → `INSERT … ON CONFLICT DO NOTHING` against the partial UNIQUE slot-key index (`event-bus.drizzle-backend.ts:375`) |
| **`bullmq`** | a standalone `runtime/subsystems/events/event-scheduler.bullmq-backend.ts` exporting **`BullMqEventSchedulerLifecycle`**: one `upsertJobScheduler` (BullMQ Job Scheduler) per scheduled-event type, registered from the `eventRegistry`'s `schedule` blocks; the repeatable tick worker computes the epoch-aligned slot and calls **`EVENT_BUS.materializeScheduledEvent(...)`** on the **Drizzle bus** (the inherited slot-key `ON CONFLICT` insert — same scheduled domain event, within-slot idempotency), NOT a raw `publish` and NOT a BullMQ wake |

**The scheduler relocated out of the (deleted) bespoke events backend into a standalone driver file.** It is no longer "inside an events backend." `BullMqEventSchedulerLifecycle` does **not** store, transport, or drain events — it only fires ticks. Each tick re-enters the *Drizzle* event bus, which then drains via `pg_notify → bridge → job` exactly as it does for a use-case publish or a webhook. It is the BullMQ peer of the in-process `setInterval` materializer: same job, different clock. It injects `EVENT_BUS` (the Drizzle bus), `EVENTS_BULLMQ_CONNECTION` (the Redis connection token, **kept** from the deleted backend's wiring — now scheduler-only; no event ever travels over it; resolves `events.extensions.bullmq.redis_url → REDIS_URL → redis://localhost:6379`, the same default the jobs config uses, so one Redis by default), and the `eventRegistry` schedule blocks on `EVENTS_MODULE_OPTIONS`.

Routing the BullMQ clock back through the outbox — rather than firing the user job directly — is the decision that keeps the whole stack on one path: **time → fact → bridge → job, with `job_run` as the source of truth.** A scheduled tick is an ordinary `domain_event`; the bridge (Tier 3) spawns wrapper + user runs exactly as it does for a use-case publish (ADR-039 Decision 2). Using `materializeScheduledEvent` (not raw `publish`) is load-bearing: BullMQ emits one tick per interval cluster-wide, and the slot-key `ON CONFLICT (type, schedule_slot) DO NOTHING` collapses any within-slot duplicate (boot racing a tick, two instances). This preserves cron, RFC-0005 cadence-on-job, and the bridge on one activation model. ADR-039 §159 already commits this shape ("a repeatable producer of the same event").

**`events.scheduler.driver` is orthogonal to `events.backend` and `jobs.backend`.** Scheduling (when does a fact recur?) and event-transport (how is a fact stored/signalled?) are independent concerns. **Cron runs on BullMQ while events run on Postgres.** A perfectly normal stack is `events.backend: drizzle` + `events.scheduler.driver: bullmq` + `jobs.backend: bullmq` — Drizzle owns the outbox, BullMQ owns the clock *and* the job execution. The driver is NOT `events.backend: bullmq` (there is no such value any more).

**Reconcile-on-boot is mandatory: upsert-desired + prune-orphans (the ENG-605 guard).** A broker-side scheduler re-introduces the zombie-scheduler bug class the outbox model structurally avoided (the ENG-605 incident, ADR-039 §44, §177 — a removed cron that fired forever). On `OnApplicationBootstrap` `BullMqEventSchedulerLifecycle` must `upsertJobScheduler` every desired scheduler **and** enumerate the broker's existing schedulers (`getJobSchedulers`) and `removeJobScheduler` for any not in the current `eventRegistry`. This is not optional; it is the only thing standing between this design and ENG-605.

**Exactly one scheduler source of truth.** Under `driver: bullmq`, the in-process `EventScheduler` `setInterval` loop does **not** run (the `forRoot` branch omits `EventSchedulerLifecycle`); under `driver: poll`, the BullMQ lifecycle is not provided. Running both double-fires (one tick from each clock). The slot-key `ON CONFLICT` insert is the shared idempotency guard either way — driven by whichever clock is active.

**`align: false` / `catchUp` fail loud under the bullmq driver.** The BullMQ Job Scheduler is an epoch-aligned interval clock with no notion of replaying missed slots. So under `driver: bullmq`, a schedule block using `align: false` or `catchUp: true` (`maxCatchUpSlots`) is **rejected, fail loud at boot**, with a clear error naming the offending event type and pointing at `events.scheduler.driver: poll` for those semantics (the poll driver does the ADR-039 bounded backfill from `lastEmittedSlot + 1`). Do not silently degrade — silently dropping `catchUp` would skip windows a rollup must not skip (smoke-filter principle: fail loud, do not paper over).

**Interval-only now; cron deferred.** v1 maps `{ every }` → BullMQ `{ every: ms }`. A future `{ cron }` → `{ pattern }` is an **additive BullMQ-only extension** (BullMQ speaks cron natively with zero new dependency; the poll driver stays interval-only). Holding cron back keeps driver parity and the cross-driver suite tractable (ADR-039 Decision 1, §163).

**Do NOT add `schedule()` / `upsertScheduler` to `IJobOrchestrator`.** A core scheduling method would force a poll-driver scheduler loop into the core contract, breaking portability and memory-backend parity. Cadence stays event-shaped — a clock swap behind the events subsystem, not a job-orchestrator method. This is locked.

### 5. Bridge stays the seam — the reserved-pool relay, not a new ledger

The bridge remains the jobs worker draining the reserved `events_*` pools (ADR-023 Decision 2). The wrapper `job_run` insert stays exactly as it is — a raw, transactional insert (`BridgeOutboxDrainHook`, for FK-ordering + dedup correctness). What changes for an all-BullMQ stack is purely **how that committed wrapper row reaches a worker**: under Drizzle a polling worker claims it; under BullMQ there is no poll, so the BullMQ jobs side runs a **reserved-pool enqueue relay** (`BullMQJobOrchestrator.reconcilePending(pools)`, driven by a ~1s timer + a boot pass in `JobWorkerModule`). The relay re-`dispatch`es every pending run in the reserved pools it consumes; `dispatch` is idempotent (the wrapper's `jobId` is its `run.id`, so a re-add of an already-queued/in-flight job is a BullMQ no-op, and a claimed run is no longer `pending`). This is the **outbox-relay half of the transactional-outbox pattern** — the wrapper rows are an outbox BullMQ needs relayed — which is why it is correct for it to poll the (narrow, framework-only) reserved pools and why it is self-healing (a wrapper whose enqueue was lost to a Redis hiccup is re-dispatched on the next tick). It is scoped to reserved `events_*` pools only: regular runs are dispatched promptly by `start()`, so there is no race with a freshly-started regular run. Everything else is untouched:

- the `bridge_delivery` `UNIQUE(event_id, trigger_id)` ledger (ADR-023 §Schema);
- the per-event transaction (ADR-023 §"Outbox drain atomicity");
- Case-B pre-write dedup (the facade pre-writes `bridge_delivery(status=delivered)`, ADR-023 §"`publishAndStart` + existing `triggers:` collision").

This honors ADR-023's exactly-once invariant and avoids re-deriving idempotency from BullMQ `jobId` (which covers job-side dedup only, not the event→delivery pair). (An earlier draft proposed a synchronous "enqueue callback" on the wrapper insert; that was rejected for the **same reason Decision 2 flipped** — a Redis enqueue cannot be made atomic with the Postgres commit: a pre-commit enqueue races the wrapper's own visibility, and a post-commit enqueue still needs a backstop for a lost enqueue. The reserved-pool relay IS that backstop and the primary path in one mechanism.)

### 6. Jobs core-contract leaks are bugs, not extensions

Three core `StartOptions` fields were dropped by the BullMQ jobs backend. They are **core contract**, so the BullMQ backend must behave identically to Drizzle — these are leaks to close, not optional extensions (CLAUDE.md §"Backend swappability": app code written against the core must be portable). All three are shipped:

| `StartOptions` field | Drizzle behavior | BullMQ fix |
|---|---|---|
| `runAt` | one-shot future timestamp on the `job_run` | `dispatch` (`job-orchestrator.bullmq-backend.ts:220`) built `jobOpts` from retry + dedupe only (`:225`) and never read `run.runAt`; now maps to BullMQ `delay = max(0, runAt − now)` |
| `priority` | claim-ordering priority | was silently dropped; now sets the BullMQ `priority` job opt from `StartOptions.priority` |
| `collisionMode: 'queue'` | the Drizzle worker re-queues a claimed run when another run with the same `concurrencyKey` is active (`job-worker.ts:629-652`) | `BullMQJobWorker.process` defers via `moveToDelayed` + `DelayedError` (re-offer without consuming an attempt). **Discovered (BULLMQ-VERIFY):** BullMQ claims up to `concurrency` jobs at once, so a plain SELECT-then-mark gate races — two same-key processors both read "none running" and both proceed. The check + the `status='running'` mark must therefore be ATOMIC: `claimConcurrencyLane` wraps them in a tx behind a per-key `pg_advisory_xact_lock(hashtextextended(key))`, so at most one same-key run is ever `running`. (Strictly more robust than the Drizzle gate, which marks-running-then-releases-on-conflict and is only exercised sequentially.) |

Until all three are broker-verified, flipping a consumer to `jobs.backend: bullmq` silently mis-behaves for scheduled/delayed, prioritized, and serialized jobs.

### 7. Verification is the gating deliverable

The broker round-trip had **never executed in-repo** for jobs (BULLMQ-1 §Verification is explicit and honest about this). The gate, **as built**:

- `test/integration/bullmq.integration.test.ts` — a **Docker-gated testcontainers recipe** (ephemeral `postgres:16` + `redis:7-alpine`), parallel to the existing Postgres integration recipes, **out of `test-all`**, gracefully skipped when Docker is unavailable (`just test-bullmq-integration`). It exercises the real BullMQ broker round-trip end-to-end:
  - **Jobs** — `start → dispatch → worker → completed`, `runAt` delay, `collisionMode:'queue'` serialization, terminal failure → `status='failed'`, priority mapping (Decision 6).
  - **Scheduler driver** — under `events.scheduler.driver: bullmq`, `upsertJobScheduler` registers a scheduled event; a fired tick calls `EVENT_BUS.materializeScheduledEvent(...)` on the **Drizzle** bus; the `domain_events` row appears exactly once per slot (slot-key `ON CONFLICT` collapses duplicates) and drains via `pg_notify → bridge → wrapper + user job_run`. **There is no BullMQ event wake to test** — events never travel over BullMQ (Decision 2); what is tested is the BullMQ *clock firing a tick into the Drizzle bus*.
  - **Reconcile + prune** — removing a schedule and rebooting prunes the orphan Job Scheduler (no zombie firing); adding one upserts it.
  - **Fail-loud** — a schedule with `align: false` / `catchUp: true` under `driver: bullmq` throws at boot.
- Scope note: this is a **BullMQ-focused round-trip** (it instantiates the bullmq classes directly), NOT a single parametrized `IJobOrchestrator`/`IEventBus` suite shared across drizzle/memory/bullmq — drizzle/memory keep their existing separate unit + drizzle-integration suites. The substantive gap BULLMQ-1 flagged (the broker path) is closed; a unified cross-backend harness remains possible future work.

Both the BullMQ jobs backend and the BullMQ scheduler driver stay **opt-in** (defaults `jobs.backend: drizzle`, `events.scheduler.driver: poll`) until that round-trip is green in a consumer's CI — exactly as ADR-022 §claim requires for port promotion and as BULLMQ-1 §Verification chose. The codegen-patterns repo ships `runtime/` into consumer projects and does **not** depend on a Postgres driver (`pg`), so the broker path may only run where Docker + Redis + Postgres are available; the green unit suite proves wiring and pure helpers (e.g. `forRoot({ scheduler: { driver: 'bullmq' } })` resolves `BullMqEventSchedulerLifecycle` *without* opening a Redis connection; a static-source scan asserts zero top-level value imports of `'bullmq'`), **not** the broker round-trip (do not mistake one for the other).

## What was removed

The option-#2 pivot deletes the bespoke events-on-BullMQ machinery the original Decision 2 specified:

- **`BullMQEventBus` (the bespoke durable BullMQ events backend) — DELETED.** It carried published events over a BullMQ wake queue with a slow safety heartbeat backstop. It made BullMQ the commit-signal, which cannot be atomic with a Postgres commit, so it was slower and weaker than the Drizzle + `pg_notify` path. There is no `event-bus.bullmq-backend.ts`, no `backend: 'bullmq'` arm in the events module union, no `loadBullMqEventBus` lazy loader, no events `bullmq` arm in the barrel composer.
- **`EVENTS_BULLMQ_CONNECTION` is now scheduler-only.** The token is **kept**, but its role narrows: it was the BullMQ events-bus connection; it is now the connection `BullMqEventSchedulerLifecycle` uses to talk to the Job Scheduler. No event ever travels over it.
- **`RedisEventBus` (the fire-and-forget Pub/Sub backend) — STAYS DELETED** (Decision 3). Option #2 does not revive it; `events.backend` is `drizzle | memory`, full stop.

Net events-transport surface: **`drizzle | memory`**. Net scheduler surface: **`poll | bullmq`** (the latter relocated to a standalone, auto-pruned, lazy-loaded file). The `domain_events` outbox schema is **unchanged** — Drizzle stays the event store under every scheduler driver. There is no schema-skip concern (that only ever applied to the abandoned Postgres-free events variant, which option #2 does not build).

## Consequences

### What gets simpler

- **One mental model end-to-end.** Time, use-case publishes, and webhooks are all event *sources*; the bridge is the single activation seam; `job_run` is the single work source of truth. The all-BullMQ stack runs the exact same activation model the Drizzle stack does — only the *clock* (Decision 4) and the *job executor* (Decision 6) move to BullMQ; the event transport does not.
- **The bridge's correctness argument carries over for free.** Because events stay on the Postgres outbox + `pg_notify`, the entire ADR-023 same-tx exactly-once proof applies unchanged. No new idempotency machinery, no cross-store transaction to invent.
- **Flood-resistance is structural, not tuned.** The backlog lives in PG and is *pulled* at a bounded rate (concurrency + lane isolation), with a *coarse* per-lane `pg_notify` doorbell — not a per-row push into a transport. This is exactly what the dealbrain 20k-item flood (push + events==work) lacked (see [§The data-flow seam](#the-data-flow-seam-the-big-idea)).
- **One Redis by default.** The scheduler driver resolves its connection from `events.extensions.bullmq.redis_url → REDIS_URL env → localhost` — the same `REDIS_URL` default the jobs subsystem uses — so jobs and the scheduler clock share a broker out of the box. As built, the scheduler uses a **self-contained `EVENTS_BULLMQ_CONNECTION` token** (not the jobs `BULLMQ_CONNECTION`) to avoid forcing an events-only install to vendor `jobs/bullmq.config.ts`; see BULLMQ-2.
- **The dead Redis Pub/Sub bus is gone.** One fewer un-installable, non-transactional backend to reason about or warn around.
- **The dispatch surface is a small typed vocabulary.** Three speeds (`direct` / `eager` / `deliberate`), one `DispatchMode` type, no fourth raw-`queue.add` escape hatch.

### What is riskier

- **Zombie-scheduler regression.** A broker-side Job Scheduler can leave orphan schedulers firing forever (ENG-605). Guarded by **mandatory prune-orphans-on-boot** (Decision 4); running both the `setInterval` materializer/slot index AND the BullMQ scheduler driver would double-fire, so exactly one is the clock at a time. This is the single highest-risk part of the design and the reconcile half is non-negotiable.
- **Silent default-flip footgun.** `runAt` delay, `priority` ordering, and `collisionMode: 'queue'` were honored by Drizzle but no-ops under BullMQ (Decision 6). They MUST be broker-verified before any consumer flips `jobs.backend: bullmq`, or scheduled/priority/serialized jobs misbehave silently.
- **Optional-peer footguns.** `event-scheduler.bullmq-backend.ts` must use type-only `bullmq` imports + `await import('bullmq')`, must not be re-exported from `events/index.ts`, must be bound via a lazy `useFactory` in `EventsModule`, and relies on the `.bullmq-backend.ts` suffix filter (`backendFileFilter`, `subsystem.ts`). Any slip drags the optional peer into drizzle consumers' tsc (`TS2307` / smoke-subsystems `findStaticPeerImports` failure). One packaging subtlety: the filter must vendor the scheduler file when `events.scheduler.driver: bullmq` *even on a `drizzle` events backend* — the one place the driver-vs-backend split touches packaging.
- **`align: false` / `catchUp` are a driver-capability cliff.** They work under `poll` and fail loud under `bullmq` (Decision 4). A consumer relying on bounded backfill must keep `driver: poll` for those event types — the boot-time error names the offending type, but the constraint is real.
- **Unverified end-to-end.** The whole BullMQ path is unproven against a real broker (Decision 7). "Fully functional" is blocked on the Docker-gated round-trip; the green unit suite is necessary but not sufficient.
- **Config enum tightening.** The codegen config is `.passthrough()`, so a typo'd backend/driver falls through to a module switch default. The events backend enum (`drizzle | memory` — `bullmq`/`redis` removed), the new `events.scheduler.driver` enum (`poll | bullmq`), and the jobs backend enum must all be tightened with throwing defaults, or a misconfig (e.g. `backend: bullmq`, the now-deleted value, or `driver: redis`) silently picks the wrong path.

### Neutral

- **No `domain_events` schema change.** Drizzle is always the event store, under both scheduler drivers; the events outbox table and the partial UNIQUE slot-key index stay. (The hypothetical Postgres-free events variant that would have needed a schema-skip is not built — option #2 never moves the event log off Postgres.)
- **`DISPATCH-1` is a fast-follow with a dependency.** The declarative per-trigger `dispatch:` knob reopens ADR-023's rejected alternatives F/G and so needs an ADR-023 revision before it lands. This ADR ships only the runtime `DispatchMode` vocabulary; the emitter is deferred.

## Alternatives considered

- **A. Events and jobs as one BullMQ dispatch path** (dealbrain's status quo). Rejected — see Decision 1; it is exactly what Doug's architecture doc says to undo, and it is the source of the 20k-item push-flood the seam exists to prevent.
- **B1. A durable `BullMQEventBus` over the Postgres outbox** (the original Decision 2: outbox write in the caller's tx, then a BullMQ wake instead of the drain). **Rejected** — the wake cannot be atomic with the commit, so it needs a heartbeat backstop, making it slower and weaker than `pg_notify` for zero portability gain. This is the option-#2 pivot.
- **B2. A Redis-resident durable event log** (BullMQ Queue / Redis Streams as the event store). Rejected — see Decision 2; forks the source-of-truth story from jobs, forces a hand-rolled re-derivation of the `bridge_delivery` ledger with no cross-store transaction, and moves the durable terminus off the database that owns the admitted data.
- **C. Keep `RedisEventBus` as a fire-and-forget option.** Rejected — see Decision 3; un-installable, non-transactional, bridge/scheduler-incompatible, no consumer needs Pub/Sub semantics.
- **D. Add `schedule()` / `upsertScheduler` to `IJobOrchestrator`.** Rejected — see Decision 4; forces a scheduler loop into the core contract and breaks Drizzle/Memory parity. Cadence stays event-shaped.
- **E. BullMQ Job Scheduler fires the user job directly** (bypassing the outbox). Rejected — see Decision 4; it splits the activation model (the direct-fired job skips the bridge and the `bridge_delivery` ledger) and removes `job_run`-as-source-of-truth for scheduled work. The tick re-entering the Drizzle bus via `materializeScheduledEvent` keeps cron, RFC-0005, and the bridge on one path. ADR-039 §159 favors this ("a repeatable producer of the same event").
- **F. A synchronous enqueue callback on the wrapper insert** (the original Decision 5 sketch). Rejected — same blocker as B1: a Redis enqueue cannot be made atomic with the Postgres commit. The reserved-pool relay is the backstop-and-primary-path in one mechanism (Decision 5).

## Cross-links and supersede notes

- **2026-06-15 (original)** — This ADR is the all-BullMQ topology decision. It composes BULLMQ-1 (jobs backend) + ADR-039 (scheduling contract) + ADR-023 (bridge) into one end state.
- **2026-06-15 (option-#2 pivot)** — Decision 2 flipped: events stay on Drizzle + `pg_notify`; BullMQ is never the event transport. The bespoke `BullMQEventBus` was deleted; the scheduler relocated to a standalone `event-scheduler.bullmq-backend.ts` (`BullMqEventSchedulerLifecycle`) behind `events.scheduler.driver: poll | bullmq`. Added the data-flow seam + three-dispatch-speeds sections. See [Revision](#revision-2026-06-15--option-2-pivot).
- **`docs/specs/BULLMQ-2.md`** — implements Decisions 3, 4 (events half, option #2): the standalone `event-scheduler.bullmq-backend.ts` scheduler driver, the `RedisEventBus` deletion, the `BullMQEventBus` deletion, and the `events.scheduler.driver` knob. Its supersede note, "data-flow seam," and "three canonical dispatch speeds" sections are the canonical framing this ADR mirrors.
- **`docs/specs/DISPATCH-1.md`** — the fast-follow: the codegen-declarative `dispatch:` knob on event-arm triggers. This ADR ships the `DispatchMode` vocabulary (`runtime/subsystems/bridge/bridge.protocol.ts`); DISPATCH-1 makes it declarable and **requires an ADR-023 revision** (it reopens ADR-023's rejected alternatives F/G).
- **`docs/specs/BULLMQ-1.md`** — implements Decision 6 (jobs core-contract leaks: `runAt`/`priority`/`collisionMode:'queue'`) and the Decision 7 verification harness. BULLMQ-1 §Extensions' "cron is out of scope (ADR-025)" pointer is stale (ADR-025 is the Combiner Subsystems ADR; ADR-039 is scheduling territory) — **to be replaced in BULLMQ-1 during implementation** with the ADR-039 / ADR-041 mapping. (This ADR does not edit BULLMQ-1.)
- **`docs/adrs/ADR-039-declarative-time-based-scheduling.md`** §159 — the committed `schedule:` → `upsertJobScheduler` mapping this ADR locks (interval-only, reconcile-on-boot = upsert-desired + prune-orphans, repeatable body emits the same domain event via `materializeScheduledEvent`). The "BullMQ backend" framing there should read "BullMQ scheduler **driver**" — the materializer relocated to a scheduler-driver file; the event bus stayed on Drizzle. **To be marked shipped in ADR-039 §159 when the driver lands** (this ADR does not edit ADR-039).
- **`docs/specs/dealbrain-bullmq-audit.md`** §"Is BullMQ also the event bus?" / §Recommendation — the audit conclusion (separate `IEventBus` + `IJobOrchestrator`) and the 20k-item push-flood this ADR's seam is designed to prevent.
- **`ADR-022-job-orchestration-domain-model.md`** §claim — the port-promotion gate (2nd impl + broker round-trip) that keeps the BullMQ jobs backend and scheduler driver opt-in until green.
