# BULLMQ-2 — Durable BullMQ Events Backend + BullMQ Scheduler Materializer

**Status:** Draft (implementation in progress on `feat/bullmq-jobs-events-automation`)
**Date:** 2026-06-15
**Owner:** Doug
**Decision:** ADR-041 (all-BullMQ topology) Decisions 2, 3, 4
**Related:** BULLMQ-1 (`docs/specs/BULLMQ-1.md` — the BullMQ `IJobOrchestrator` backend this mirrors), ADR-039 (the `schedule:` contract + `EventScheduler`), ADR-023 (the bridge + `bridge_delivery` ledger), ADR-024 (the `domain_events` outbox)
**Depends on:** BULLMQ-1 (jobs backend installable + `bullmq.config.ts` connection machinery), ADR-039 (the generated `eventRegistry` `schedule` blocks)

---

## Problem & goal

Events have no BullMQ backend (ADR-041 §Context). The events subsystem ships drizzle (outbox, default), memory (test), and a dead `RedisEventBus` Pub/Sub variant (`event-bus.redis-backend.ts`) that is bridge- and scheduler-incompatible. Jobs already run on BullMQ (BULLMQ-1) over a Postgres `job_run` source of truth; an all-BullMQ stack needs events on the same Redis with the same Postgres-is-truth shape.

Build a **dispatch-only durable BullMQ events backend over the existing Postgres outbox** (ADR-041 Decision 2) and a **BullMQ scheduler materializer** (ADR-041 Decision 4), delete the dead `RedisEventBus` (ADR-041 Decision 3), and wire both through the events module + CLI. `domain_events` stays the committed-event store and `findById` source of truth, so the bridge's single-transaction exactly-once (ADR-023) is preserved verbatim. BullMQ adds only the dispatch/wake half — this is the events mirror of BULLMQ-1's jobs split (Postgres = source of truth, BullMQ = claim/dispatch).

**It is additive on the events side and subtractive on Redis.** A new backend file + a `backend: 'bullmq'` factory branch + a scheduler arm; minus the entire `RedisEventBus`. The core `IEventBus` protocol (`event-bus.protocol.ts:43`) is untouched; app code that injects `EVENT_BUS` flips `events.backend: bullmq` with no change.

## The design

### `event-bus.bullmq-backend.ts` — dispatch-only durable backend

`BullMQEventBus extends DrizzleEventBus`. The recommendation (mirroring `BullMQJobOrchestrator extends DrizzleJobOrchestrator`, `job-orchestrator.bullmq-backend.ts:80`) is to **extend `DrizzleEventBus` exactly as the jobs backend extends `DrizzleJobOrchestrator`** rather than reimplement the outbox write/read path. Postgres `domain_events` stays the source of truth; BullMQ layers dispatch on top.

| Core `IEventBus` op | BullMQ backend behavior |
|---|---|
| `publish(event, tx?)` | reuse the Drizzle write path — write `domain_events` in the caller's `tx` (the `super.publish` insert at `event-bus.drizzle-backend.ts:276` already does `toInsertValues` + `pool`/`direction`/`tenant_id` columns), then enqueue a wake/dispatch job to BullMQ instead of the LISTEN/NOTIFY wake. The outbox row is the committed fact; the BullMQ job is the dispatch trigger. |
| `publishMany(events, tx?)` | same — batch insert via the Drizzle path (`:287`), then enqueue one wake/dispatch job (de-duped per pool, as the Drizzle backend does for NOTIFY at `:294`). |
| `findById(eventId)` | **inherited from `DrizzleEventBus`** (`:321`) — `SELECT … FROM domain_events WHERE id = ? LIMIT 1`, reading the committed outbox row. This is the bridge's claim-time re-fetch; it MUST return the committed event (not `null`), which is why a durable design is required and Pub/Sub is rejected (ADR-041 Decision 2). |
| `subscribe(type, handler)` | **inherited** in-process registry semantics (`:345`). The BullMQ dispatch path drives the same per-event subscriber dispatch the Drizzle drain does (`event-bus.drizzle-backend.ts:673` `dispatch`); subscribers remain at-most-once best-effort (Tier 1, ADR-023). |
| `IEventReadPort.listEvents` | **inherited** (`DrizzleEventBus implements IEventReadPort`, `:156`, `:465`) — keyset reads over `domain_events`. Unlike the redis backend, `EVENT_READ_PORT` binds to the same instance (the observability combiner gets real results). |
| `materializeScheduledEvent(spec)` | **overridden** — calls `super` (the inherited `:375` `INSERT … ON CONFLICT DO NOTHING` slot insert) then enqueues a wake on `created` so the tick drains promptly. The BullMQ scheduler's repeatable worker calls `this.materializeScheduledEvent(...)` directly (slot-key `ON CONFLICT` idempotency preserved — see below). |
| `lastScheduledSlotMs(type)` | **inherited** (`:442`) — used only by the Drizzle catch-up backfill; harmless to inherit. |

