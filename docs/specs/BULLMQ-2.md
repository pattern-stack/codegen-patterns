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
| `materializeScheduledEvent(spec)` | **inherited** (`:375`) — the `INSERT … ON CONFLICT DO NOTHING` slot insert against the partial UNIQUE index. The BullMQ scheduler's repeatable body calls `eventBus.publish(scheduledTick)`, NOT `materializeScheduledEvent` directly (see below); the inherited method stays available for parity but the BullMQ activation path is publish-into-outbox. |
| `lastScheduledSlotMs(type)` | **inherited** (`:442`) — used only by the Drizzle catch-up backfill; harmless to inherit. |

**Dispatch substrate.** The "wake/dispatch job to BullMQ" is a small framework job on a dedicated events queue (or per-pool events queues mapping to the reserved `events_*` lanes the bridge worker already drains — see BULLMQ-BRIDGE-1 in the plan). The worker side that consumes it is the existing jobs `BullMQJobWorker` draining the reserved `events_*` pools (BULLMQ-1 §Gotcha 3, ADR-023 Decision 2): the wake job triggers a drain of the just-committed outbox row through the bridge, preserving the per-event tx + `bridge_delivery` ledger. The exact queue topology is the bridge concern (BULLMQ-BRIDGE-1); BULLMQ-2 owns the publish-writes-outbox-then-enqueues contract.

**Optional-peer contract.** `bullmq` is an OPTIONAL peer dependency. The backend file uses **type-only** imports for `Queue` / `ConnectionOptions` / `Job` (types are erased, never resolve `'bullmq'` at runtime) and loads the value constructors lazily via `await import('bullmq')` at first use — mirroring `event-bus.redis-backend.ts:45` (`createRedisClient`) and `job-orchestrator.bullmq-backend.ts:127` (`loadBullMq`). Each lazy load is wrapped in try/catch → a friendly `'BullMQ backend requires the "bullmq" package. Install it with: npm install bullmq'`. The file is statically importable by `events.module.ts` for a drizzle-only consumer (types erase; the value ctor never loads).

**Shared Redis + config.** Reuse the jobs subsystem's `bullmq.config.ts` connection + `queue_prefix` machinery so jobs and events share **one Redis and one config block**. Recommendation: **reuse the jobs `BULLMQ_CONNECTION` / `resolveBullMqConfig` / `resolvePoolQueueName`** (`bullmq.config.ts:85,104,140`) directly — the events backend imports them from `../jobs/bullmq.config` (the same cross-subsystem pattern the events drizzle backend already uses for `pg-notify`, `event-bus.drizzle-backend.ts:57-61`, and `DrizzleTransaction`, `job-orchestrator.bullmq-backend.ts:38`). This guarantees jobs and events land on the same broker with the same `queue_prefix` namespace. The consumer authors it under `events.extensions.bullmq` mirroring `jobs.extensions.bullmq`:

```yaml
events:
  backend: bullmq
  extensions:
    bullmq:
      redis_url: redis://localhost:6379   # or env REDIS_URL — same resolution as jobs
      queue_prefix: myapp                  # shared with jobs so one Redis is namespaced once
```

> **Cross-subsystem token decision.** Reusing the jobs `BULLMQ_CONNECTION` token (a namespaced `Symbol.for(tokenKey('jobs', 'bullmq-connection'))`, `bullmq.config.ts:85`) means events resolve the *same* connection the jobs subsystem already provides — exactly one Redis. The alternative — a parallel `events`-namespaced connection token — would let jobs and events point at different Redis instances, which is not the goal (one Redis is the whole point of ADR-041 §Decision 1). **Recommended: reuse the jobs token.** If a consumer genuinely wants a separate events Redis later, a parallel token is an additive follow-up; v1 binds events to the jobs connection.

### `events.module.ts` wiring

Add a `'bullmq'` arm symmetric to the deleted `redis` arm but bound to the same instance for the read port:

