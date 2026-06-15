# ADR-041 — All-BullMQ Topology: Durable `IEventBus` + BullMQ `IJobOrchestrator` + Bridge Seam

**Status:** Accepted
**Date:** 2026-06-15
**Owner:** Doug
**Related:** ADR-022 (Job Orchestration Domain Model), ADR-023 (Event-to-Job Bridge), ADR-024 (Events Domain Formalization), ADR-039 (Declarative Time-Based Scheduling), ADR-008 (Subsystem Architecture)
**Depends on:** BULLMQ-1 (the BullMQ `IJobOrchestrator` backend — shipped, port-promotion gate pending), ADR-039 (the `schedule:` contract + `EventScheduler` materializer), ADR-023 (the bridge + `bridge_delivery` ledger)
**Specs:** `docs/specs/BULLMQ-2.md` (the durable BullMQ events backend + BullMQ scheduler materializer)

---

## Context

Three subsystems already exist and meet at a single seam: events (`IEventBus`, `domain_events` outbox), jobs (`IJobOrchestrator`, `job_run` source of truth), and the bridge between them (`bridge_delivery` ledger, ADR-023). BullMQ has landed for **jobs only** (BULLMQ-1): `BullMQJobOrchestrator extends DrizzleJobOrchestrator` (`runtime/subsystems/jobs/job-orchestrator.bullmq-backend.ts:80`), keeping Postgres `job_run` as the domain source of truth and layering `queue.add` / `job.remove` on top. Three things are still missing for a consumer who wants to run automation/scheduling end-to-end on one Redis:

1. **Events have no BullMQ backend at all.** `runtime/subsystems/events/` ships drizzle (outbox, default), memory (test), and a `RedisEventBus` (`event-bus.redis-backend.ts`) Pub/Sub variant whose `findById` returns `null` (`:181`), ignores `tx` (non-transactional, `:137`), and is documented as bridge- and scheduler-incompatible.
2. **Scheduling is Postgres-outbox-bound.** ADR-039 materializes `schedule:` ticks via an in-process `EventScheduler` `setInterval` (`runtime/subsystems/events/event-scheduler.ts:257`) + an `ON CONFLICT DO NOTHING` slot insert against a partial UNIQUE expression index (`event-bus.drizzle-backend.ts:375`). There is no BullMQ materializer. ADR-039 §159 already commits the mapping (`schedule:` → `upsertJobScheduler`, reconcile-on-boot, prune-orphans) but leaves it unbuilt.
3. **The bridge presupposes a Postgres outbox drain.** `BridgeOutboxDrainHook` runs trigger-match + `bridge_delivery` insert + wrapper `job_run` insert inside the Drizzle drain's per-event transaction (`event-bus.drizzle-backend.ts:631-646`). On an all-BullMQ stack there is no drain to hook unless we say what replaces it.

This ADR decides the topology. It does **not** re-open BULLMQ-1's jobs decisions or ADR-039's scheduling contract — it composes them into a coherent all-BullMQ end state and closes the three gaps above.

## Decision

### 1. Separation on one Redis — not "events and jobs are the same BullMQ thing"

The architectural end state is **separation on one Redis**: a narrow, durable `IEventBus` + a BullMQ-orchestrated `IJobOrchestrator` + the bridge as the seam between them. We explicitly reject collapsing events and jobs into a single BullMQ dispatch path.

This is the dealbrain audit's core conclusion. The audit (`docs/specs/dealbrain-bullmq-audit.md` §"Is BullMQ also the event bus?") found dealbrain has *no* separate event bus — every `BaseEvent` hardcodes a `queueName` and is enqueued as a BullMQ job — and records Doug's own architecture doc verdict verbatim:

> "In our system, **events and jobs are the same thing.** … We should invest in separating a narrow event bus and a dedicated job queue…"
> "Define `IEventBus` and `IJobQueue` as distinct interfaces — today both resolve to the same BullMQ-backed implementation under the hood."

The audit's recommendation for codegen-patterns is the split this ADR adopts: keep BullMQ at the high-level `IJobOrchestrator` port, pair it with a separate `IEventBus`, and let the bridge connect them. Dealbrain migrates to this on day one.

### 2. Events on BullMQ = durable dispatch over the Postgres outbox

The BullMQ events backend is a **dispatch-only durable backend over the existing Postgres outbox** — it is **not** Redis Pub/Sub and **not** a Redis-resident event log.