**Dispatch substrate (as built).** Two distinct mechanisms, both on the shared Redis:

1. **Events wake** — `BullMQEventBus` owns a dedicated `events-wake` queue (+ `queue_prefix`) and a concurrency-1 wake `Worker`. `publish`/`publishMany` (and the scheduler's `materializeScheduledEvent` override) enqueue a **deduplicated** wake job after writing the outbox row; the wake worker runs one inherited `drainOnce()` (= `processBatch`) per wake, which dispatches the just-committed rows through the bridge hook (per-event tx + `bridge_delivery` ledger, unchanged) and to in-process subscribers. A **safety heartbeat** (`SAFETY_HEARTBEAT_MS`, 5s) drains on an interval as the correctness backstop, because a Redis wake cannot be atomic with the Postgres commit (a wake enqueued inside the caller's tx may fire before the row is visible). The fast 1s `DrizzleEventBus` poll is NOT used.
2. **Reserved-pool relay (BRIDGE-1)** — the bridge's wrapper `job_run` rows land in the reserved `events_*` pools but are inserted out-of-band (raw insert, not via `start()`), so the jobs side relays them to BullMQ: `BullMQJobOrchestrator.reconcilePending(reservedPools)` re-`dispatch`es pending reserved-pool runs (idempotent by `jobId`), driven by a ~1s timer + boot pass in `JobWorkerModule`. The existing `BullMQJobWorker` (draining the reserved `events_*` queues, BULLMQ-1 §Gotcha 3) then runs the `BridgeDeliveryHandler`. See ADR-041 §5.

**Optional-peer contract.** `bullmq` is an OPTIONAL peer dependency. The backend file uses **type-only** imports for `Queue` / `Worker` / `ConnectionOptions` (types are erased, never resolve `'bullmq'` at runtime) and loads the value constructors lazily via `await import('bullmq')` at first use (`loadBullMq()`) — mirroring `job-orchestrator.bullmq-backend.ts:127`. The lazy load is wrapped in try/catch → a friendly `'BullMQ events backend requires the "bullmq" package. Install it with: npm install bullmq'`. The file is NOT statically imported by `events.module.ts` — it is **lazy-loaded** via `loadBullMqEventBus()` (dynamic non-literal specifier, mirroring the deleted redis path) so a drizzle/memory consumer's tsc never resolves the pruned file, and it is **not re-exported** from `events/index.ts`.

**Shared Redis + config (as built).** Jobs and events share **one Redis** by default. The consumer authors the events connection under `events.extensions.bullmq` mirroring `jobs.extensions.bullmq`:

```yaml
events:
  backend: bullmq
  extensions:
    bullmq:
      redis_url: redis://localhost:6379   # or env REDIS_URL — same resolution as jobs
      queue_prefix: myapp                  # shared with jobs so one Redis is namespaced once
```