- **`EventsModuleOptions.backend`** union: `'drizzle' | 'memory' | 'bullmq'` (was `… | 'redis'`, `events.module.ts:99`). `redis` removed.
- **`loadBullMqEventBus`** lazy loader mirroring the deleted `loadRedisEventBus` (`:90`) — a non-literal-specifier `await import('./event-bus.bullmq-backend')` so the consumer's tsc never resolves the file for a drizzle/memory install (the `.bullmq-backend.ts` suffix filter prunes it from those vendor sets).
- **`forRoot` `'bullmq'` branch** — provides `EVENTS_MODULE_OPTIONS`, binds `EVENT_BUS` via a `useFactory` that `await`s `loadBullMqEventBus` + constructs it with the resolved connection, binds `EVENT_READ_PORT` to **the same instance** (`useExisting: EVENT_BUS` — unlike redis, which bound it to `null`, `:348`), threads `buildTypedBusProviders`, and provides `EventSchedulerLifecycle`.
- **`forRootAsync` `buildEventBusAsync` branch** (`:282`) — add the `bullmq` case (parallel to the removed `redis` case at `:296`), injecting the shared `BULLMQ_CONNECTION`.
- **Connection token binding** — the `bullmq` branch injects the jobs `BULLMQ_CONNECTION` (cross-subsystem reuse above). The deleted `REDIS_URL` provider (`:324`, `:373`) goes.

**Scheduler gating.** `EventSchedulerLifecycle` (`:216`) currently spawns the `EventScheduler` `setInterval` whenever the bus supports `materializeScheduledEvent` (`:230`). Under `backend: 'bullmq'` the BullMQ scheduler materializer owns scheduling, so the `setInterval` loop MUST NOT start. Gate it: when `opts.backend === 'bullmq'`, `EventSchedulerLifecycle` either skips entirely or delegates to the BullMQ materializer (see below) — never both (ADR-041 Decision 4: exactly one source of truth per backend). The slot-key UNIQUE index / `lastScheduledSlotMs` backfill do not drive emission under bullmq.

### The BullMQ scheduler materializer

Lives either in `event-bus.bullmq-backend.ts` or a sibling `event-bus.bullmq-scheduler.ts` (recommendation: a sibling, keeping the dispatch backend and the scheduler concern separable, like the jobs orchestrator/worker split). From the generated `eventRegistry` `schedule` blocks (`scheduledEventsFromRegistry`, `event-scheduler.ts:191`):

- **Register** one BullMQ **Job Scheduler** per scheduled-event type via `upsertJobScheduler`, mapping `{ every }` → `{ every: ms }` (`parseEvery`, `event-scheduler.ts:52`). The repeatable body is the framework job whose handler calls **`eventBus.publish(scheduledTick)`** — publishing the **same scheduled domain event into the outbox** (payload-free fact, `metadata.triggerSource = 'schedule'`, `metadata.scheduleSlot = <slotKey>`; the same shape `materializeScheduledEvent` builds at `event-bus.drizzle-backend.ts:379`). This preserves time → fact → bridge → job and keeps `job_run` the source of truth (ADR-041 Decision 4; ADR-039 §159).
- **Reconcile-on-boot = upsert-desired + prune-orphans (MANDATORY).** On boot, `upsertJobScheduler` every desired scheduler AND enumerate the broker's existing schedulers and remove any not in the current `eventRegistry`. This closes the ENG-605 zombie-scheduler hole (ADR-039 §44, §177) — the one failure mode the outbox model structurally avoided and a broker-side scheduler re-introduces. Not optional.
- **Gate off the Drizzle path.** When the BullMQ scheduler is active, the `EventScheduler` `setInterval` loop (`event-scheduler.ts:257`) and the slot-key UNIQUE index do NOT run. Exactly one materializer per backend.
- **Interval-only.** `{ cron }` → `{ pattern }` is deferred as an additive BullMQ-only extension (ADR-041 Decision 4; ADR-039 §163). No cron parser dependency now.

The YAML `schedule:` contract is unchanged across backends (ADR-039 Decision 1) — only the materializer swaps.

## New files

- **`runtime/subsystems/events/event-bus.bullmq-backend.ts`** — `BullMQEventBus extends DrizzleEventBus`. Type-only `bullmq` import + `await import('bullmq')` lazy load (mirror `event-bus.redis-backend.ts:45` + `job-orchestrator.bullmq-backend.ts:127`). `publish`/`publishMany` reuse the Drizzle outbox write then enqueue a wake/dispatch job; `findById` / `subscribe` / `listEvents` / `materializeScheduledEvent` / `lastScheduledSlotMs` inherited. Imports the jobs `BULLMQ_CONNECTION` / `resolveBullMqConfig` / `resolvePoolQueueName` from `../jobs/bullmq.config`.
- **`runtime/subsystems/events/event-bus.bullmq-scheduler.ts`** (recommended sibling) — the `upsertJobScheduler` materializer: register-one-per-type from `scheduledEventsFromRegistry`, repeatable body `eventBus.publish(scheduledTick)`, reconcile-on-boot upsert + prune-orphans. Type-only `bullmq` + lazy load.
- **Unit spec** — `event-bus.bullmq.spec.ts` mirroring `job-orchestrator.bullmq.spec.ts`: `forRoot({ backend: 'bullmq' })` resolves `BullMQEventBus` *without* opening a Redis connection; a static-source scan asserts zero top-level value imports of `'bullmq'`; the scheduler registers/prunes from a fixture registry. The broker round-trip is BULLMQ-VERIFY (Docker-gated), not here.