- `domain_events` stays the committed-event store and the `findById` source of truth.
- `publish`/`publishMany` write the outbox row in the caller's transaction (the established transactional-outbox spine), then enqueue a wake/dispatch job to BullMQ instead of being polled.
- The bridge's single-Postgres-transaction exactly-once guarantee is preserved **verbatim**: outbox insert + `bridge_delivery` `UNIQUE(event_id, trigger_id)` + wrapper `job_run`, all in one tx (ADR-023 §"Outbox drain atomicity", §"`publishAndStart` + existing `triggers:` collision"). BullMQ only adds the **dispatch/wake half**.

This **mirrors the jobs design exactly**: Postgres is the source of truth, BullMQ is the claim/dispatch layer. "BullMQ events" therefore means "a dispatch-only backend over a Postgres outbox," not a new event store. The core `IEventBus` surface (`publish`/`publishMany`/`subscribe`/`findById`, `event-bus.protocol.ts:43`) stays narrow and unchanged; `materializeScheduledEvent` / `lastScheduledSlotMs` stay optional extension methods (`event-bus.protocol.ts:106,115`).

**Rationale for rejecting a Postgres-free events path.** Running jobs on BullMQ *already* requires Postgres — `BullMQJobOrchestrator` extends the Drizzle backend and `job_run` is the domain source of truth (BULLMQ-1 §"Postgres + BullMQ coordination"). A Postgres-free events backend would be **incoherent** with that shipped design. More sharply: the bridge's exactly-once invariant rests on a single Postgres transaction spanning the outbox insert, the `bridge_delivery` ledger, and the wrapper `job_run` — **a cross-store transaction does not exist in Redis.** Any Redis-resident-log alternative would have to re-derive the event→delivery idempotency ledger from scratch (BullMQ `jobId` dedup only covers job-side dedup, not the `(event_id, trigger_id)` pair). Keeping the outbox means the entire ADR-023 correctness argument carries over with zero changes.

**Alternative considered — a Redis-resident durable log** (BullMQ Queue / Redis Streams as the event store, `findById` reading back from Redis). **Rejected** because: (a) it forks the source-of-truth story away from jobs (Postgres) without buying portability; (b) it forces a hand-rolled re-derivation of the `bridge_delivery` ledger and same-tx idempotency, the exact machinery ADR-023 built and proved; (c) `findById` over a non-Postgres store can't share the committed `domain_events` row the bridge re-fetches at claim time. The outbox-dispatch design is strictly simpler and reuses proven correctness.

### 3. Delete `RedisEventBus` — no deprecation shim

`RedisEventBus` (`event-bus.redis-backend.ts`) is deleted under the project's no-backwards-compat principle (CLAUDE.md §"Operating Principles"). It is:

- **un-installable via the CLI** (the events subsystem descriptor never advertised `redis`);
- **non-transactional** — `publish` ignores `tx` (`:137`), so a rolled-back caller transaction still fires the event (no outbox semantics);
- **bridge-incompatible** — `findById` always returns `null` (`:181`), and the bridge re-fetches the committed event at claim time;
- **scheduler-incompatible** — it implements no `materializeScheduledEvent`, so ADR-039's slot-key idempotency cannot be enforced (the `EventScheduler` is drizzle/memory-only today).

No consumer depends on Pub/Sub semantics, and there is no architectural reason to keep a fire-and-forget bus alongside a durable one. The durable BullMQ backend is the move; the dead Redis variant goes. **No deprecation callout, no parallel old-and-new arm.** Deleting it also retires the `REDIS_URL` token, the `redis` arm of `EventsModule.forRoot`/`forRootAsync` (`events.module.ts:296,365`), `loadRedisEventBus` (`:90`), and the redis backend tests.

### 4. Scheduling = ADR-039 materializer swap, not a new core method

The YAML `schedule:` contract — `{ every, align, catchUp, maxCatchUpSlots }` (`event-scheduler.ts:152` `RegistrySchedule`; ADR-039 Decision 1) — is **unchanged and identical across backends**. What swaps is the materializer:

| Backend | Materializer |
|---|---|
| **Drizzle / Memory** | `EventScheduler` `setInterval` (`event-scheduler.ts:257`) + slot insert via `materializeScheduledEvent` → `INSERT … ON CONFLICT DO NOTHING` against the partial UNIQUE slot-key index (`event-bus.drizzle-backend.ts:375`) |
| **BullMQ** | one `upsertJobScheduler` (BullMQ Job Scheduler) per scheduled-event type, registered from the `eventRegistry`'s `schedule` blocks; the repeatable body **publishes the same scheduled domain event into the outbox** (`eventBus.publish(scheduledTick)`) |

Routing the BullMQ Job Scheduler back through the outbox — rather than firing the user job directly — is the decision that keeps the whole stack on one path: **time → fact → bridge → job, with `job_run` as the source of truth.** A scheduled tick is an ordinary `domain_event`; the bridge (Tier 3) spawns wrapper + user runs exactly as it does for a use-case publish (ADR-039 Decision 2). This preserves cron, RFC-0005 cadence-on-job, and the bridge on one activation model. ADR-039 §159 already commits this shape ("a repeatable producer of the same event").

**Reconcile-on-boot is mandatory: upsert-desired + prune-orphans.** A broker-side scheduler re-introduces the zombie-scheduler bug class the outbox model structurally avoided (the ENG-605 incident, ADR-039 §44, §177 — a removed cron that fired forever). Each boot must upsert every desired Job Scheduler **and prune the orphans** (schedulers present in the broker but no longer in code). This is not optional; it is the only thing standing between this design and ENG-605.

**Exactly one source of truth per backend.** When the BullMQ scheduler is active, the `EventScheduler` `setInterval` loop and the slot-key UNIQUE index do **not** run. Running both would double-fire (one tick from each materializer). The Drizzle/Memory path owns the slot index; the BullMQ path owns the Job Scheduler; never both.

**Interval-only now; cron deferred.** v1 maps `{ every }` → BullMQ `{ every: ms }`. A future `{ cron }` → `{ pattern }` is an **additive BullMQ-only extension** (BullMQ speaks cron natively with zero new dependency; the Drizzle backend stays interval-only). Holding cron back keeps backend parity and the cross-backend contract suite tractable (ADR-039 Decision 1, §163).

**Do NOT add `schedule()` / `upsertScheduler` to `IJobOrchestrator`.** A core scheduling method would force a Drizzle/Memory scheduler loop into the core contract, breaking portability and memory-backend parity (a new core capability needs a Memory implementation or the cross-backend suite breaks across all three backends). Cadence stays event-shaped — a materializer swap behind the events subsystem, not a job-orchestrator method. This is locked.

### 5. Bridge stays the seam — swap the wake, not the ledger

The bridge remains the jobs worker draining the reserved `events_*` pools (ADR-023 Decision 2). The wrapper `job_run` insert stays exactly as it is — a raw, transactional insert (`BridgeOutboxDrainHook`, for FK-ordering + dedup correctness). What changes for an all-BullMQ stack is purely **how that committed wrapper row reaches a worker**: under Drizzle a polling worker claims it; under BullMQ there is no poll, so the BullMQ jobs side runs a **reserved-pool enqueue relay** (`BullMQJobOrchestrator.reconcilePending(pools)`, driven by a ~1s timer + a boot pass in `JobWorkerModule`). The relay re-`dispatch`es every pending run in the reserved pools it consumes; `dispatch` is idempotent (the wrapper's `jobId` is its `run.id`, so a re-add of an already-queued/in-flight job is a BullMQ no-op, and a claimed run is no longer `pending`). This is the **outbox-relay half of the transactional-outbox pattern** — the wrapper rows are an outbox BullMQ needs relayed, exactly as the events drain relays `domain_events` — which is why it is correct for it to poll the (narrow, framework-only) reserved pools and why it is self-healing (a wrapper whose enqueue was lost to a Redis hiccup is re-dispatched on the next tick). It is scoped to reserved `events_*` pools only: regular runs are dispatched promptly by `start()`, so there is no race with a freshly-started regular run. Everything else is untouched:

- the `bridge_delivery` `UNIQUE(event_id, trigger_id)` ledger (ADR-023 §Schema);
- the per-event transaction (ADR-023 §"Outbox drain atomicity");
- Case-B pre-write dedup (the facade pre-writes `bridge_delivery(status=delivered)`, ADR-023 §"`publishAndStart` + existing `triggers:` collision").

This honors ADR-023's exactly-once invariant and avoids re-deriving idempotency from BullMQ `jobId` (which covers job-side dedup only, not the event→delivery pair). (An earlier draft proposed a synchronous "enqueue callback" on the wrapper insert; that was rejected because a Redis enqueue cannot be made atomic with the Postgres commit — a pre-commit enqueue races the wrapper's own visibility, and a post-commit enqueue still needs a backstop for a lost enqueue. The reserved-pool relay IS that backstop and the primary path in one mechanism.)

