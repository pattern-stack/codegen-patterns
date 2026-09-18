# JOBS-0 — `jobs.backend: memory` reaches the worker (#656); generated files the app imports are never optional output (#655)

**Status:** Designed
**Date:** 2026-09-18
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
  error })` in JSON mode; returns `1`. All three call sites `return reportRegenerationFailure(…)`; the `try/catch` that
  swallowed and the "opt-in" / "warn-but-don't-fail" comments are deleted.
- **Genuinely optional output at these sites: none.** Every file the three generators write is imported by the app
  (`modules.ts` / `subsystems.ts` by `app.module.ts`, `schema.ts` / `subsystems-schema.ts` by the Drizzle schema wiring drizzle-kit and the app read,
  `app-config.ts` by `main.ts` / `worker.ts` / `subsystems.ts`, the registry / events stubs by `subsystems.ts`).
  The other soft-failing `entity new` steps (scope-entity-type, event codegen, bridge registry, integration emitters)
  are the same defect outside this issue's scope → #660.

### Tests

`entity new` and `subsystem install` (both runtime modes) against a temp project whose target file path is occupied
by a directory (a real `EISDIR`, no mocks): exit code `1`, the message names the file; JSON mode carries
`status: 'error'` + `file`. The smokes prove the happy path.

## Out of scope

- A memory-backend worker loop — `memory` + embedded boots one backend after #656 but still drains nothing outside
  tests (#658).
- The jobs scaffold's second `worker_mode` default (#659).
- The other soft-failing `entity new` steps (#660).

## Found

- **`memory` has no job-draining worker (#658).** `MemoryJobOrchestrator` is direct-invocation only; `JobWorkerModule`'s
  production spawn always builds the Postgres-claiming `JobWorker` (throws without `DRIZZLE`; with it, polls `job_run`
  while the memory orchestrator writes to its in-process store). #656 removes the two-backend boot; it does not make
  `memory` + embedded drain jobs.
- **Two `worker_mode` defaults (#659).** Barrel: absent = `standalone`; jobs scaffold: absent = `embedded`.
- **More soft-fails in `entity new` (#660).**

## Gates

_Filled after the last edit._