## CLI / packaging

- **Events `SubsystemDescriptor.backends`** — add `'bullmq'` (`src/cli/shared/subsystem-detect.ts:73-79`). **Already present on this branch** — the descriptor reads `backends: ['drizzle', 'memory', 'bullmq']` with an ADR-041 comment; `redis` was never listed, so nothing to remove there. Verify `isValidBackend('events', 'bullmq')` and reject `'redis'`.
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
6. **Shared-Redis namespace.** Events reuse the jobs `queue_prefix` (`resolvePoolQueueName`, `bullmq.config.ts:140`) so jobs and events queues don't collide on one Redis. Confirm the events wake/dispatch queue names route through the same prefix.

## Extensions (opt-in; not core)

- **Cron schedules** — `schedule: { cron }` → BullMQ `{ pattern }`, a BullMQ-only additive extension (Drizzle stays interval-only). Deferred (ADR-041 Decision 4; ADR-039 §163). No cron parser dependency now.
- **Bull Board visibility** — scheduled jobs (the framework repeatable producers) are visible in Bull Board when the consumer mounts it (BULLMQ-1 §Extensions; `bullmq.config.ts:66` `bull_board`). Mounting stays the consumer's responsibility.
- **Separate events Redis** — a parallel `events`-namespaced connection token if a consumer ever wants jobs and events on different Redis instances. Not v1 (one Redis is the goal); additive later.

## Verification

The gating deliverable is the **reusable cross-backend contract harness** (the thing BULLMQ-1 §Verification said does not exist) + a **Docker-gated testcontainers recipe** (Redis + Postgres), run against drizzle / memory / bullmq for both subsystems, **out of `test-all`**, gracefully skipped without Docker (BULLMQ-VERIFY in the plan; ADR-041 Decision 7).

For events the broker round-trip is `publish → outbox insert → BullMQ wake/dispatch → drain → bridge → wrapper + user run → findById`, plus the scheduler path (a scheduled event materializes once per slot via `upsertJobScheduler`; removing a schedule and rebooting prunes the orphan scheduler with no zombie firing). Until that is green, `events.backend: bullmq` stays **opt-in** (default `drizzle`), exactly as ADR-022 §claim requires.

**Honest note (mirrors BULLMQ-1 §Verification).** This codegen-patterns repo ships `runtime/` INTO consumer projects and does **not** depend on a Postgres driver (`pg`). Every in-repo events test uses the Memory backend or a `drizzle(pg-proxy)` mock that never talks to a real DB. The broker round-trip therefore only runs where Docker + Redis + Postgres are available; the in-repo unit suite proves the wiring (`forRoot` resolves `BullMQEventBus` without connecting), the optional-peer hygiene (no static `'bullmq'` import), and the scheduler register/prune logic against a fixture — it does **not** prove the broker round-trip, and must not be faked to.

## Cross-links

- `docs/adrs/ADR-041-all-bullmq-topology.md` — the deciding ADR (Decisions 2, 3, 4 this spec implements).
- `docs/specs/BULLMQ-1.md` — the jobs BullMQ backend this spec mirrors (extends-the-Drizzle-backend pattern, optional-peer lazy-load contract, `bullmq.config.ts` connection machinery, the verification honesty). BULLMQ-1 §Extensions' stale "cron out of scope (ADR-025)" pointer is corrected to ADR-039/ADR-041 in the same batch.
- `docs/adrs/ADR-039-declarative-time-based-scheduling.md` §159 — the `schedule:` → `upsertJobScheduler` mapping (interval-only, reconcile = upsert + prune, repeatable body publishes the same domain event); to be marked shipped there when this materializer lands.
- `docs/adrs/ADR-023-event-to-job-bridge.md` — the `bridge_delivery` ledger + per-event tx + Case-B pre-write dedup preserved verbatim; the reserved `events_*` pools the wake/dispatch worker drains.
- `runtime/subsystems/jobs/bullmq.config.ts` — the shared connection + `queue_prefix` machinery events reuse.