> **Cross-subsystem token decision (as built — reversed from the pre-impl recommendation).** The implementation uses a **parallel `EVENTS_BULLMQ_CONNECTION` token** (`events.tokens.ts`, `Symbol.for(tokenKey('events', 'bullmq-connection'))`) + a local `resolveEventsBullMqConnection` (`events.module.ts`), NOT the jobs `BULLMQ_CONNECTION`. Rationale discovered during implementation: importing `../jobs/bullmq.config` would force an events-`bullmq` install to vendor `jobs/bullmq.config.ts` + `pool-config.loader.ts` even for an events-only consumer (no jobs subsystem), widening the cross-subsystem coupling beyond the existing `pg-notify` import. The parallel token keeps the events backend self-contained. **One Redis is still the default**: `resolveEventsBullMqConnection` resolves `events.extensions.bullmq.redis_url → process.env.REDIS_URL → redis://localhost:6379` — the *same* `REDIS_URL` env default the jobs `resolveBullMqConfig` uses, so out of the box both land on one Redis. A consumer who sets divergent `redis_url`s on jobs vs events opts into two Redises (a deliberate choice, not a footgun). `queue_prefix` is likewise an events-side option (`events.extensions.bullmq.queue_prefix`) threaded by the barrel composer; the events wake/scheduler queues are `events-wake`/`events-scheduler` (distinct from any jobs pool queue), so prefix collisions across apps are the only concern the prefix addresses.

### `events.module.ts` wiring

Add a `'bullmq'` arm symmetric to the deleted `redis` arm but bound to the same instance for the read port:

- **`EventsModuleOptions.backend`** union: `'drizzle' | 'memory' | 'bullmq'` (was `… | 'redis'`, `events.module.ts:99`). `redis` removed.
- **`loadBullMqEventBus`** lazy loader mirroring the deleted `loadRedisEventBus` (`:90`) — a non-literal-specifier `await import('./event-bus.bullmq-backend')` so the consumer's tsc never resolves the file for a drizzle/memory install (the `.bullmq-backend.ts` suffix filter prunes it from those vendor sets).
- **`forRoot` `'bullmq'` branch** — provides `EVENTS_MODULE_OPTIONS` + `EVENTS_BULLMQ_CONNECTION` (`resolveEventsBullMqConnection`), binds `EVENT_BUS` via a `useFactory` that `await`s `loadBullMqEventBus` + constructs `new BullMQEventBus(db, connection, options, bridgeHook)` (injecting DRIZZLE + the optional `BRIDGE_OUTBOX_DRAIN_HOOK`), binds `EVENT_READ_PORT` to **the same instance** (`useExisting: EVENT_BUS` — unlike the deleted redis backend, which bound it to `null`), and threads `buildTypedBusProviders`. It deliberately does **NOT** add `EventSchedulerLifecycle` — scheduling is owned by the backend itself (`BullMQEventBus.onApplicationBootstrap`, ADR-041: one scheduler source of truth per backend).
- **`forRootAsync` `buildEventBusAsync` branch** — add the `bullmq` case (parallel to the removed `redis` case), injecting `EVENTS_BULLMQ_CONNECTION` + the optional bridge hook; throws if DRIZZLE is absent (the backend extends DrizzleEventBus). The unknown-backend default now throws rather than silently falling back to memory.
- **Connection token binding** — the `bullmq` branch binds `EVENTS_BULLMQ_CONNECTION` (`resolveEventsBullMqConnection`, parallel-token decision above). The deleted `REDIS_URL` provider goes.

**Scheduler gating (as built).** `EventSchedulerLifecycle` (`:216`, the `setInterval` materializer) is added ONLY on the drizzle/memory `forRoot` branches — the `bullmq` branch omits it entirely. Under `backend: 'bullmq'` the bus owns scheduling itself (below), so the `setInterval` loop never starts (ADR-041 Decision 4: exactly one source of truth per backend). The slot-key `ON CONFLICT` insert is still used — but driven by the BullMQ scheduler worker, not the polling loop.

### The BullMQ scheduler materializer

Lives **in `event-bus.bullmq-backend.ts`** (the bus owns it via `onApplicationBootstrap` — chosen over a sibling file so a drizzle install never vendors scheduler code: the backend file is already pruned + lazy-loaded; a sibling would need its own prune/lazy handling). From the generated `eventRegistry` `schedule` blocks (`scheduledEventsFromRegistry`, `event-scheduler.ts:191`):

