# BULLMQ-2 — BullMQ scheduler driver for events (option #2)

**Status:** Draft (implementation in progress on `feat/bullmq-jobs-events-automation`)
**Date:** 2026-06-15
**Owner:** Doug
**Decision:** ADR-041 (all-BullMQ topology) — option #2
**Related:** BULLMQ-1 (`docs/specs/BULLMQ-1.md` — the BullMQ `IJobOrchestrator` backend), ADR-039 (the `schedule:` contract + `EventScheduler`), ADR-023 (the bridge + `bridge_delivery` ledger), ADR-024 (the `domain_events` outbox), DISPATCH-1 (`docs/specs/DISPATCH-1.md` — the codegen-declarative dispatch knob, fast-follow)
**Depends on:** BULLMQ-1 (jobs backend installable + `bullmq` connection machinery), ADR-039 (the generated `eventRegistry` `schedule` blocks)

---

## 2026-06-15 — Supersede note (the option-#2 pivot)

> **This spec previously described a "durable BullMQ events backend" (`BullMQEventBus` carrying events over a BullMQ wake queue). That framing is superseded.** Events stay on Drizzle + `pg_notify` (the proven transactional outbox). BullMQ's role narrows to **jobs executor + scheduler/clock** — it never becomes the event transport. What moves onto BullMQ is the *scheduler*, not the event log. The rest of this document is the option-#2 design; the old "what was removed" is recorded in [§What was removed](#what-was-removed).

## Problem & goal

An all-BullMQ stack wants two things on one Redis: jobs executed by BullMQ (BULLMQ-1, shipped) and recurring/cron events fired by BullMQ's clock. The first draft of this spec tried to also put the **event transport** on BullMQ — a bespoke `BullMQEventBus` that carried published events over a BullMQ wake queue, plus a slow safety heartbeat as the correctness backstop.

That design was **abandoned during implementation** for a structural reason, not a tuning one:

> **A Redis wake cannot be atomic with a Postgres commit.** The Drizzle outbox commits the `domain_events` row and signals readers via `pg_notify` *in the same transaction* — the notify fires exactly when (and only when) the row becomes visible, by Postgres's own commit machinery. A BullMQ wake enqueued inside the caller's transaction can fire *before* the row is visible (or never, if the tx rolls back), so the design needed a slow polling heartbeat as a backstop. Net: making BullMQ the commit-signal was **slower and weaker** than the Drizzle path it replaced — it bought a Redis dependency and a heartbeat to be *worse* than `pg_notify`.

