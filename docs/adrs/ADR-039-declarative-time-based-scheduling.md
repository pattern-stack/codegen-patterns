# ADR-039 — Declarative Time-Based Scheduling: Time as an Event Source

**Status:** Accepted
**Date:** 2026-06-06
**Owner:** Doug
**Related:** ADR-023 (Event-to-Job Bridge), ADR-024 (Events Domain Formalization), ADR-022 (Job Orchestration Domain Model), ADR-008 (Subsystem Architecture)
**Depends on:** ADR-024 Phase 1 (shipped via EVT-1..EVT-8) — the typed event registry, the `domain_events` transactional outbox, direction-routed drain; ADR-023 (shipped via BRIDGE-1..9) — the three-tier activation model and the bridge.
**Supersedes (pointer):** `docs/specs/BULLMQ-1.md` §Extensions and `docs/specs/dealbrain-bullmq-audit.md` both defer cron / `upsertJobScheduler` to "ADR-025 scheduling territory." ADR-025 is the Combiner Subsystems ADR — that pointer dangles. **This ADR is the scheduling territory.** The eventual BullMQ events/jobs backend maps this same YAML contract onto BullMQ's native `JobScheduler` / repeatable jobs; the Drizzle backend gets its own outbox-materializer loop (below). The YAML contract is identical across backends.

---

## Context

ADR-023 established the **complete** activation model for work: three tiers by which a *fact* (a `domain_event`) causes *work* (a `job_run`).

| Tier | Mechanism | Durability | Use for |
|---|---|---|---|
| **1. Subscribe** | `IEventBus.subscribe()` in-process | at-most-once | metrics, cache busts, logs |
| **2. Direct invoke** | `eventFlow.publishAndStart(...)` | durable, caller-tx | request-path work needing durability |
| **3. Bridge** | `@JobHandler({ triggers })` | durable, outbox+ledger | declarative async fanout |

What ADR-023 did **not** name is where events *come from*. Implicitly there were two **event sources**: a use case calling `eventBus.publish(...)`, and a webhook receiver translating an inbound HTTP call into a `domain_event`. Both produce a fact that the three tiers then activate.

**Time is the missing third event source.** "Every hour, something should happen" is, structurally, "every hour a fact occurs." Today there is no way to say that declaratively. The only time primitive is `StartOptions.runAt` — a one-shot future timestamp on a single `job_run`, which fires once and is imperative. There is no recurring, declarative time source.

### The dogfood that forced this (swe-brain, 2026-06-05)

swe-brain (a consumer on `@pattern-stack/codegen@0.19.0`) needed an hourly reconcile poll: a safety net that re-walks Slack history to heal webhook misses and deletions-during-downtime. With no time source, it hand-rolled a **self-perpetuating job chain** (`src/jobs/reconcile-poll.job-handler.ts`):

1. The first durable `ctx.step` of every run enqueues its own successor at the next top-of-hour via `runAt`.
2. An `OnApplicationBootstrap` seed starts the chain at boot (also healing the downtime gap immediately).
3. `step` memoization keeps a retry from double-enqueueing the successor.

This works, but it is ~290 lines of *scheduling concern living inside a handler*, and it exposed a sharp gotcha:

> **The jobs dedupe check matches the currently-*running* run.** `DEDUPE_EXCLUDED_STATUSES = ['canceled', 'failed']` — dedupe looks for any non-canceled/failed run in-window, **including the run still `running`**. So a flat dedupe key collapses the successor *into the run scheduling it*, and the chain dies after one hop.

swe-brain worked around it with **slot-keyed dedupe** (`reconcile:slack:2026-06-05T15`). That workaround is load-bearing and subtle — and it lives at the *wrong layer* (a job inventing its own recurrence). The right layer is an event source that emits a fact on a cadence; existing tiers do the rest.

### Prior art — dealbrain's production scheduler (read before reviewing)

`dealbrain/apps/backend/src/infrastructure/events/scheduler.service.ts` is the proven shape this ADR generalizes. It runs **10 crons**; each tick **publishes a payload-free event** (`new SyncGmailEmailsEvent()`, a `HealthCheckEvent` heartbeat every 5 min, etc.); the scheduler is a **strict producer** — it does no work, it only emits facts. Handlers downstream are themselves strict producers that enumerate + fan out; all real work is ordinary event-driven jobs. Two operational lessons are encoded there and carried into this design:

