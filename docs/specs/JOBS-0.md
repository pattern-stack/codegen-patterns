# JOBS-0 — `jobs.backend: memory` reaches the worker (#656); generated files the app imports are never optional output (#655)

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issues:** #656 (first commit), #655
**Project:** #578
**Depends on:** GEN-0 (#652 — `jobWorkerBackendOptions`, the one worker-options builder), CFG-1 (#643 —
`<generated>/app-config.ts`)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles

## Charter invariants this PR touches

- **I1 declare once.** #656: the worker's backend default is restated implicitly — the builder omits `backend` for
  anything but `bullmq` and relies on `JobWorkerModule.forRoot`'s `opts.backend ?? 'drizzle'`. The configured value
  must be the one the worker gets.
- **I2 generated means regenerated.** #655: a generated file the app imports that silently stays stale (or is never
  written) while the command exits 0 is not regenerated.
- **I7 no shims.** The "opt-in" soft-fail rationale is deleted, not kept behind a flag.
- **I9 gates are honest.** A failed regeneration is an error with an exit code, not a warning.

## #656 — the worker gets the configured backend

### Today

`jobWorkerBackendOptions` (`src/cli/shared/job-worker-options.ts`) returns `{}` / `{ domainModuleExtensions }` for
drizzle **and memory**, `{ backend: 'bullmq', … }` for bullmq. `JobWorkerModule.forRoot` boots its inner
`JobsDomainModule` with `opts.backend ?? 'drizzle'`. With `backend: memory` + `worker_mode: embedded`,
`<generated>/subsystems.ts` composes `JobsDomainModule.forRoot({ backend: 'memory', … })` next to a `JobWorkerModule`
whose inner `JobsDomainModule` is drizzle — two orchestrator backends in one process, both `global: true`, both
providing the same tokens.

### Decision

**The builder always emits `backend`.** `jobWorkerBackendOptions` returns `{ backend, … }` for every backend. The
builder no longer knows the runtime's default; the generated worker options state the configured value, exactly as the
domain call already does (`JobsDomainModule.forRoot({ backend: '<backend>', … })` has always emitted it). Consequence:
every generated jobs install gains `backend: 'drizzle'` in the embedded `JobWorkerModule.forRoot({ … })` call and in
`jobWorkerOptions` (`<generated>/app-config.ts`) — the intended changed case; snapshots regenerate (I7).

**`JobWorkerModuleOptions.backend` is required; the runtime fallback is deleted** (review). With the generator always
stating it, `opts.backend ?? 'drizzle'` (`job-worker.module.ts`, `onModuleInit` and `forRoot`) was reachable only by
hand-written callers — and a defaulted worker backend next to a differently-configured `JobsDomainModule` is exactly
the two-backend boot #656 removes. One default, in the config schema (I1, I7). Every in-repo caller (runtime specs,
integration test, smoke verifiers, skill examples) already passed it.

