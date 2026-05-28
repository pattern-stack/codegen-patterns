---
name: subsystems
description: >-
  Load when installing or wiring an infrastructure subsystem in a project that
  uses @pattern-stack/codegen — events, jobs, cache, storage, sync, bridge,
  observability, auth, or the OpenAPI config. Covers `codegen subsystem
  install`, the `forRoot` registration ORDER in app.module.ts, which subsystems
  depend on which, and multi-tenancy opt-in. Get the order wrong and the bridge
  sits idle or observability sees nothing — this skill is the source of truth
  for ordering until the CLI enforces it.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Infrastructure subsystems

Subsystems are the generated infrastructure your use cases call: an event bus,
a job queue, a cache, file storage, an external-sync engine, the event-to-job
bridge, a read-only observability facade, and OAuth auth. Each follows one
pattern — **Protocol (port) → Backend (adapter) → Factory (`DynamicModule.
forRoot`)** — and each is `global: true`, so you register it once in
`app.module.ts` and inject its token anywhere.

## Mental model

- **Install vendors runtime + injects config.** `codegen subsystem install
  <name>` copies the subsystem's runtime into `<subsystems-root>/<name>/`
  (default `src/shared/subsystems/<name>/`) and adds its block to
  `codegen.config.yaml`. You then add one `forRoot(...)` line to `app.module.ts`.
- **Backends are swappable; tests use memory.** Most subsystems ship a Drizzle
  (Postgres) production backend and a memory backend for tests. Swap via the
  `forRoot({ backend })` arg — app code is unchanged.
- **Order matters.** Some subsystems consume others. The bridge consumes events
  + jobs; observability composes events/jobs/bridge/sync read ports via
  optional DI. Registering them in the wrong order means a silently idle bridge
  or an observability facade that reports nothing. See `wiring-and-order.md`.

## The subsystems

| Subsystem | Token / module | Install | Depends on |
|---|---|---|---|
| events | `EventsModule` | `subsystem install events` | — |
| jobs | `JobsDomainModule` + `JobWorkerModule` | `subsystem install jobs` | — |
| cache | `CacheModule` | `subsystem install cache` | jobs (optional, for cleanup) |
| storage | `StorageModule` | `subsystem install storage` | — |
| sync | `SyncModule` | `subsystem install sync` | — |
| bridge | `BridgeModule` | `subsystem install bridge` | **events + jobs** |
| observability | `ObservabilityModule` | `subsystem install observability` | composes events/jobs/bridge/sync (optional) |
| auth | `AuthModule` | `subsystem install auth` | — |
| auth-integrations | `IntegrationsAuthModule` | `subsystem install auth-integrations` | **auth** |
| openapi | (config only) | `subsystem install openapi-config` | registry vendored at init |

## Registration order (authoritative)

In `app.module.ts`, import in this order (omit what you haven't installed):

1. `DatabaseModule` — provides `DRIZZLE`; must be first.
2. `OpenApiModule` — the registry singleton (vendored at init).
3. `EventsModule.forRoot(...)`
4. `JobsDomainModule.forRoot(...)` **and** `JobWorkerModule.forRoot(...)`
5. `CacheModule` / `StorageModule` / `SyncModule.forRoot(...)`
6. `BridgeModule.forRoot(...)` — **after** events + jobs.
7. `ObservabilityModule.forRoot(...)` — **last** of the subsystems (composes the
   ones above via optional DI).
8. `...GENERATED_MODULES` — your entity modules.

For auth: register `AuthModule.forRoot(...)` before the `IntegrationsAuthModule`
that depends on it. Full per-subsystem `forRoot` signatures, the bridge reserved
pools, and multi-tenancy are in `wiring-and-order.md`.

## Non-obvious rules

- **Jobs is two modules, not one.** `JobsDomainModule.forRoot({ backend })`
  wires the orchestrator/run-services; `JobWorkerModule.forRoot({ mode, backend,
  pools })` runs the worker loop. Pool *definitions* (concurrency, reserved
  lanes) live in `codegen.config.yaml` under `jobs.pools`; `JobWorkerModule`'s
  `pools:` is the list of *active* pool names this process drains.
- **The bridge will sit idle unless its reserved pools are polled.** The worker
  must drain `events_inbound` / `events_change` / `events_outbound` — spread
  `...BRIDGE_RESERVED_POOLS` into `JobWorkerModule`'s `pools`, or use `allPools:
  true`. `BridgeModule` fails fast at boot if they aren't polled. See the
  `bridge` skill.
- **Observability composes optionally.** It reads whatever sibling subsystems
  are present; missing ones are simply absent from its output. That's why it
  must be registered after them.
- **Multi-tenancy is a config flip + a `forRoot` flag + a migration** — never a
  runtime-only toggle. See `wiring-and-order.md`.
- **`--backend memory`** is for tests; the scaffolded default is `drizzle`
  (`local` for storage).

## Do not

- **Do not register `BridgeModule` before `EventsModule` + the jobs modules** —
  it consumes their tokens.
- **Do not register `ObservabilityModule` before the subsystems it reports on.**
- **Do not route your own jobs into the reserved `events_*` pools** — those are
  the bridge's; module init rejects it. Declare your own pool.
- **Do not hand-edit vendored subsystem files** under `<subsystems-root>/<name>/`
  — `codegen update` overwrites them. Compose/subclass instead.
- **Do not expect `codegen update` to refresh subsystem *schemas*.** It re-syncs
  runtime source, not the tenancy-gated Drizzle schema files. If a schema shape
  changed across versions, re-run `subsystem install <name> --force
  --force-config`.