1. **Reconcile-on-boot.** The schedule definitions are the source of truth. Each boot upserts every desired schedule *and prunes orphans* — schedulers that exist in the broker but are no longer in code. Skipping the prune left a removed cron firing forever (the ENG-605 "zombie scheduler" incident, 2026-04-29).
2. **Cron-offset staggering.** Multiple 5-minute crons fire at `3,8,13,…` rather than all at `:00` to avoid a thundering herd. v1 here addresses the herd via boundary-aligned slots + the natural per-event-type key spread; explicit per-event offset is noted as v2.

dealbrain runs on BullMQ (`upsertJobScheduler`). This ADR makes the **YAML contract** identical regardless of backend; the Drizzle backend implements the same semantics with an outbox materializer.

## Decision

**Time is an event source, not a fourth activation tier.** A scheduler loop materializes due ticks as ordinary `domain_events` rows in the outbox; ADR-023's three tiers — unchanged — activate them. There is **no new activation mechanism**: consumers react with a Tier-1 `subscribe` or a Tier-3 `@JobHandler({ triggers })`, exactly as they react to a use-case publish or a webhook.

The declarative home is the **event YAML** (`definitions/events/<domain>/*.yaml`) — the artifact that already *owns* "this event type exists, here is its direction/pool/payload." A new `schedule:` key on an event means: *"the platform emits this event on this cadence."*

```yaml
# definitions/events/messaging/reconcile_due.yaml
type: reconcile_due
direction: inbound          # routes through events_inbound; a poll-style heal is inbound
schedule:
  every: 1h                 # the cadence
  align: true               # epoch-anchored slot boundaries (default)
  # catchUp: false          # run once on recovery, don't replay missed slots (default)
payload: {}                 # scheduled events are payload-free facts (dealbrain pattern)
```

A consumer then reacts through an existing tier — e.g. Tier 3:

```ts
@JobHandler<ReconcileInput>('reconcile-poll', {
  pool: 'batch',
  concurrency: { key: 'reconcile:{{provider}}', collisionMode: 'queue' },
  triggers: [{ event: 'reconcile_due', map: () => ({ provider: 'slack', windowHours: 24 }) }],
})
class ReconcilePollHandler extends JobHandlerBase<ReconcileInput, ReconcileOutput> { … }
```

That is the whole consumer surface. No `schedule_next` step, no boot seed, no slot-keyed-dedupe workaround. The scheduler emits the fact; the bridge spawns the run; concurrency serializes overruns.

### Architectural spine vs. authoring surface (mirrors ADR-023)

| Layer | What lives here | Cost to change after ship |
|---|---|---|
| **Spine** (runtime) | the materialization invariant (exactly-one-event-per-slot), the slot-key + slot math, the deterministic idempotent outbox insert, reconcile-on-boot, misfire policy, both-backend parity | High — touches the outbox insert path |
| **Authoring surface** | the event-YAML `schedule:` shape: `every`, `align`, `catchUp`; cron strings later; per-event offset later | Low — pure schema + codegen, compiles to the same materialization |

### Seven locked decisions

#### 1. Declarative home — `schedule:` on the event YAML, not the handler

The schedule belongs to the **event** ("this fact recurs"), not to any one reactor. Multiple jobs (and subscribers) can react to one scheduled event; binding the cadence to a single `@JobHandler` would invert that. It also keeps the activation model honest: the handler still only ever declares *what it reacts to* (`triggers`), never *when time passes*.

The `schedule:` block:

```ts
interface EventSchedule {
  every: string | number;   // '1h' | '30m' | '15s' | '500ms' | '1d' | raw ms — the slot length
  align?: boolean;          // epoch-anchored boundaries (default true)
  catchUp?: boolean;        // backfill missed slots (default false — run once on recovery)
  maxCatchUpSlots?: number; // catchUp bound (default 1000)
}
```

`every` accepts the duration grammar `ms|s|m|h|d`. A malformed value fails codegen validation (and again at boot, defensively).

> **Diverged from the recommendation (1):** the recommendation was `{ every, align? }`. I added `catchUp?` (+ its bound) to v1 rather than leaving misfire policy purely implicit. The misfire *default* (run-once-on-recovery) is the spine's behavior and exists regardless; exposing the one knob that flips it costs one optional boolean and one branch, and "backfill every missed slot" is a real need (a rollup that must not skip a window) that would otherwise push a consumer back to a hand-rolled chain — the thing this ADR retires. The recommendation's intent is honored exactly; the knob ships in v1.