**The `main.ts` jobs hint stops telling consumers to hand-wire the worker** (review). `templates/subsystem/jobs/
main-hook.ejs.t` said "add `JobWorkerModule.forRoot({ mode: 'embedded' })` to AppModule imports" — no `backend`, and a
second `JobWorkerModule` next to the one the barrel composes. It now says: set `jobs.worker_mode: embedded` and
regenerate; the generated `SUBSYSTEM_MODULES` composes the worker with `jobs.backend`. (Not `jobWorkerOptions`: that
value is the standalone worker's — `mode: 'standalone'`, `allPools: true`.) The sentinel line is unchanged, so
already-injected `main.ts` files are left alone.

**`backend: memory` with a standalone worker is a config error.** A separate worker process cannot share an
in-memory store: the API enqueues into its own process's `MemoryJobStore`, the worker drains another. `JobsConfigSchema`
gains a `superRefine`: `backend: 'memory'` with the effective worker mode `standalone` is an issue at path
`jobs.worker_mode` naming both keys:

> `jobs.backend: memory` cannot run a standalone worker — a separate process cannot share the in-memory job store.
> Set `jobs.worker_mode: embedded`, or use `jobs.backend: drizzle` / `bullmq`.

"Effective" is the barrel's rule — `worker_mode` absent means `standalone` (the jobs composer adds no
`JobWorkerModule`). That default is declared once as `DEFAULT_JOBS_WORKER_MODE` next to the schema and read by the
refinement and the jobs composer. (The jobs scaffold reads absent as `embedded` — a second default, pre-existing:
#659.)

No smoke, junction, integration or unit fixture uses `backend: memory` with a standalone (or absent) worker mode in a
parsed config (checked: the one `jobs: { backend: 'memory' }` literal, `subsystem-package-detect.test.ts`, feeds
`configuredInstalledSubsystems` directly and is never schema-parsed).

### Tests

- `job-worker-options` unit cases: `memory` → `{ backend: 'memory' }`; `drizzle` (absent) → `{ backend: 'drizzle' }`;
  drizzle + knobs; bullmq ± extensions.
- Barrel: `backend: memory` + `worker_mode: embedded` → the domain call and the worker call both carry
  `backend: 'memory'` and no `'drizzle'` appears in the barrel — one backend in the process.
- Schema: `memory` + `standalone` and `memory` + absent fail with the message at `jobs.worker_mode`; `memory` +
  `embedded` and `drizzle` + `standalone` parse.

## #655 — a failed regeneration fails the command

### Today

Three call sites wrap barrel regeneration in `try { … } catch { printWarning(…) }` and exit 0:

| Site | Writes |
|---|---|
| `entity new` post-step (`src/cli/commands/entity.ts`) | `regenerateBarrels` → `<generated>/modules.ts`, `schema.ts`; `regenerateSubsystemBarrel` → `subsystems.ts`, `app-config.ts` (+ package-mode `bridge-registry.ts` / `events/*` stubs, vendored `events/generated/*` stub); `regenerateSubsystemSchemaBarrel` → `subsystems-schema.ts` |
| `subsystem install` vendored path (`subsystem.ts`) | `regenerateSubsystemBarrel` |
| `subsystem install` package path (`subsystem.ts`) | `regenerateSubsystemBarrel` + `regenerateSubsystemSchemaBarrel` |

The comments justify it with "the subsystem barrel is opt-in", which died with CFG-1: `app-config.ts` is imported by
the generated `main.ts` and `worker.ts` unconditionally.

### Decision

- `src/cli/shared/generated-file.ts` (new): `GeneratedFileError` (`file` + cause; message
  `could not regenerate <file>: <cause>`) and `generating(file, fn)`, which runs a build-and-write step and rethrows any
  failure as a `GeneratedFileError` naming that file. The generators wrap each file's step, so the error names the file
  that failed, not the call.
- `reportRegenerationFailure(command, err)`: `printError` in text mode, `printJson({ command, status: 'error', file,
  error })` in JSON mode; returns `1`. Every call site `return reportRegenerationFailure(…)`; the `try/catch` that
  swallowed and the "opt-in" / "warn-but-don't-fail" comments are deleted.
- **Every call site, not three.** The same warn-only wrapper around the same generators sat in `subsystem remove`
  (`subsystems.ts`), `relationship new` and `junction new` (`modules.ts` + `schema.ts`) — the issue's defect at sites
  it did not list. All six now fail the command. `subsystem remove --json` loses its `barrelRegenerated` field (always
  true, or the command fails).
- **`subsystem install --json` (vendored) regenerates at all.** It returned before the barrel step, so in JSON mode
  `subsystems.ts` / `app-config.ts` were never refreshed. The regeneration now runs before the JSON / dry-run branches
  (skipped on `--dry-run`), and before the "installed" success line, so a failure is never reported after a success.
- `writeAppConfig` / `syncAppConfig` wrap their own write in `generating(...)`, so every writer of `app-config.ts` —
  including `subsystem install openapi-config` (now `reportRegenerationFailure`, was an uncaught stack trace) and
  `project upgrade-openapi` / `upgrade-auth` (already exit 1 on a throw; the message now names the file) — reports the
  file. `project init` writes it through its own plan writer.
- Subsystem detection (`detectInstalledSubsystems`, which scans the vendored tree) failing is reported against the
  barrel it feeds (`GeneratedFileError(barrelAbs, …)`); the entity-YAML scan is reported against `modules.ts`.
- **Genuinely optional output at these sites: none.** Every file the three generators write is imported by the app
  (`modules.ts` / `subsystems.ts` by `app.module.ts`, `schema.ts` / `subsystems-schema.ts` by the Drizzle schema wiring drizzle-kit and the app read,
  `app-config.ts` by `main.ts` / `worker.ts` / `subsystems.ts`, the registry / events stubs by `subsystems.ts`).
  The other soft-failing `entity new` steps (scope-entity-type, event codegen, bridge registry, integration emitters)
  are the same defect outside this issue's scope → #660.

### Tests

`src/__tests__/cli/regeneration-failure.test.ts`: a temp project whose target path is occupied by a directory (a
real `EISDIR`, no mocks) — `entity new` (`modules.ts` text mode, `app-config.ts` JSON mode), `subsystem install`
vendored (`subsystems.ts`; `app-config.ts` in JSON mode) and package (`subsystems-schema.ts`), `subsystem remove`
(`subsystems.ts`), `subsystem install openapi-config` (`app-config.ts`): exit `1`, `could not regenerate <file>: EISDIR
…`, JSON `{ status: 'error', file }`. Plus the positive case: vendored `subsystem install --json` writes `subsystems.ts`
and `app-config.ts`. All six fail on
the #656 commit (exit 0, warning only). `relationship new` / `junction new` call the same `regenerateBarrels` the
`entity new` case covers. The smokes prove the happy path.

## Out of scope

- A memory-backend worker loop — `memory` + embedded boots one backend after #656 but still drains nothing outside
  tests (#658).
- The jobs scaffold's second `worker_mode` default (#659).
- The other soft-failing `entity new` steps (#660).
- The vendored install's stale-config regeneration (#661).

## Found

- **`memory` has no job-draining worker (#658).** `MemoryJobOrchestrator` is direct-invocation only; `JobWorkerModule`'s
  production spawn always builds the Postgres-claiming `JobWorker` (throws without `DRIZZLE`; with it, polls `job_run`
  while the memory orchestrator writes to its in-process store). #656 removes the two-backend boot; it does not make
  `memory` + embedded drain jobs.
- **Two `worker_mode` defaults (#659).** Barrel: absent = `standalone`; jobs scaffold: absent = `embedded`.
- **More soft-fails in `entity new` (#660).**
- **Three more warn-only barrel sites** (`subsystem remove`, `relationship new`, `junction new`) and a **JSON-mode skip**
  (`subsystem install --json`, vendored, never regenerated) — fixed here, see §#655 Decision.
- **A failed `entity new` post-step leaves partial state.** Hygen has already written the entity module tree when the
  barrels are regenerated, so a barrel failure exits 1 with the new tree on disk and the barrels stale — no rollback.
  Re-running after fixing the cause converges (every step is idempotent). Recorded, not changed.
- **Vendored `subsystem install` regenerates from a stale config (#661).** The vendored path writes `subsystems.ts` /
  `app-config.ts` from the context read before its own config block was injected (the package path reloads). A fresh
  `subsystem install jobs` (vendored) emits no embedded `JobWorkerModule` and no drizzle extension until the next
  `entity new`. Stale input, not failure handling — its own issue.

## Gates

Run after the last code edit (the review commit; only this spec's table changed after them).

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass |
| `just test-all` | pass: 3501 unit tests, 0 fail; baseline unchanged; every smoke (base, subsystems both modes, relationship, junction ×4 incl. custom layout both modes — `verify-worker.ts` asserts `backend: 'drizzle'`, cross-domain ×2, capability both modes); junction snapshots 10 pass; integration-emit 56 pass; smoke-integration |
| `just test-integration` | pass (74 pass, 2 skip, 0 fail) |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** errors (#602) |
| `just test-post-publish` | pass (runtime change: `JobWorkerModuleOptions.backend` required) |
| #655 tests, pre-fix | the first 5 cases of `regeneration-failure.test.ts` all fail on the #656 commit (exit 0 + warning) |