- **Register** one BullMQ **Job Scheduler** per scheduled-event type via `upsertJobScheduler` (deterministic id `@schedule/<type>`), mapping `{ every }` → `{ every: ms }`. A dedicated `events-scheduler` worker consumes each fired tick, computes the epoch-aligned slot (`slotStartFor`), and calls **`this.materializeScheduledEvent({ type, slotKey, slotStart, direction, pool })`** — the inherited slot-key `ON CONFLICT` insert (the same scheduled domain event the Drizzle path emits: payload-free fact, `metadata.triggerSource = 'schedule'`, `metadata.scheduleSlot = <slotKey>`). Using `materializeScheduledEvent` (not raw `publish`) keeps the exactly-one-event-per-slot invariant: BullMQ emits one tick per interval cluster-wide, and the `ON CONFLICT` collapses any within-slot duplicate. This preserves time → fact → bridge → job and keeps `job_run` the source of truth (ADR-041 Decision 4; ADR-039 §159).
- **Reconcile-on-boot = upsert-desired + prune-orphans (MANDATORY).** On boot, `upsertJobScheduler` every desired scheduler AND enumerate the broker's existing schedulers and remove any not in the current `eventRegistry`. This closes the ENG-605 zombie-scheduler hole (ADR-039 §44, §177) — the one failure mode the outbox model structurally avoided and a broker-side scheduler re-introduces. Not optional.
- **Gate off the Drizzle path.** The `bullmq` `forRoot` branch omits `EventSchedulerLifecycle`, so the `EventScheduler` `setInterval` loop (`event-scheduler.ts:257`) never runs. The slot-key `ON CONFLICT` insert is still the idempotency guard — driven by the BullMQ scheduler worker. Exactly one materializer per backend.
- **Interval-only.** `{ cron }` → `{ pattern }` is deferred as an additive BullMQ-only extension (ADR-041 Decision 4; ADR-039 §163). No cron parser dependency now.

The YAML `schedule:` contract is unchanged across backends (ADR-039 Decision 1) — only the materializer swaps.

## New files

- **`runtime/subsystems/events/event-bus.bullmq-backend.ts`** — `BullMQEventBus extends DrizzleEventBus`. Type-only `bullmq` import + `await import('bullmq')` lazy load (`loadBullMq`, mirroring `job-orchestrator.bullmq-backend.ts:127`). `publish`/`publishMany` reuse the inherited Drizzle outbox write then enqueue a deduplicated wake; `materializeScheduledEvent` is overridden (super + wake-on-`created`); `findById` / `subscribe` / `listEvents` / `lastScheduledSlotMs` inherited. Connection is the self-contained `EVENTS_BULLMQ_CONNECTION` (no `../jobs/bullmq.config` import — see the token decision above). **The scheduler lives IN this file** (the bus owns it via `onApplicationBootstrap` → `reconcileSchedulers` / `startSchedulerWorker`) — NOT a sibling file, so a drizzle install never vendors scheduler code (this file is already pruned + lazy-loaded). The repeatable tick body computes the epoch-aligned slot and calls `this.materializeScheduledEvent(...)` (slot-key `ON CONFLICT`), NOT a raw `publish`; reconcile-on-boot = upsert-desired + prune-orphans.
- **Unit spec** — `event-bus.bullmq.spec.ts` mirroring `job-orchestrator.bullmq.spec.ts`: `forRoot({ backend: 'bullmq' })` resolves `BullMQEventBus` *without* opening a Redis connection; a static-source scan asserts zero top-level value imports of `'bullmq'`; the scheduler registers/prunes from a fixture registry. The broker round-trip is BULLMQ-VERIFY (Docker-gated), not here.

## CLI / packaging