**Cron strings deferred.** No cron parser is a dependency; interval covers the dogfood and most "every N" cases. A future `schedule: { cron: '0 9 * * 1-5' }` is additive — the cron's next-fire timestamp becomes the slot start, so the spine is unchanged. The eventual BullMQ backend speaks cron natively (`upsertJobScheduler`); `{ every }` maps to a repeatable `{ every: ms }`, a future `{ cron }` to `{ pattern }`.

#### 2. Runtime — an `EventScheduler` that materializes ticks as outbox events

A framework-owned **`EventScheduler`** lives with the events subsystem (NOT the jobs subsystem — it produces events; jobs are downstream). It is wired by `EventsModule.forRoot()` and reads the scheduled-event set from the generated `eventRegistry` (each scheduled event carries its `schedule` block). Two entry points:

- **Reconcile-on-boot** (`onModuleInit`) — for every scheduled event type, materialize the **current slot** (catch-up off) or bounded backfill (catch-up on). Boot is when a downtime-healing tick matters most. (The dealbrain "reconcile + prune orphans" lesson: in the outbox model there is no broker-side scheduler entry to leave dangling — a removed `schedule:` simply stops being materialized, so the zombie-scheduler class of bug is **structurally absent**. The reconcile half — materialize the current slot on boot — is what we keep.)
- **Tick pass** (an interval, coalesced to the smallest scheduled `every`, floored) — materialize each scheduled event's **next slot** so ticks self-perpetuate with no handler code.

Materialization is a deterministic, idempotent **outbox insert** — NOT a read-then-insert:

```
slotKey = `@schedule/<eventType>/<slotStartEpochMs>`        // stable, recomputable
INSERT INTO domain_events (id, type, …, pool, direction,
                           occurred_at=<slotStart>,
                           metadata={ scheduleSlot: <slotKey>,
                                      triggerSource: 'schedule' })
ON CONFLICT (type, schedule_slot) WHERE schedule_slot IS NOT NULL DO NOTHING
```

The **exactly-one-event-per-slot invariant** is enforced at the database via a new **partial unique index** on `(type, metadata->>'scheduleSlot')` (a generated/expression index; see Schema). The slot key is a pure function of `(eventType, slotStart)`, so two app instances — or boot racing a tick — both attempt the same insert and the second is a no-op. No advisory lock, no leader election, no double-emit across a multi-instance deployment. This is swe-brain's slot-keyed-dedupe trick, lifted to the events layer and hardened with a real constraint instead of a windowed read.

Once the event row exists, the **existing outbox drain** carries it: Tier-1 subscribers fire, and the bridge (Tier 3) spawns wrapper + user runs per matched `@JobHandler({ triggers })`. The scheduler touches none of that — it only produces the fact.

#### 3. Misfire / catch-up — run once on recovery by default

Down across N slots → on the next boot/tick, materialize **one** event for the current slot. Missed slots are **not** replayed. For a poll-style heal (re-walk a 24h window on a 1h cadence) one tick on recovery already covers everything the misses would have. This is exactly what swe-brain's boot seed did.

`catchUp: true` backfills every missed slot from `lastEmittedSlot + 1` to the current slot (each its own idempotent insert, so a crash mid-backfill resumes cleanly), **bounded** by `maxCatchUpSlots` (default 1000). Beyond the bound, the most recent `maxCatchUpSlots` are emitted and a WARN names the dropped count. "Last emitted slot" is `MAX(occurred_at) WHERE type=? AND metadata->>'triggerSource'='schedule'` — no new bookkeeping table.

#### 4. Provenance — how a scheduled tick reads through the stack

Three rows, three provenance stamps, no ambiguity:

- **The event row** (`domain_events`) carries `metadata.triggerSource = 'schedule'` and `metadata.scheduleSlot = <slotKey>`. This is where "this fact came from the clock" lives. (ADR-024 events have no first-class `trigger_source` column; metadata is the established carrier for routing/provenance, e.g. `rootRunId`.)
- **The bridge wrapper `job_run`** reads `trigger_source = 'event'`, `trigger_ref = <event_id>` — unchanged bridge behavior (BRIDGE-4). The wrapper came from an *event*; that the event came from the clock is the event's metadata to tell.
- **The user `job_run`** (spawned by the wrapper) reads `trigger_source = 'parent'`, `trigger_ref = <wrapper_run_id>` — unchanged.