### 6. Jobs core-contract leaks are bugs, not extensions

Three core `StartOptions` fields are currently dropped by the BullMQ jobs backend. They are **core contract**, so the BullMQ backend must behave identically to Drizzle — these are leaks to close, not optional extensions (CLAUDE.md §"Backend swappability": app code written against the core must be portable):

| `StartOptions` field | Drizzle behavior | BullMQ fix |
|---|---|---|
| `runAt` | one-shot future timestamp on the `job_run` | `dispatch` (`job-orchestrator.bullmq-backend.ts:220`) builds `jobOpts` from retry + dedupe only (`:225`) and never reads `run.runAt`; map to BullMQ `delay = max(0, runAt − now)` |
| `priority` | claim-ordering priority | silently dropped; set the BullMQ `priority` job opt from `StartOptions.priority` |
| `collisionMode: 'queue'` | the Drizzle worker re-queues a claimed run when another run with the same `concurrencyKey` is active (`job-worker.ts:629-652`) | `BullMQJobWorker.process` has no equivalent gate; implement a Postgres-checked release/re-enqueue gate so the two runs do not execute concurrently |

Until all three are broker-verified, flipping a consumer to `jobs.backend: bullmq` silently mis-behaves for scheduled/delayed, prioritized, and serialized jobs.

### 7. Verification is the gating deliverable

There is **no reusable cross-backend contract harness** today, and the broker round-trip has **never executed in-repo** for jobs (BULLMQ-1 §Verification is explicit and honest about this) — and would not for events either. The gate:

- a **reusable cross-backend contract harness** running the same `IJobOrchestrator` / `IEventBus` suite against drizzle / memory / bullmq for both subsystems;
- a **Docker-gated testcontainers recipe** (Redis + Postgres), parallel to the existing Postgres integration recipes, **out of `test-all`**, gracefully skipped when Docker is unavailable.

Both BullMQ backends stay **opt-in** (default `drizzle`) until that round-trip is green — exactly as ADR-022 §claim requires for port promotion and as BULLMQ-1 §Verification chose. The codegen-patterns repo ships `runtime/` into consumer projects and does **not** depend on a Postgres driver (`pg`), so the broker path may only run where Docker + Redis + Postgres are available; the green unit suite proves wiring and pure helpers, **not** the broker round-trip (do not mistake one for the other).

## Consequences

### What gets simpler

- **One mental model end-to-end.** Time, use-case publishes, and webhooks are all event *sources*; the bridge is the single activation seam; `job_run` is the single work source of truth. The all-BullMQ stack runs the exact same activation model the Drizzle stack does — only the dispatch/wake substrate changes.
- **The bridge's correctness argument carries over for free.** Because events stay on the Postgres outbox, the entire ADR-023 same-tx exactly-once proof applies unchanged on BullMQ. No new idempotency machinery.
- **One Redis, one config block.** Events reuse the jobs `bullmq.config.ts` connection + `queue_prefix` so jobs and events share a broker (config under `events.extensions.bullmq`, mirroring `jobs.extensions.bullmq`).
- **The dead Redis Pub/Sub bus is gone.** One fewer un-installable, non-transactional backend to reason about or warn around.

### What is riskier