- **Events `SubsystemDescriptor.backends`** — this change ADDS `'bullmq'` to both the events and jobs descriptors (`src/cli/shared/subsystem-detect.ts`); `main` had `['drizzle', 'memory']` for both. The descriptor gate is what makes `--backend bullmq` installable (`isValidBackend`). `redis` was never listed for events, so there is nothing to remove there. The `.bullmq-backend.ts` suffix filter (`backendFileFilter`) prunes the events bullmq backend from drizzle/memory installs (covered by `src/__tests__/cli/subsystem.test.ts`).
- **Events barrel composer** — add a `backend === 'bullmq'` arm to the events composer (`subsystem-barrel-generator.ts`) that threads `events.extensions.bullmq.{redis_url, queue_prefix}` into the generated `EventsModule.forRoot({ … redisUrl, queuePrefix })`, mirroring the jobs composer. Without it the wake/scheduler queues are unprefixed and the connection ignores a configured `redis_url`.
- **Barrel composer** — add the events `bullmq` arm to the events composer in `subsystem-barrel-generator.ts` (the events composer block has no redis/bullmq arm today; the jobs `bullmq` arm at the jobs composer is the template to mirror). Inline the typed `events.extensions.bullmq` block into the generated `EventsModule.forRoot({ … })` call the way the jobs composer inlines `jobs.extensions.bullmq`.
- **DELETE `event-bus.redis-backend.ts`** + the `redis` arm of `forRoot`/`forRootAsync` (`events.module.ts:296,365`) + the `REDIS_URL` token (`events.tokens.ts`, `:324`, `:373`) + `loadRedisEventBus` (`:90`) + the redis backend tests (ADR-041 Decision 3, no deprecation shim). Grep must come back clean for `RedisEventBus` / `REDIS_URL` / `loadRedisEventBus` afterward.
- **Do NOT re-export `BullMQEventBus`** from `events/index.ts` — the public barrel must stay free of the optional peer (mirrors BULLMQ-1: the jobs backend classes are not re-exported). Rely on the `.bullmq-backend.ts` suffix filter (the same subsystem-agnostic `backendFileFilter` that vendors `*.bullmq-backend.ts` only under `--backend bullmq` and prunes it otherwise) to ship the file conditionally.
- **`domain_events` outbox schema STAYS.** The BullMQ events backend keeps Postgres as the source of truth (ADR-041 Decision 2), so the subsystem-schema-generator still emits the `domain_events` table and the partial UNIQUE slot-key index for a `--backend bullmq` events install. (Contrast a hypothetical Postgres-free variant, which would have to suppress the table — not this design.)

## Gotchas

1. **Optional-peer footguns.** Type-only `bullmq` imports + `await import('bullmq')` only; never a top-level value import. Never re-export `BullMQEventBus` from `events/index.ts`. Rely on the `.bullmq-backend.ts` suffix filter. Any slip drags the optional peer into drizzle consumers' tsc — `TS2307` / smoke-subsystems `findStaticPeerImports` failure. Pin with a static-source regression test (zero top-level `'bullmq'` value imports) + a runtime check that constructing the bus leaves the lazy ctor unloaded (mirror BULLMQ-1).
2. **Zombie-scheduler hazard (prune-orphans MANDATORY).** A broker-side Job Scheduler re-introduces the ENG-605 class the outbox model structurally avoided (ADR-039 §44, §177). Reconcile-on-boot MUST upsert-desired AND prune-orphans. A removed `schedule:` whose Job Scheduler is left in the broker fires forever. This is the highest-risk part of the spec.
3. **Exactly one scheduler source of truth per backend.** Under `backend: 'bullmq'`, the `EventScheduler` `setInterval` loop (`event-scheduler.ts:257`) and the slot-key UNIQUE index do NOT drive emission — the BullMQ Job Scheduler does. Running both double-fires (one tick from each materializer). Gate `EventSchedulerLifecycle` (`events.module.ts:216`) so it does not start the `setInterval` under bullmq.
4. **Config enum tightening + throwing default.** The codegen config is `.passthrough()`, so a typo'd `events.backend` falls through to the module switch default. Tighten the events backend enum (drop `redis`, add `bullmq`) and make the `forRoot`/`buildEventBusAsync` backend switch throw on an unknown default rather than silently picking a backend.
5. **`findById` MUST return the committed event.** The bridge re-fetches at claim time (`event-bus.protocol.ts:69`). Inheriting the Drizzle `findById` (reading `domain_events`) satisfies this; this is precisely why Pub/Sub (`RedisEventBus.findById → null`) was rejected (ADR-041 Decision 2/3). Do not override `findById` to read from BullMQ.
6. **Shared-Redis namespace.** Events have their OWN `events.extensions.bullmq.queue_prefix` (threaded by the barrel composer into `forRoot({ queuePrefix })`, applied by `BullMQEventBus.prefixed()`). Set it to the same value as `jobs.extensions.bullmq.queue_prefix` so a multi-app shared Redis is namespaced consistently. The events queues (`events-wake`, `events-scheduler`) are distinct from jobs pool queues, so the prefix prevents cross-APP collisions (and cross-app scheduler-prune clobber), not jobs↔events collisions.

