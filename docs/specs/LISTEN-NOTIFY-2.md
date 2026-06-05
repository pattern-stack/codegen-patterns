# LISTEN-NOTIFY-2 — shutdown leak: a `LISTEN %wake%` listener survives `app.close()`

**Issue:** swe-brain dogfood — boot-check / CI hang on `@pattern-stack/codegen` 0.17.1
**Status:** Implemented
**Last Updated:** 2026-06-04
**Depends on:** LISTEN-NOTIFY-1 (0.16.0 — the wake listener this hardens)
**Related ADR:** ADR-022 (Job Orchestration — §Drizzle extensions), ADR-024 (Events Domain)
**Version:** 0.17.2 (patch)

## Overview

LISTEN-NOTIFY-1 (0.16.0) added `PgNotifyListener` — a dedicated `pg.PoolClient`
that issues `LISTEN codegen_jobs_wake` / `codegen_events_wake` to wake the poll
loop on commit. One listener per jobs pool worker + one for the events drainer.

The swe-brain dogfood found that a NestJS app booted via
`NestFactory.createApplicationContext(AppModule)`, then `app.close()`d (its
`boot-check.ts`, also a CI step), **never exits**: at least one
`LISTEN codegen_jobs_wake` client survives `app.close()`, holding an ESTABLISHED
pg socket open forever. Two swe-brain CI runs hung for hours.

Evidence: 22 s after close, `lsof` showed exactly one TCP connection to Postgres;
`pg_stat_activity` showed that backend's last query was `LISTEN codegen_jobs_wake`
(started at boot). The events listener and the *other* pool workers' listeners
cleaned up — only **one** of six jobs listeners survived. A healthy running app
shows 6 LISTEN backends (1 events + 5 jobs pools), one per pool worker.

## Root cause

Two defects in the shared listener teardown; the **first is what actually fired**
in the swe-brain sample, the second is a latent hardening:

### RC1 (fired) — `stop()` races an in-flight `connect()`

`PgNotifyListener.connect()` checked `this.stopped` only at *entry*. The body
then `await this.opts.pool.connect()`, wired handlers, issued `LISTEN`, and
**finally** assigned `this.client = client`. A `stop()` arriving during the
`pool.connect()` await ran `releaseClient()`, which saw `this.client === null`
(nothing checked out yet) and returned. The in-flight `connect()` then resumed,
assigned the client, and issued `LISTEN` — **leaking a checked-out connection
holding `LISTEN <channel>` with no owner left to release it.**

With 5–6 listeners all starting at bootstrap and `app.close()` arriving
~immediately (a boot-check), this race fires on ~1 of 6 listeners — exactly the
observed signature (one survivor, the rest clean). The race is timing-sensitive:
a close with even a ~250 ms settle delay usually lets `connect()` finish first
(so `stop()` finds an assigned client and releases it); a *tight* close — the
boot-check shape — reliably loses the race on one listener.

### RC2 (latent) — `JobWorker.onModuleDestroy` early-return skipped listener stop

`JobWorker.onModuleDestroy()` has a double-fire guard: SIGTERM invokes
`onModuleDestroy`, then Nest invokes it again, hitting
`if (this.shuttingDown) { await this.drainInFlight(); return; }`. The
`notifyListener.stop()` call lived **only on the first (non-`shuttingDown`)
branch**, so a SIGTERM-then-Nest double-destroy (or any path that set
`shuttingDown` before the listener was stopped) skipped the listener teardown.
Not the trigger in the boot-check sample (no SIGTERM there), but a real leak
under the standard SIGTERM shutdown path.