- **Zombie-scheduler regression.** A broker-side Job Scheduler can leave orphan schedulers firing forever (ENG-605). Guarded by **mandatory prune-orphans-on-boot** (Decision 4); running both the `setInterval` materializer/slot index AND the BullMQ scheduler would double-fire, so exactly one is the source of truth per backend. This is the single highest-risk part of the design and the reconcile half is non-negotiable.
- **Silent default-flip footgun.** `runAt` delay, `priority` ordering, and `collisionMode: 'queue'` are honored by Drizzle but no-ops under BullMQ today (Decision 6). They MUST land and be broker-verified before any consumer flips `jobs.backend: bullmq`, or scheduled/priority/serialized jobs misbehave silently.
- **Optional-peer footguns.** A new `event-bus.bullmq-backend.ts` must use type-only `bullmq` imports + `await import('bullmq')`, must not be re-exported from `events/index.ts`, and relies on the `.bullmq-backend.ts` suffix filter. Any slip drags the optional peer into drizzle consumers' tsc (`TS2307` / smoke-subsystems `findStaticPeerImports` failure).
- **Unverified end-to-end.** The whole BullMQ path is unproven against a real broker (Decision 7). "Fully functional" is blocked on the cross-backend harness; the green unit suite is necessary but not sufficient.
- **Config enum tightening.** The codegen config is `.passthrough()`, so a typo'd events/jobs backend falls through to a module switch default. Both backend enums must be tightened and both module switches must throw on an unknown default, or a misconfig silently picks the wrong backend.

### Neutral

- **No `domain_events` schema change.** The BullMQ events backend keeps the Postgres outbox; the events outbox table and the partial UNIQUE slot-key index stay. (A hypothetical future Postgres-free variant would have to stop the schema-generator emitting the outbox table — not a concern here.)

## Alternatives considered

- **A. Events and jobs as one BullMQ dispatch path** (dealbrain's status quo). Rejected — see Decision 1; it is exactly what Doug's architecture doc says to undo.
- **B. Redis-resident durable event log** (BullMQ Queue / Redis Streams as the event store). Rejected — see Decision 2; forks the source-of-truth story from jobs and forces a hand-rolled re-derivation of the `bridge_delivery` ledger with no cross-store transaction.
- **C. Keep `RedisEventBus` as a fire-and-forget option.** Rejected — see Decision 3; un-installable, non-transactional, bridge/scheduler-incompatible, no consumer needs Pub/Sub semantics.
- **D. Add `schedule()` / `upsertScheduler` to `IJobOrchestrator`.** Rejected — see Decision 4; forces a scheduler loop into the core contract and breaks Drizzle/Memory parity. Cadence stays event-shaped.
- **E. BullMQ Job Scheduler fires the user job directly** (bypassing the outbox). Rejected — see Decision 4; it splits the activation model (the direct-fired job skips the bridge and the `bridge_delivery` ledger) and removes `job_run`-as-source-of-truth for scheduled work. The outbox-event approach keeps cron, RFC-0005, and the bridge on one path. ADR-039 §159 favors this ("a repeatable producer of the same event").

## Cross-links and supersede notes

- **2026-06-15** — This ADR is the all-BullMQ topology decision. It composes BULLMQ-1 (jobs backend) + ADR-039 (scheduling contract) + ADR-023 (bridge) into one end state and adds the durable BullMQ events backend.
- **`docs/specs/BULLMQ-2.md`** — implements Decisions 2, 3, 4 (events half): the durable `event-bus.bullmq-backend.ts`, the `RedisEventBus` deletion, and the BullMQ scheduler materializer. (Reciprocal cross-link to be added in BULLMQ-2 during implementation.)
- **`docs/specs/BULLMQ-1.md`** — implements Decision 6 (jobs core-contract leaks: `runAt`/`priority`/`collisionMode:'queue'`) and the Decision 7 verification harness. BULLMQ-1 §Extensions currently says cron is "out of scope (ADR-025 scheduling territory)" — that pointer is stale (ADR-025 is the Combiner Subsystems ADR; ADR-039 is the scheduling territory). **To be replaced in BULLMQ-1 during implementation** with the ADR-039 / ADR-041 mapping. (Reciprocal note to be added there; this ADR does not edit BULLMQ-1.)
- **`docs/adrs/ADR-039-declarative-time-based-scheduling.md`** §159 — the committed `schedule:` → `upsertJobScheduler` mapping this ADR locks (interval-only, reconcile-on-boot = upsert-desired + prune-orphans, repeatable body publishes the same domain event). **To be marked shipped in ADR-039 §159 when the BullMQ materializer lands** (reciprocal note to be added there; this ADR does not edit ADR-039).
- **`docs/specs/dealbrain-bullmq-audit.md`** §"Is BullMQ also the event bus?" / §Recommendation — the audit conclusion (separate `IEventBus` + `IJobOrchestrator`) this ADR adopts.
- **`ADR-022-job-orchestration-domain-model.md`** §claim — the port-promotion gate (2nd impl + broker round-trip) that keeps both BullMQ backends opt-in until green.
