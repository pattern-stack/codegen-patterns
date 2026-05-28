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
- **`subsystem list` can report `incomplete`, and that's usually fine.**
  Installing one subsystem may vendor *stub* files of another — e.g. installing
  `events` drops `bridge/bridge.protocol.ts` + `bridge.tokens.ts` because the
  events Drizzle backend imports them. That `bridge/` directory has the protocol
  stubs but no `bridge.module.ts`, so `subsystem list` shows it `incomplete`. It
  is **not** registered in the generated `subsystems.ts` barrel (the barrel only
  emits a `forRoot()` for subsystems whose `<name>.module.ts` exists), so it
  won't break your `tsc`. Run `subsystem install bridge` to promote it to
  `installed` when you actually want the bridge.
- **`--backend memory`** is for tests; the scaffolded default is `drizzle`
  (`local` for storage).
- **Install vendors only the selected backend.** Alternate-backend source
  files are pruned: a `--backend drizzle` events install does NOT vendor
  `event-bus.redis-backend.ts`, and a drizzle/memory jobs install does NOT
  vendor `job-orchestrator.bullmq-backend.ts`, `job-worker.bullmq-backend.ts`,
  or `bullmq.config.ts`. The module files (`events.module.ts`,
  `jobs-domain.module.ts`, `job-worker.module.ts`) lazy-load the chosen
  backend via dynamic `import()` with a non-literal specifier, so the unused
  backends never drag their peer deps (`ioredis`, `bullmq`) into your `tsc`
  graph. `bullmq` and `ioredis` are declared as **optional peer
  dependencies** — install them ONLY if you actually select that backend.
- **Bundler caveat.** The dynamic-import specifier is captured in a variable
  (e.g. `const spec = './event-bus.redis-backend'; await import(spec)`) on
  purpose — that's what makes `tsc` treat it as `any` and skip resolving the
  pruned file. A bundler (webpack / esbuild / rollup) won't static-analyse a
  non-literal specifier either, so it won't include the dynamically-imported
  file in its output bundle. In practice this is fine: when the file isn't
  vendored (drizzle install) there's nothing to bundle; when it IS vendored
  (redis / bullmq install) consumers typically run Node/Bun directly against
  the source tree. If you bundle a redis/bullmq build for deployment, ensure
  your bundler is configured to include the vendored
  `<subsystems-root>/<name>/` tree (e.g. mark it as external + ship alongside)
  or pin the dynamic-import path to a literal in your own wrapper.

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

## Removing a subsystem

`codegen subsystem remove <name>` deletes the vendored
`<subsystems-root>/<name>/` directory and regenerates
`src/generated/subsystems.ts` so the removed subsystem drops out of the
`SUBSYSTEM_MODULES` barrel. Git-safety gated like install (warns on
uncommitted changes; `--force` overrides). `--yes`/`-y` is accepted for flag
parity with `install`.

What removal does NOT do (intentionally — explicit beats silent rewrites):

- It does **not** strip the `<name>:` block from `codegen.config.yaml`.
- It does **not** remove the `<Name>Module.forRoot(...)` line from
  `app.module.ts`.
- It does **not** strip shared runtime deps (`src/shared/types/drizzle.ts`,
  `src/shared/constants/tokens.ts`) — other subsystems may still need them.

The CLI prints the two follow-up edits on success. `openapi-config` (a
config-only pseudo-subsystem) and `auth-integrations` (vendored outside the
subsystems root, alongside the codegen-emitted entity layer) are not
auto-removable — the command errors with the right manual next-step.