`DrizzleEventBus.onModuleDestroy` already stopped its listener unconditionally
and has no double-fire path, but it shares `PgNotifyListener` and was therefore
equally exposed to RC1 (it just didn't fire in the sample).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/jobs/pg-notify.ts` | edit | RC1 fix. Split `connect()` into a tracked `connecting` promise + `doConnect()`. Re-check `this.stopped` AFTER `pool.connect()` resolves and AFTER `LISTEN` — if stopped, release the raw client and bail before assignment. `stop()` awaits the in-flight `connecting` promise before its own `releaseClient()`. New `releaseRawClient()` helper shared by the normal release path + the race bail-outs. |
| `runtime/subsystems/jobs/job-worker.ts` | edit | RC2 fix. Hoist listener teardown into `stopNotifyListener()` (idempotent) and call it on EVERY `onModuleDestroy` path, including the `shuttingDown` early return. |
| `src/__tests__/runtime/subsystems/listen-notify.spec.ts` | edit | §6 — deterministic unit proof of RC1: a controllable `pool.connect()` / `LISTEN` gate forces the race; asserts the checked-out client is released and `LISTEN` never survives. Plus a test that `stop()` does not resolve while a checkout is in flight. |
| `test/integration/listen-notify-shutdown-leak.drizzle.integration.test.ts` | create | Integration falsifier: boots a real Nest context (jobs allPools + events, `listen_notify` on) against a Postgres testcontainer, `app.close()`s in a loop, asserts zero surviving `LISTEN %wake%` backends in `pg_stat_activity`. |
| `justfile` | edit | `test-listen-notify-leak-integration` recipe. |
| `CHANGELOG.md` | edit | 0.17.2 entry. |
| `package.json` | edit | version bump → 0.17.2 (done at release time / by Doug). |

## Decisions

### D1 — Re-check `stopped` after every await in `connect()`, not just at entry

The checkout (`pool.connect()`) and the `LISTEN` round-trip are both async
suspension points where a `stop()` can interleave. Each is followed by an
`if (this.stopped) { releaseRawClient(client); return; }` guard so a stop that
lands in either window destroys the just-acquired client and never assigns it.
`release(true)` (destroy) is used so a half-listening socket is never returned to
the pool for reuse.

### D2 — `stop()` awaits the in-flight `connect()`

Tracking `this.connecting` (set for the duration of `doConnect()`) lets `stop()`
`await` it before releasing. This guarantees `stop()` (and therefore
`onModuleDestroy` / `app.close()`) does not return while a checkout is still
mid-flight — without it, `app.close()` could resolve, the process could move to
exit, and a resuming `connect()` could still issue `LISTEN` on a doomed socket.
`stopped` is set *first* (before the await) so the awaited `connect()` self-bails
via D1; the await is purely a teardown barrier.

### D3 — Listener stop on every JobWorker destroy path

`onModuleDestroy` now calls `stopNotifyListener()` unconditionally at the top,
before the `shuttingDown` early-return branch. The helper nulls
`notifyListener` first so a second invocation (SIGTERM + Nest) no-ops. Combined
with D1/D2 the worker releases its listener exactly once, on whichever destroy
path arrives first, even under double-fire.

### D4 — Falsifier must fire the race, not pass by luck

A single-listener, single-run, settle-delayed close passes pre-fix (the race
window closes before `stop()`). The proof therefore comes in two forms:
- **Unit (deterministic):** a hand-gated `pool.connect()` / `LISTEN` holds the
  checkout open precisely across the `stop()` call — the race fires every run.
  These three tests fail pre-fix, pass post-fix.
- **Integration (real path):** 6 real listeners (5 jobs pools + 1 events) +
  repeated *tight* `app.close()` cycles against a real Postgres. The no-settle
  variant reliably leaks pre-fix (the suite times out — the exact boot-check
  hang); both variants pass post-fix with zero `LISTEN %wake%` survivors.

## Tests

| Test | Asserts |
|------|---------|
| `listen-notify.spec` §6 (3 cases) | RC1: stop()-during-`pool.connect()` releases the client + never LISTENs; stop()-during-`LISTEN` releases the client; `stop()` does not resolve while a checkout is in flight (then releases it). All FAIL pre-fix, PASS post-fix. |
| `listen-notify-shutdown-leak.drizzle.integration` (2 cases) | Real Nest boot (6 LISTEN backends) → `app.close()` → zero surviving `LISTEN %wake%` in `pg_stat_activity`, over repeated cycles; one settled + one tight-race variant. Tight variant times out (leaks) pre-fix; both pass post-fix. Skips gracefully without Docker. |
| existing `listen-notify.spec` §1–§5 | unchanged green (no behaviour change to the happy path). |
| `just test-unit` (2574 tests) | unchanged green. |

## Consumer follow-up

swe-brain shipped a consumer-side mitigation — an explicit `process.exit(0)` in
its `boot-check.ts` (commit `f283b6c`) — to stop the CI hang. Once 0.17.2 is
published and consumed, that mitigation is **revertible**: the framework now
releases the listener on close, so the process exits on its own.