> **Provenance decision (3):** the recommendation asked us to "decide and document how a tick-triggered run's `trigger_source` reads." **Decision: the run reads `event` (via the bridge), and the scheduled origin lives on the event's metadata, not the run.** This honors ADR-022's dormant `triggerSource: 'schedule'` enum value precisely — that value is correct for a run started *directly* by a scheduler (`orchestrator.start(type, …, { triggerSource: 'schedule' })`), which is exactly what swe-brain does today and what a consumer using **Tier 1** could still do (subscribe to the scheduled event, call `start` with `triggerSource: 'schedule'`). The enum is not dead — it's the right stamp for the direct-start path. The bridge path stamps `'event'` because that path genuinely goes through an event. A dashboard answering "which runs are ultimately clock-driven?" joins `job_run.trigger_ref → domain_events.id` and reads `metadata.triggerSource`. Documented in the events + bridge skills.

#### 5. Validation — codegen-time, with a runtime backstop

- **Codegen / schema** (`gen-validate` + `gen-all`): a malformed `schedule.every` is a hard error citing the file (the `EventDefinitionSchema` `every` is a regex-validated duration string OR a positive finite number; a bad value fails `safeValidateEventDefinition`, which the generator already surfaces). **A `schedule:` on an event that nothing consumes** would ideally WARN — a scheduled event with no Tier-1 subscriber and no Tier-3 trigger emits facts into the void. v1 does **not** emit that warn from the event generator: the consumer set (bridge registry + `subscribe()` call sites) is scanned by *separate* passes the event generator doesn't see, and a false-positive warn (the consumer wired a subscriber the generator can't observe) is worse than silence. Its natural home is the existing fanout CLI `codegen events consumers <type>` (ADR-023), which already cross-scans all three tiers — noted as the refinement, documented in the events skill.
- **Schedule on `tier: audit` → rejected.** Audit events are observability-only and route to no pool (the `domain_events` CHECK constraint forbids pool/direction on audit). A scheduled fact needs to *drive* work, which means it needs a direction/pool to reach the bridge. v1 keeps `schedule:` domain-tier-only. (A scheduled audit heartbeat that only Tier-1 subscribers observe is conceivable; deferred — the dealbrain heartbeat is a domain event with subscribers, so this is not a v1 gap.)
- **Reserved-pool rules unchanged.** Scheduled events route by their `direction` into the same reserved `events_*` pools every other event uses; no new pool rules.
- **Runtime backstop:** `EventScheduler` re-parses `every` at boot (defense in depth — a hand-edited registry or version skew). Bad value → `ScheduleConfigError`, loud, before the tick loop starts.

#### 6. Backend parity — drizzle materializer + memory equivalent

- **Drizzle** — `EventScheduler` runs `INSERT … ON CONFLICT DO NOTHING` against `domain_events`, gated by the partial unique expression index on the slot key. Reuses the existing `DrizzleEventBus.publish` insert shape (pool/direction/metadata), threaded so a LISTEN/NOTIFY wake fires for an immediately-due tick.
- **Memory** — `MemoryEventBus` gains a slot-keyed guard: a Map of `(type, slotKey)` already-emitted markers mirrors the unique index (emit once per slot, no-op thereafter). Behavior parity with the DB index is the contract the unit suite pins. The memory scheduler runs the same `EventScheduler` driving the memory bus; tests drive its `materializeBoot` / `materializeTick` directly (no real timer).
- **Redis** — the Redis event bus retains no outbox history, so slot-key idempotency can't be enforced there; the scheduler is **drizzle/memory only** (mirrors how the bridge is unsupported on Redis — `findById` returns null). Documented.
- **BullMQ (future)** — when the BullMQ events/jobs backend lands, `schedule:` maps onto BullMQ's native `upsertJobScheduler` (a repeatable producer of the same event), with reconcile-on-boot = upsert-desired + prune-orphans (the dealbrain pattern verbatim). The YAML contract is unchanged; only the materializer swaps.

#### 7. Out of scope (explicit)

- **Cron expressions** (deferred — additive `schedule: { cron }`, Decision 1).
- **Per-event cron-offset staggering** — v1 relies on epoch-aligned slots; the thundering-herd mitigation dealbrain uses (`offset` minutes) is a future `schedule: { offset }` knob.
- **Per-tenant schedules** — a scheduled event is emitted once for the whole process (cross-tenant fact). Per-tenant fan-out is future work.
- **Pause / resume UI** — already free via the existing control plane (hold the reactor's pool at concurrency 0; ticks still emit but runs don't claim). A dedicated pause flag is future polish.
- **Sub-second cadences** — `every` below a floor (1000ms == the default poll interval) is allowed but warned: materialize/drain latency dominates.