The locked conclusion (ADR-041, option #2):

- **Events stay on Drizzle + `pg_notify`.** The transactional outbox is the proven, instant-on-commit signal. `events.backend = drizzle | memory` only.
- **BullMQ is the jobs executor and the scheduler/clock.** "Events on BullMQ" means the *jobs that events trigger* run on BullMQ (BULLMQ-1) and recurring/cron events *fire* via BullMQ's Job Scheduler — **not** that the event log lives in Redis.
- **The scheduler relocates** out of the (now-deleted) bespoke events backend into a standalone `event-scheduler.bullmq-backend.ts`, selected by a new, orthogonal config knob `events.scheduler.driver: 'poll' | 'bullmq'`.

This is **additive on the scheduler side and subtractive on the bespoke events backend.** A new scheduler-driver file + a `scheduler.driver: 'bullmq'` branch; minus the entire `BullMQEventBus`. The core `IEventBus` protocol and every event publisher are untouched — flipping `events.scheduler.driver: bullmq` changes only *who emits scheduled ticks*, not how events are stored, published, drained, or bridged.

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
- **A coarse `pg_notify` signals "we landed admitted data in lane X."** It is a *doorbell per lane*, not a per-row push. The notify says "there is work to pull"; it does not carry the work.
- **The app pulls the backlog from PG at its own bounded rate and coalesces.** Drain rate is metered by worker concurrency + lane isolation. The backlog lives in PG, durable; the app pulls it down as fast as it safely can, collapsing redundant reactions.

**Why this is flood-resistant.** The dealbrain 20k-item event-queue flood came from *push + events==work*: every landed item pushed a work-item into a transport, so a backfill of 20k rows became 20k queued work-items hammering the broker. Here the backlog stays in PG and is *pulled* — bounded by concurrency and lane isolation — so a 20k-row backfill is a 20k-row table the app drains at its chosen rate, not 20k pushed messages. The coarse per-lane notify means a flood produces *one* doorbell per lane, not one per row.

**Two regimes.** *Backfill* (20k rows land at once) and *steady-state* (a trickle) are different problems. The storm path needs deliberate **coalescing on reaction-cardinality, not item-cardinality**: if 5,000 messages land for one channel and the reaction is "re-summarize the channel," that is *one* reaction, not 5,000. Coalescing collapses to the cardinality of distinct reactions, which is what bounds the storm.

This seam is why events stay on Drizzle: the durable terminus *is* the Postgres outbox, and the doorbell *is* `pg_notify`. Putting the event log in Redis would move the durable terminus off the database that already owns the admitted data — re-introducing the push-flood failure mode the seam exists to prevent.

## The three canonical dispatch speeds

The system exposes exactly **three** sanctioned ways to turn data into started work, typed as a single vocabulary:

```ts
type DispatchMode = 'direct' | 'eager' | 'deliberate';
```

| Mode | Call | What happens | Writes | Latency | Use when |
|---|---|---|---|---|---|
| **`direct`** | `IJobOrchestrator.start()` | enqueue a job, no event | 1 `job_run` + enqueue | instant | actionability is already proven *before* the data reaches you (pre-admitted sources — e.g. a Slack webhook whose payload is itself the proof) |
| **`eager`** | `IEventFlow.publishAndStart()` | event + job + `bridge_delivery`, in ONE tx | outbox row + `job_run` + ledger row, atomically | ~instant | you want the fact *recorded* AND the work *started* together, in the request path, durably |
| **`deliberate`** | `IEventFlow.publish()` + bridge drain | event recorded, fanout async | outbox row; jobs spawned by the bridge | flood-resistant pull (2–3 poll/drain hops) | you must inspect state to decide what (if anything) runs; durable async fanout; the storm path |

**Choice rule.** *If actionability is proven before the data reaches you → `direct` or `eager`. If you must inspect state to decide → `deliberate`.* `direct` skips the event entirely (the source already proved the work is warranted); `eager` records the fact alongside the work (you want both, atomically); `deliberate` records the fact and lets the bridge decide the fanout asynchronously at a bounded pull rate.

**Raw `queue.add` / a Postgres-free ephemeral path is explicitly NOT a public option.** Every sanctioned speed writes to Postgres (a `job_run` and/or a `domain_events` row) — the durable terminus of the seam. A bare `queue.add` would push work into a transport with no durable terminus and no ledger, which is precisely the dealbrain push-flood failure mode. The three speeds are the whole surface; there is no fourth "fire and forget into Redis" option.

> **Scope:** this spec ships the **typed `DispatchMode` vocabulary** and the three runtime call shapes (`start` / `publishAndStart` / `publish` — all of which already exist). It does **not** ship a way to *declare* per-trigger dispatch speed in YAML — that is the fast-follow DISPATCH-1 (`docs/specs/DISPATCH-1.md`). Here the vocabulary lands; the declarative emitter is deferred.

## The design — `event-scheduler.bullmq-backend.ts`

### What it is

A standalone runtime file `runtime/subsystems/events/event-scheduler.bullmq-backend.ts` exporting **`BullMqEventSchedulerLifecycle`** — a Nest lifecycle (`OnApplicationBootstrap` / `OnModuleDestroy`) that *relocates the BullMQ Job Scheduler* out of the deleted events backend. It is the BullMQ peer of the in-process `EventScheduler` `setInterval` loop (ADR-039 Decision 2): same job, different clock.

It does **not** store, transport, or drain events. It only fires ticks. Each tick re-enters the *Drizzle* event bus, which then drains via `pg_notify → bridge → job` exactly as it does for a use-case publish or a webhook.

### What it does

- **Reads the schedule blocks** from the generated `eventRegistry` (`scheduledEventsFromRegistry` — each scheduled event carries its `schedule` block, ADR-039). The schedule blocks are injected on `EVENTS_MODULE_OPTIONS`.
- **Registers** one BullMQ Job Scheduler per scheduled-event type via `upsertJobScheduler` (deterministic id `@schedule/<type>`), mapping `{ every }` → `{ every: ms }`.
- **Reconcile-on-boot = upsert-desired + prune-orphans (MANDATORY — the ENG-605 guard).** On `OnApplicationBootstrap`: `upsertJobScheduler` every desired scheduler AND enumerate the broker's existing schedulers (`getJobSchedulers`) and `removeJobScheduler` for any not in the current `eventRegistry`. This closes the ENG-605 zombie-scheduler hole (ADR-039 §44, §177) — the one failure mode the outbox model structurally avoided and a broker-side scheduler re-introduces. A removed `schedule:` whose Job Scheduler is left in the broker fires forever; prune is not optional.
- **On each tick** the scheduler worker computes the epoch-aligned slot and calls **`EVENT_BUS.materializeScheduledEvent({ type, slotKey, slotStart, direction, pool })`** — emitting the **same** scheduled domain event the Drizzle path emits (payload-free fact, `metadata.triggerSource = 'schedule'`, `metadata.scheduleSlot = <slotKey>`). Because `EVENT_BUS` is the **Drizzle bus**, this is an outbox insert with `ON CONFLICT (type, schedule_slot) DO NOTHING` — the exactly-one-event-per-slot invariant holds, and the row drains the normal way: `pg_notify` → bridge → wrapper + user job. Time → fact → bridge → job, unchanged; `job_run` stays the source of truth.

Using `materializeScheduledEvent` (not raw `publish`) is load-bearing: BullMQ emits one tick per interval cluster-wide, and the slot-key `ON CONFLICT` collapses any within-slot duplicate (boot racing a tick, two instances). This is ADR-039's slot-keyed idempotency, driven by the BullMQ clock instead of the `setInterval` loop.

### `align: false` / `catchUp` are rejected (fail loud) under the bullmq driver

The BullMQ Job Scheduler is an epoch-aligned interval clock with no notion of "replay the slots I missed while down." So under `events.scheduler.driver: bullmq`:

- `align: false` — **rejected, fail loud at boot.** The bullmq driver only does epoch-aligned slots.
- `catchUp: true` (and `maxCatchUpSlots`) — **rejected, fail loud at boot.** Backfilling missed slots is a poll-driver capability (ADR-039 Decision 3: bounded backfill from `lastEmittedSlot + 1`); the bullmq driver runs once on recovery and does not replay.

A schedule block using either knob fails at boot with a clear error naming the offending event type and pointing at `events.scheduler.driver: poll` for those semantics. (Do not silently degrade — silently dropping `catchUp` would skip windows a rollup must not skip; per the smoke-filter principle, fail loud rather than paper over.)

### Selected by `events.scheduler.driver`

A **new config knob** governs which scheduler fires ticks:

```yaml
events:
  backend: drizzle            # event TRANSPORT — drizzle | memory (NOT bullmq)
  scheduler:
    driver: bullmq            # scheduler CLOCK — poll | bullmq (default: poll)
  extensions:
    bullmq:
      redis_url: redis://localhost:6379   # or env REDIS_URL (shared with jobs by default)
      queue_prefix: myapp                  # namespaces the events-scheduler queue on a shared Redis
```

- **`events.scheduler.driver: 'poll' | 'bullmq'`** — default `'poll'`. `poll` keeps the ADR-039 in-process `EventScheduler` `setInterval` materializer; `bullmq` swaps in `BullMqEventSchedulerLifecycle`.
- It is **orthogonal to `events.backend` and `jobs.backend`.** Scheduling (when does a fact recur?) and event-transport (how is a fact stored/signaled?) are independent concerns. A perfectly normal stack is `events.backend: drizzle` + `events.scheduler.driver: bullmq` + `jobs.backend: bullmq` — Drizzle owns the outbox, BullMQ owns the clock *and* the job execution. The driver is NOT `events.backend: bullmq` (there is no such value any more).
- **Exactly one scheduler source of truth.** Under `driver: bullmq`, the in-process `EventScheduler` `setInterval` loop does NOT run (the `forRoot` branch omits `EventSchedulerLifecycle`); under `driver: poll`, the BullMQ lifecycle is not provided. The slot-key `ON CONFLICT` insert is the shared idempotency guard either way — driven by whichever clock is active. Running both double-fires.

### Optional-peer handling

`bullmq` is an OPTIONAL peer dependency, and the scheduler-driver file must never drag it into a non-bullmq install:

- **File name `*.bullmq-backend.ts`** — the subsystem-agnostic `backendFileFilter` (`subsystem.ts`) auto-prunes the file from any install whose scheduler driver is not `bullmq`, mirroring the BullMQ jobs backend files. A poll-driver consumer never vendors it.
- **Type-only `bullmq` import** + **lazy `await import('bullmq')`** at first use (wrapped in try/catch → friendly `'BullMQ scheduler driver requires the "bullmq" package. Install it with: npm install bullmq'`). Types are erased; the value constructors load only when the driver actually runs.
- **Never re-exported from the events barrel** (`events/index.ts`) — the public barrel stays free of the optional peer. Slip here drags `bullmq` into drizzle consumers' tsc (`TS2307` / smoke-subsystems `findStaticPeerImports` failure).
- **Lazy-loaded via a `useFactory` in `EventsModule`** — the `driver: 'bullmq'` branch binds `BullMqEventSchedulerLifecycle` through a `useFactory` that `await`s the dynamic import (non-literal specifier), so the consumer's tsc never resolves the pruned file for a poll-driver install.

### What it injects

`BullMqEventSchedulerLifecycle` injects:

- **`EVENT_BUS`** — the Drizzle bus it calls `materializeScheduledEvent(...)` on each tick. (The whole point: the tick re-enters the Drizzle path.)
- **`EVENTS_BULLMQ_CONNECTION`** — the Redis connection token, **kept** from the deleted backend's wiring (it is now the scheduler's connection, not the event bus's). Resolves `events.extensions.bullmq.redis_url → process.env.REDIS_URL → redis://localhost:6379` — the same `REDIS_URL` default the jobs config uses, so one Redis by default; a divergent `redis_url` opts into two.
- **The `eventRegistry` schedule blocks** — injected on `EVENTS_MODULE_OPTIONS` (the generated registry's scheduled-event set).

## `events.module.ts` wiring (driver branch)

Symmetric to the deleted `bullmq` *backend* branch, but the driver branch touches only the scheduler, never the bus binding:

- **`EventsModuleOptions.backend`** union: `'drizzle' | 'memory'` only. The `'bullmq'` arm (and the old `'redis'` arm) are removed.
- **`EventsModuleOptions.scheduler?.driver`** — new optional field, `'poll' | 'bullmq'`, default `'poll'`.
- **`forRoot` `EVENT_BUS` binding is unchanged** — `drizzle` or `memory`, exactly as before. The driver does not touch the bus factory.
- **Scheduler provision is driver-gated:**
  - `driver: 'poll'` (default) → provide `EventSchedulerLifecycle` (the `setInterval` materializer, ADR-039), as today.
  - `driver: 'bullmq'` → provide `BullMqEventSchedulerLifecycle` via a `useFactory` that lazy-imports `event-scheduler.bullmq-backend`, injecting `EVENT_BUS` + `EVENTS_BULLMQ_CONNECTION` + `EVENTS_MODULE_OPTIONS`. Do NOT provide `EventSchedulerLifecycle` in this branch.
- **Config enum tightening + throwing default.** The events backend enum drops `redis` and `bullmq` (now `drizzle | memory`); the scheduler-driver enum is `poll | bullmq` with a throwing default on an unknown value (the config is `.passthrough()`, so a typo'd driver must not fall through silently).

## What was removed

The option-#2 pivot deletes the bespoke events-on-BullMQ machinery the earlier draft of this spec specified:

- **`BullMQEventBus` (the bespoke durable BullMQ events backend) — DELETED.** It carried published events over a BullMQ `events-wake` queue with a slow safety heartbeat backstop. It made BullMQ the commit-signal, which cannot be atomic with a Postgres commit, so it was slower and weaker than the Drizzle + `pg_notify` path. There is no `event-bus.bullmq-backend.ts`, no `backend: 'bullmq'` arm in the events module union, no `loadBullMqEventBus` lazy loader, no events `bullmq` arm in the barrel composer.
- **`EVENTS_BULLMQ_CONNECTION` is now scheduler-only.** The token is **kept**, but its role narrows: it was the BullMQ events-bus connection; it is now the connection the `BullMqEventSchedulerLifecycle` uses to talk to the Job Scheduler. No event ever travels over it.
- **`RedisEventBus` (the fire-and-forget Pub/Sub backend) — STAYS DELETED.** It was already removed (un-installable via CLI, `findById → null`, non-transactional, bridge/scheduler-incompatible). Option #2 does not revive it; `events.backend` is `drizzle | memory`, full stop.

Net events-backend surface: **`drizzle | memory`**. Net scheduler surface: **`poll | bullmq`** (the latter relocated to a standalone, auto-pruned, lazy-loaded file).

> The `domain_events` outbox schema is **unchanged** — Drizzle stays the event store under every driver. There is no schema-skip concern (that only ever applied to the abandoned Postgres-free events variant, which option #2 does not build).

## New / changed files

- **`runtime/subsystems/events/event-scheduler.bullmq-backend.ts`** (new) — `BullMqEventSchedulerLifecycle` (`OnApplicationBootstrap` / `OnModuleDestroy`). Type-only `bullmq` import + `await import('bullmq')` lazy load. Reads schedule blocks from the injected `eventRegistry`; `upsertJobScheduler` + prune-orphans on boot; each tick computes the epoch-aligned slot and calls `EVENT_BUS.materializeScheduledEvent(...)` (the Drizzle bus); `align: false` / `catchUp` fail loud. Never re-exported from the barrel.
- **`runtime/subsystems/events/events.module.ts`** (changed) — backend union `drizzle | memory`; new `scheduler?.driver` option; driver-gated scheduler provision (`EventSchedulerLifecycle` for `poll`, `BullMqEventSchedulerLifecycle` via `useFactory` for `bullmq`); throwing default on unknown driver. `EVENT_BUS` binding untouched.
- **Config schema** (changed) — `events.scheduler.driver: 'poll' | 'bullmq'` (default `poll`); events backend enum tightened to `drizzle | memory`.
- **Unit spec** — `event-scheduler.bullmq.spec.ts`: `forRoot({ scheduler: { driver: 'bullmq' } })` resolves `BullMqEventSchedulerLifecycle` *without* opening a Redis connection; a static-source scan asserts zero top-level value imports of `'bullmq'`; the lifecycle registers/prunes from a fixture registry; `align: false` / `catchUp` throw at boot. The broker round-trip (a real tick into the Drizzle bus) is the Docker-gated integration test (below), not here.

## CLI / packaging

- **`backendFileFilter`** already prunes `*.bullmq-backend.ts` from non-bullmq installs (subsystem-agnostic). The scheduler-driver file rides that filter — vendored when the driver is `bullmq`, pruned otherwise. (If the filter keys off `--backend`, the install flow must additionally vendor the scheduler file when `events.scheduler.driver: bullmq` even on a `drizzle` events backend — the one place the driver-vs-backend split touches packaging.)
- **Do NOT re-export `BullMqEventSchedulerLifecycle`** from `events/index.ts`.
- **`domain_events` schema STAYS** under every driver (Drizzle is always the event store).

## Gotchas

1. **Optional-peer footguns.** Type-only `bullmq` imports + `await import('bullmq')` only; never a top-level value import; never re-export the lifecycle from `events/index.ts`. Any slip drags the optional peer into drizzle consumers' tsc (`TS2307` / `findStaticPeerImports` failure). Pin with a static-source regression test + a runtime check that resolving the lifecycle leaves the lazy import unloaded.
2. **Zombie-scheduler hazard (prune-orphans MANDATORY).** A broker-side Job Scheduler re-introduces the ENG-605 class the outbox model structurally avoided (ADR-039 §44, §177). Reconcile-on-boot MUST upsert-desired AND prune-orphans. The highest-risk part of this spec.
3. **Exactly one scheduler source of truth.** Under `driver: bullmq`, the in-process `EventScheduler` `setInterval` loop MUST NOT run; under `driver: poll`, the BullMQ lifecycle MUST NOT be provided. Running both double-fires (one tick from each). The slot-key `ON CONFLICT` insert is the shared guard.
4. **The tick re-enters the Drizzle bus.** `BullMqEventSchedulerLifecycle` calls `EVENT_BUS.materializeScheduledEvent(...)`, where `EVENT_BUS` is the Drizzle bus. It does NOT publish to BullMQ, fire the user job directly, or bypass the outbox. The clock moves to BullMQ; the fact still lands in Postgres and drains via `pg_notify → bridge → job`. Do not "optimize" the tick to fire the job directly — that splits the activation model and bypasses the ledger.
5. **`align: false` / `catchUp` fail loud, never silently degrade.** A schedule using either under the bullmq driver throws at boot. Silently dropping `catchUp` would skip windows a rollup must not skip (smoke-filter principle: fail loud, do not paper over).
6. **Config enum + throwing default.** `events.backend` is `drizzle | memory`; `events.scheduler.driver` is `poll | bullmq`. Both need a throwing default — the config is `.passthrough()`, so a typo'd `backend: bullmq` (the now-deleted value) or `driver: redis` must fail loud, not fall through.

## Verification

The gating deliverable is the **Docker-gated broker round-trip** (testcontainers `postgres:16` + `redis:7-alpine`, gracefully skipped without Docker, **out of `test-all`**). The round-trip now covers the option-#2 path:

- **Scheduler tick into the Drizzle bus** — `upsertJobScheduler` registers a scheduled event; a fired tick calls `EVENT_BUS.materializeScheduledEvent(...)`; the `domain_events` row appears exactly once per slot (slot-key `ON CONFLICT` collapses duplicates); the row drains via `pg_notify` → bridge → wrapper + user `job_run`. This replaces the old "events `publish → wake → drain → findById`" round-trip — there is no BullMQ wake to test, because events never travel over BullMQ.
- **Reconcile + prune** — removing a schedule and rebooting prunes the orphan Job Scheduler (no zombie firing); adding one upserts it.
- **Fail-loud** — a schedule with `align: false` / `catchUp: true` under `driver: bullmq` throws at boot.
- **Jobs round-trip** — unchanged from BULLMQ-1 (`start → dispatch → worker → completed/failed/retry`, `runAt` delay, `collisionMode:'queue'`, priority).

**Honest note (mirrors BULLMQ-1 §Verification).** This codegen-patterns repo ships `runtime/` INTO consumer projects and does not depend on a Postgres driver (`pg`). Every in-repo events test uses the Memory backend or a `drizzle(pg-proxy)` mock that never talks to a real DB. The broker round-trip runs only where Docker + Redis + Postgres are available; the in-repo unit suite proves the wiring (`forRoot` resolves `BullMqEventSchedulerLifecycle` without connecting), the optional-peer hygiene (no static `'bullmq'` import), the register/prune logic against a fixture, and the `align: false` / `catchUp` fail-loud — it does NOT prove the broker round-trip, and must not be faked to. Until that is green in a consumer's CI, `events.scheduler.driver: bullmq` stays **opt-in** (default `poll`).

## Cross-links

- `docs/adrs/ADR-041-all-bullmq-topology.md` — the deciding ADR (option #2: events on Drizzle + `pg_notify`; BullMQ = jobs executor + scheduler/clock).
- `docs/specs/DISPATCH-1.md` — the fast-follow: the codegen-declarative `dispatch:` knob on event-arm triggers. This spec ships the `DispatchMode` vocabulary; DISPATCH-1 makes it declarable.
- `docs/specs/BULLMQ-1.md` — the jobs BullMQ backend (the executor half of "events on BullMQ"); the optional-peer lazy-load contract this scheduler file mirrors.
- `docs/adrs/ADR-039-declarative-time-based-scheduling.md` §158–159 — the `schedule:` → `upsertJobScheduler` mapping (interval-only, reconcile = upsert + prune, the tick produces the same scheduled domain event). The "BullMQ backend" framing there should read "BullMQ scheduler driver" — the materializer relocated to a scheduler-driver file, the event bus stayed on Drizzle.
- `docs/adrs/ADR-023-event-to-job-bridge.md` — the `bridge_delivery` ledger + per-event tx the scheduled tick drains through, unchanged.
- `docs/consumer/events.md` — consumer-facing: `events.backend = drizzle | memory`, `events.scheduler.driver = poll | bullmq`, and the three dispatch speeds.