## Extensions (opt-in; not core)

- **Cron schedules** — `schedule: { cron }` → BullMQ `{ pattern }`, a BullMQ-only additive extension (Drizzle stays interval-only). Deferred (ADR-041 Decision 4; ADR-039 §163). No cron parser dependency now.
- **Bull Board visibility** — scheduled jobs (the framework repeatable producers) are visible in Bull Board when the consumer mounts it (BULLMQ-1 §Extensions; `bullmq.config.ts:66` `bull_board`). Mounting stays the consumer's responsibility.
- **Separate events Redis** — a parallel `events`-namespaced connection token if a consumer ever wants jobs and events on different Redis instances. Not v1 (one Redis is the goal); additive later.

## Verification

The gating deliverable (BULLMQ-VERIFY) shipped as `test/integration/bullmq.integration.test.ts`: a **Docker-gated testcontainers recipe** (ephemeral `postgres:16` + `redis:7-alpine`, gracefully skipped without Docker, **out of `test-all`** — `just test-bullmq-integration`) that runs the real BullMQ broker round-trip BULLMQ-1 §Verification said had never executed in-repo: jobs `start → dispatch → worker → completed`, `runAt` delay, `collisionMode:'queue'` serialization, terminal failure → `status='failed'`, priority mapping; events `publish → wake → drain → findById`, slot-key idempotency, and the Job Scheduler firing a tick. Note: this is a **BullMQ-focused round-trip** that instantiates the bullmq classes directly — NOT a single parametrized suite shared across drizzle/memory/bullmq (drizzle/memory keep their existing separate unit + drizzle-integration suites). The substantive gate (the broker path) is closed; the unified-harness framing in earlier drafts was aspirational. Until green in a consumer's CI, `events.backend`/`jobs.backend: bullmq` stay **opt-in** (default `drizzle`), per ADR-022 §claim.

For events the broker round-trip is `publish → outbox insert → BullMQ wake/dispatch → drain → bridge → wrapper + user run → findById`, plus the scheduler path (a scheduled event materializes once per slot via `upsertJobScheduler`; removing a schedule and rebooting prunes the orphan scheduler with no zombie firing). Until that is green, `events.backend: bullmq` stays **opt-in** (default `drizzle`), exactly as ADR-022 §claim requires.

**Honest note (mirrors BULLMQ-1 §Verification).** This codegen-patterns repo ships `runtime/` INTO consumer projects and does **not** depend on a Postgres driver (`pg`). Every in-repo events test uses the Memory backend or a `drizzle(pg-proxy)` mock that never talks to a real DB. The broker round-trip therefore only runs where Docker + Redis + Postgres are available; the in-repo unit suite proves the wiring (`forRoot` resolves `BullMQEventBus` without connecting), the optional-peer hygiene (no static `'bullmq'` import), and the scheduler register/prune logic against a fixture — it does **not** prove the broker round-trip, and must not be faked to.

## Cross-links

- `docs/adrs/ADR-041-all-bullmq-topology.md` — the deciding ADR (Decisions 2, 3, 4 this spec implements).
- `docs/specs/BULLMQ-1.md` — the jobs BullMQ backend this spec mirrors (extends-the-Drizzle-backend pattern, optional-peer lazy-load contract, `bullmq.config.ts` connection machinery, the verification honesty). BULLMQ-1 §Extensions' stale "cron out of scope (ADR-025)" pointer is corrected to ADR-039/ADR-041 in the same batch.
- `docs/adrs/ADR-039-declarative-time-based-scheduling.md` §159 — the `schedule:` → `upsertJobScheduler` mapping (interval-only, reconcile = upsert + prune, repeatable body publishes the same domain event); to be marked shipped there when this materializer lands.
- `docs/adrs/ADR-023-event-to-job-bridge.md` — the `bridge_delivery` ledger + per-event tx + Case-B pre-write dedup preserved verbatim; the reserved `events_*` pools the wake/dispatch worker drains.
- `runtime/subsystems/jobs/bullmq.config.ts` — the shared connection + `queue_prefix` machinery events reuse.