## Consequences

### Positive

- **No new activation mechanism.** ADR-023's three tiers stay the complete model; this ADR adds TIME as an event *source* peer to use-case publishes and webhook receivers. One mental model, not two.
- **The self-perpetuating-chain pattern (and its dedupe trap) is retired at the right layer.** Scheduling leaves the handler entirely; the consumer collapses to a `schedule:` YAML + a `triggers:` entry.
- **Exactly-once emission across instances, by construction.** A DB unique constraint on the slot key — not a windowed read, not a lock — guarantees one event per slot under multi-instance deploys and boot/tick races.
- **Uniform observability + control plane.** A scheduled tick is an ordinary `domain_event` and its downstream work is ordinary `job_run`s — every dashboard, pause, throttle, and cancel knob applies for free.
- **Reconcile-on-boot heals downtime + structurally avoids the zombie-scheduler bug.** A removed `schedule:` simply stops being materialized — there is no broker entry to prune (the failure mode dealbrain hit with `upsertJobScheduler` can't occur in the outbox model).

### Negative

- **A second timer in the events process.** The `EventScheduler` tick is one more interval alongside the outbox poll. Coalesced (one timer at the smallest `every`) and cheap (N idempotent inserts per tick, N = scheduled-event count).
- **A partial expression unique index on `domain_events`.** Additive Atlas migration on `(type, (metadata->>'scheduleSlot'))` where the slot key is non-null. Only scheduled rows are covered; ordinary events are untouched.
- **The slot key lives in `metadata`, not a first-class column.** Consistent with how events already carry provenance (`rootRunId`), but an expression index is slightly less obvious than a plain column. Accepted to avoid a wider `domain_events` migration; a first-class `schedule_slot` column is a clean future tightening if querying demands it.

### Neutral / edge cases

- **Schedule changed across deploys.** Changing `every` (e.g. `1h` → `30m`) changes the slot grid. In-flight slot events run to completion; new materialization uses the new grid. `align: true` keeps both grids epoch-anchored so the transition is clean. No migration.
- **Event type removed but slot events pending.** Pending `domain_events` of a removed type drain as normal facts; if nothing subscribes/triggers, they process to `processed` as no-ops. Reconcile-on-boot simply stops emitting new ticks for the gone type.
- **Clock skew across instances.** `align: true` is epoch-anchored, so skewed clocks compute identical slot *boundaries*; only which slot is "current" can differ by the skew, and the unique index collapses the overlap.

## Alternatives considered

### A. A `schedule:` knob on `@JobHandler` (a fourth, time tier)

Make scheduling decorator metadata on the job, with a `JobScheduler` materializing `job_run` rows directly. **Rejected** (and reverted mid-implementation): it invents a *fourth activation mechanism* parallel to the three ADR-023 tiers, binds a recurring fact to a single reactor (only one job can own the cadence), and puts time-knowledge on the handler — the handler should only ever say *what it reacts to*. The event-source model reuses the existing tiers and lets many reactors share one scheduled fact. (The slot math, idempotent-materialization, and misfire policy designed for that approach generalize directly to the events layer — they were kept.)

### B. The self-perpetuating job chain (swe-brain status quo)

The handler's first `ctx.step` enqueues its own successor. **Rejected as the framework primitive** — it's what we're retiring. Scheduling concern in every handler, correctness dependent on `step` memoization, and the flat-dedupe-key version collapses the chain after one hop (the running parent matches the dedupe read). Fine as a consumer stopgap; wrong as the durable answer.

### C. A standalone scheduler daemon

A separate process that wakes on a cron and publishes. **Rejected:** second deployment, health-check, scaling story — the reasons ADR-023 rejected a dedicated bridge worker. The events process already polls the outbox; the scheduler is a few inserts on a timer inside it.

### D. Dedupe-window read keyed by slot (read-then-insert)

Reuse a windowed read to check for an existing slot event before inserting. **Rejected:** that read is the gotcha — even slot-keyed, a read-then-insert is a TOCTOU race two instances can both lose. The DB unique constraint is the only honest exactly-once primitive. (The slot key is borrowed from this idea; the *read* is not.)

### E. `schedule:` as a fully separate `schedules/*.yaml` registry

A new artifact mapping cadence → event type. **Rejected:** the event YAML already owns the event type and its routing; a separate file splits one concept across two artifacts. `schedule:` is one more property of an event, like `direction` or `retry`.

## Implementation map (PR ships half 1 in full)

This PR ships the **runtime primitive + the declarative event-YAML contract end to end** — the scheduler is driven from `schedule:` in event YAML through the generated registry. (There is no separate "half 2": the original brief's two-halves framing assumed the `@JobHandler` primitive + a later config driver. With the event-source design the declarative driver *is* the contract, so it ships now.)

| Concern | File |
|---|---|
| `EventSchedule` on the event schema + validation | `src/schema/event-definition.schema.ts` |
| `schedule` carried into the generated registry + metadata type | `src/cli/shared/event-codegen-generator.ts`, `runtime/subsystems/events/generated/{registry,types}.ts` |
| Duration parser + slot math (`parseEvery`, `slotStartFor`, `slotKeyFor`, `nextSlotStart`) | `runtime/subsystems/events/event-scheduler.ts` (new) |
| `EventScheduler` (reconcile-on-boot + tick, drizzle + memory) | `runtime/subsystems/events/event-scheduler.ts` (new) |
| `materializeScheduledEvent` / slot guard on both event-bus backends | `event-bus.drizzle-backend.ts`, `event-bus.memory-backend.ts` |
| Partial unique expression index on the slot key | `runtime/subsystems/events/domain-events.schema.ts` |
| Wire `EventScheduler` into `EventsModule.forRoot` (drizzle/memory) | `runtime/subsystems/events/events.module.ts` |
| `ScheduleConfigError` | `runtime/subsystems/events/events-errors.ts` |
| Barrel exports | `runtime/subsystems/events/index.ts` |
| Tests | `src/__tests__/runtime/subsystems/event-scheduler.unit.spec.ts` (new) |
| Skill docs | `.claude/skills/events/SKILL.md`, `.claude/skills/bridge/SKILL.md` (+ consumer-skills) |

### Consumer collapse sketch (swe-brain, for the PR body)

**Add** `definitions/events/messaging/reconcile_due.yaml`:

```yaml
type: reconcile_due
direction: inbound
schedule: { every: 1h, align: true }
payload: {}
```

**Delete** from `src/jobs/reconcile-poll.job-handler.ts`: the `schedule_next` `ctx.step` (the successor-enqueue), the `nextSlotStart` / `slotFor` helpers, the `slot` input field + slot-keyed `dedupe:` block, and the entire `ReconcilePollBootstrap` `OnApplicationBootstrap` class (+ its `RECONCILE_POLL_DISABLED` env). **Add** a `triggers: [{ event: 'reconcile_due', map: () => ({ provider: 'slack', windowHours: 24 }) }]` entry to the `@JobHandler`. Net: ~290 lines → a handler that just does the two reconcile steps, plus 4 lines of YAML. `concurrency: { key: 'reconcile:{{provider}}', collisionMode: 'queue' }` stays and now serializes overruns against the scheduled cadence.

## Future work — declarative-source lineage (not architected for here)

`dealbrain-integrations/INTEGRATION-STACK.md` §8 sketches a "DetectionConfig YAML wiring" wave where a poll-mode source's cadence/window would live in provider/source YAML and codegen would emit the wiring. That is a *consumer/codegen-layer* concern that would *consume* this primitive (it would emit a `schedule:` event + a reactor from a higher-level source declaration), not change it. Recorded as lineage; this ADR deliberately does not depend on it.

## Cross-links

- `ADR-023-event-to-job-bridge.md` — the three-tier activation model this ADR feeds; time becomes an event source, the tiers are unchanged.
- `ADR-024-events-domain-formalization.md` — the `domain_events` outbox + typed registry the scheduler materializes into.
- `ADR-022-job-orchestration-domain-model.md` — the dormant `triggerSource: 'schedule'` enum (the correct stamp for the direct-start path; the bridge path stamps `'event'`).
- `docs/specs/BULLMQ-1.md` §Extensions — the dangling "ADR-025 scheduling territory" pointer this ADR resolves; the `schedule:` → `upsertJobScheduler` mapping for the future BullMQ backend.
- `dealbrain/apps/backend/src/infrastructure/events/scheduler.service.ts` — the production prior art (strict-producer scheduler, reconcile-on-boot, cron-offset staggering).
