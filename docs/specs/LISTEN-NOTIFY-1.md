# LISTEN-NOTIFY-1 — Postgres LISTEN/NOTIFY wakeups for the jobs worker + events drainer

**Issue:** dogfood gap #7 (swe-brain live-inbound latency)
**Status:** Draft
**Last Updated:** 2026-06-04
**Depends on:** JOB-3 (worker loop), JOB-5 (worker module + pool config), EVT-4 (outbox drain), BRIDGE-4 (outbox drain hook), ADR-037 (package mode + namespaced tokens)
**Related ADR:** ADR-022 (Job Orchestration Domain Model — §Drizzle extensions), ADR-024 (Events Domain Formalization)
**Version:** 0.16.0

## Overview

The scaffolded `codegen.config.yaml` has documented `jobs.extensions.drizzle.listen_notify`
("use Postgres LISTEN/NOTIFY to wake the polling loop instead of (or alongside)
interval polling. Disabled by default.") since JOB-6, and `JobsDomainModule`
reserves the typed `DrizzleBackendExtensions.{ listenNotify, pollIntervalMs }`
slot — but **neither knob is wired**:

1. The runtime has **no LISTEN/NOTIFY implementation** anywhere.
2. The barrel generator never threads `jobs.extensions.drizzle.*` (nor
   `poll_interval_ms`) into `JobWorkerModule.forRoot(...)` — the consumer's knobs
   are config-theater. (The runtime *does* already honor
   `JobWorkerOptions.pollIntervalMs`; it just never receives a value from config.)

This spec makes both real. **NOTIFY wakes; polling remains the safety net** — the
feature runs *alongside* interval polling, never instead. A lost notification
degrades to today's latency, never to lost work. Durability is unchanged: every
NOTIFY is emitted **inside the same transaction** as the row write it announces,
so Postgres delivers it only on commit (exactly the transactional-outbox
guarantee the subsystems already depend on).

### Latency target

A webhook-staged event reaches its canonical row through three 1s-poll hops today
(events outbox drain → bridge wrapper job claim → user job claim); measured
spine latency 1.4–3.0 s. With `listen_notify` on, each hop wakes on commit → target
**sub-500 ms** with **zero durability change**.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/jobs/pg-notify.ts` | create | `PgNotifyListener` helper — dedicated `pg` listener connection, reconnect-with-backoff, debounced dispatch. Plus `pgNotify(tx, channel, payload)` in-tx emit helper + channel/payload constants. Shared by jobs + events. |
| `runtime/subsystems/jobs/job-worker.ts` | edit | `listenNotify?` option; LISTEN on `codegen_jobs_wake`; notify for one of the worker's pools → immediate (debounced) claim cycle. |
| `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` | edit | emit `pg_notify(codegen_jobs_wake, pool)` in-tx on the `start()` INSERT (and the retry/resume path is the worker's own UPDATE — see Decisions). Gated on `JOBS_LISTEN_NOTIFY`. |
| `runtime/subsystems/jobs/jobs-domain.tokens.ts` | edit | `JOBS_LISTEN_NOTIFY` token (mirrors `JOBS_MULTI_TENANT`). |
| `runtime/subsystems/jobs/jobs-domain.module.ts` | edit | provide `JOBS_LISTEN_NOTIFY` from `extensions.drizzle.listenNotify`. |
| `runtime/subsystems/jobs/job-worker.module.ts` | edit | thread `pollIntervalMs` + `listenNotify` from `domainModuleExtensions.drizzle` into each spawned `JobWorker`. |
| `runtime/subsystems/jobs/job-worker.bullmq-backend.ts` | edit (guard) | unaffected — BullMQ has native wakeups; LISTEN/NOTIFY is drizzle-only. |
| `runtime/subsystems/events/event-bus.drizzle-backend.ts` | edit | `listenNotify` from `EventsModuleOptions`; LISTEN on `codegen_events_wake`; notify in-tx on `publish`/`publishMany`; wake drains on notify. |
| `runtime/subsystems/events/events.module.ts` | edit | `listenNotify?` on `EventsModuleOptions`. |
| `runtime/subsystems/bridge/bridge-outbox-drain-hook.ts` | edit | the wrapper `job_run` INSERT emits the jobs notify in the same tx (reserved-pool wrappers must wake too). |
| `src/cli/shared/subsystem-barrel-generator.ts` | edit | `jobs` composer threads `domainModuleExtensions: { drizzle: { listenNotify, pollIntervalMs } }` + the worker pollInterval/listenNotify; `events` composer threads `listenNotify` from `events.extensions.drizzle.listen_notify`. |
| `templates/subsystem/jobs-config/codegen-config-jobs-block.ejs.t` | edit | reflect implemented reality; add the events-side knob doc + PgBouncer note. |
| `docs/specs/JOB-6.md` | edit | config-block doc parity. |
| `.claude/skills/jobs/*`, `consumer-skills/jobs/*` | edit | "reserved" → "implemented". |

## Decisions

### D1 — One dedicated listener connection per worker/drainer; polling never stops

`PgNotifyListener` checks out a single long-lived `pg.PoolClient` from the existing
`DRIZZLE.$client` Pool and issues `LISTEN <channel>`. The `pg` `Client` emits a
`'notification'` event; the listener forwards the payload to the owner's callback.
The interval poll timer is **untouched** — it remains the heartbeat. `listen_notify`
only *adds* an early wake.

### D2 — NOTIFY is in-tx; delivery is on-commit (durability invariant)

Every `pg_notify(...)` runs through the **same `tx` handle** as the row write it
announces (orchestrator `start()`, event `publish()`, bridge wrapper insert).
Postgres queues NOTIFY messages and delivers them **only when the transaction
commits** — a rolled-back write emits no phantom wake. This is byte-for-byte the
same guarantee the transactional outbox already relies on. Tests assert a NOTIFY
inside a tx that *rolls back* is never delivered.

### D3 — Debounce / coalesce, not stack

A notification that arrives while a claim cycle is already running sets a
`recheckPending` flag rather than stacking a second cycle. When the current cycle
finishes it re-checks once if the flag is set. A burst of N notifies collapses to
at most one extra cycle. This bounds wake amplification under load (a hot pool
gets one notify per enqueue but never N concurrent claim transactions).

### D4 — Listener death degrades to polling, loudly-once

If the listener connection drops (server restart, network blip), `PgNotifyListener`
logs a single WARN, then reconnects with capped exponential backoff
(100 ms → 5 s). While down, the interval poll loop is the sole driver — i.e. the
system degrades to exactly today's behaviour, never to stalled work. On
reconnect it re-issues `LISTEN` and logs recovery once.

### D5 — Channel + payload shape

- Jobs channel: `codegen_jobs_wake`, payload = the pool name (e.g. `interactive`,
  `events_inbound`). A worker filters: a notify whose payload names one of *its*
  active pools triggers a wake; others are ignored. (Postgres NOTIFY payloads are
  plain strings; the pool name is enough — the worker re-runs its own claim query
  which already filters by pool + `runAt <= now()`.)
- Events channel: `codegen_events_wake`, payload = the event's `pool`
  (`events_inbound` / `events_change` / `events_outbound`) or `''` when null. A
  pool-filtered drainer wakes only for its lanes; an all-pools drainer wakes for any.

Payloads are kept ≤ a handful of bytes (well under Postgres' 8000-byte NOTIFY
limit). No JSON — the wake is a hint; the claim/drain query is the source of truth.

### D6 — Retry/resume wakeups ride the worker's own writes

A run becomes claimable again on three transitions: initial enqueue (`start()`),
retry (worker re-sets `status='pending'` with a future `runAt`), and stale-claim
sweep (worker resets `claimed_at`). Initial enqueue emits notify from the
orchestrator. Retry sets a **future** `runAt` (backoff), so an immediate wake would
claim nothing — the interval poll correctly picks it up when `runAt` elapses; we do
**not** notify on retry (notifying would burn a no-op claim cycle). Stale-sweep
resets to `runAt`-now-eligible rows; those are already-late and the next interval
tick (≤ 1 s) reclaims them — sweeps are a rare recovery path, not a latency-critical
one, so we don't notify there either. **The latency-critical path is the happy path
(enqueue → claim), and that is covered.** Bridge wrapper inserts (a form of enqueue)
DO notify (D7).

### D7 — Bridge wrapper inserts notify

The `BridgeOutboxDrainHook` inserts a wrapper `job_run` (pool `events_<direction>`)
inside the per-event drain tx. That insert emits `pg_notify(codegen_jobs_wake,
<wrapperPool>)` in the same tx so the reserved-pool worker wakes immediately —
otherwise the bridge hop alone would still cost a full poll interval. Gated on the
same listen_notify flag (the hook reads it via the orchestrator's notify path; see
implementation — the hook calls a shared `pgNotify(tx, …)` guarded by a flag
threaded from `BridgeModule`).

### D8 — PgBouncer / transaction-mode pooler caveat

LISTEN/NOTIFY does **not** survive a transaction-mode connection pooler (PgBouncer
`pool_mode = transaction`): the listener's session-scoped `LISTEN` is lost when the
pooler hands the connection to another client between transactions. The feature
**requires a direct (or session-mode) connection**. Documented in the config block
+ skill; if neither is available the consumer simply leaves `listen_notify` off and
keeps polling. No silent breakage: with `listen_notify: true` behind a transaction
pooler, notifies are never received and the system degrades to polling latency (the
documented fallback), which is correct-but-slow rather than wrong.

### D9 — Generator threading

`jobs` composer:
- worker (`JobWorkerModule.forRoot`) gains `domainModuleExtensions: { drizzle: {
  listenNotify, pollIntervalMs } }` whenever `jobs.extensions.drizzle.*` is set
  (drizzle backend only — bullmq keeps its own extension block).
`events` composer:
- `EventsModule.forRoot({ …, listenNotify })` from
  `events.extensions.drizzle.listen_notify` (new optional config key, mirroring the
  jobs shape).

Both flow only on the drizzle/default backend. Package AND vendored emission paths
covered by the existing pure-builder.

## Tests

| Test | Asserts |
|------|---------|
| `pg-notify.spec` | in-tx notify NOT delivered before commit; delivered on commit; rollback → no delivery (integration, real pg). |
| `job-worker.listen-notify.spec` | worker wakes on a notify for its pool well under the poll interval; ignores notify for a foreign pool; listener-death → falls back to polling (claims still happen). |
| `event-bus.listen-notify.spec` | publish emits in-tx notify; drainer wakes on notify; pool-filtered drainer ignores foreign-pool notify. |
| `subsystem-barrel-generator.test` | jobs composer threads `domainModuleExtensions.drizzle.{listenNotify,pollIntervalMs}` + worker knobs; events composer threads `listenNotify`; off-by-default when keys absent (snapshot/string assertions). |
| existing unit + smoke suites | unchanged green. |
