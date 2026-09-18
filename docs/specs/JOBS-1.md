# JOBS-1 — one `worker_mode` default (#659), the install regenerates from the config it wrote (#661), every `entity new` post-step fails loud (#660)

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issues:** #659 (first commit), #661, #660
**Project:** #578
**Depends on:** JOBS-0 (#655 / #656 — `GeneratedFileError`, `generating`, `reportRegenerationFailure`; the
`memory` + standalone refinement)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles

## Charter invariants this PR touches

- **I1 declare once.** #659: `jobs.worker_mode` had two defaults (barrel: absent = `standalone`; jobs scaffold:
  absent = `embedded`), plus a third in the jobs `prompt.js`. One `.default(...)` in `JobsConfigSchema` now.
- **I2 generated means regenerated.** #661: a fresh vendored install wrote `subsystems.ts` / `app-config.ts` from the
  config read *before* it injected its own block. #660: a failed post-step left a stale or missing module the app
  imports while the command exited 0.
- **I7 no shims.** `DEFAULT_JOBS_WORKER_MODE`, `normaliseWorkerMode`, the scaffold's unread `workerMode` local and the
  "warn-but-don't-fail" post-step wrappers are deleted, not kept behind a flag.
- **I9 gates are honest.** A post-step failure is an exit code, not a warning.

## #659 — `jobs.worker_mode` has one default: `embedded`

### Today (before)

- `subsystem-barrel-generator.ts` (jobs composer): `cfg.worker_mode ?? DEFAULT_JOBS_WORKER_MODE` (`'standalone'`) —
  absent means no `JobWorkerModule` in `SUBSYSTEM_MODULES`.
- `jobs-scaffold-locals.ts` › `normaliseWorkerMode`: absent (or any non-`standalone` value) means `'embedded'`;
  `templates/subsystem/jobs/prompt.js` restated the same coercion.
- `templates/subsystem/jobs-config/` writes `worker_mode: embedded` on every fresh install.
- The JOBS-0 refinement rejected `backend: memory` with the *effective* mode `standalone`, absent included.

### Decision

**`JobsConfigSchema.worker_mode` is `z.enum(['embedded', 'standalone']).default('embedded')`.** Chosen by what a
fresh install does: the jobs-config injector writes `worker_mode: embedded`, so a hand-written block that omits the
key most plausibly expects the topology `subsystem install jobs` would have given it. `standalone` is an operational
choice (a second deployable) that should be stated.

- The jobs composer reads the parsed value: `JobsConfigSchema.parse(cfg ?? {}).worker_mode`. Parsing inside the
  composer (not trusting a caller-supplied object) means an absent `jobs:` block — a vendored project whose jobs tree
  is on disk but whose config has no block — gets the same schema default, and the pure builder's direct callers
  (unit tests) agree with the CLI. `DEFAULT_JOBS_WORKER_MODE` is deleted.
- **The scaffold has no worker mode at all.** No jobs template reads `workerMode` (`worker.ejs.t` and
  `main-hook.ejs.t` are emitted for both topologies; the composition is the barrel's). The local, `normaliseWorkerMode`,
  the `--workerMode` argv pair and the `prompt.js` coercion are deleted rather than repointed at the schema (I7).
- **The `memory` refinement under the new default:** it now reads `jobs.worker_mode` directly (always set after
  parsing). `backend: memory` with no `worker_mode` parses — it is `embedded`, the one topology `memory` supports — so
  no config that used to parse starts failing; the one that used to fail (`memory` + absent) now parses. The message
  loses its `, the default` branch (unreachable).

**Changed output:** a `jobs:` block without `worker_mode` now composes `JobWorkerModule.forRoot({ mode: 'embedded',
… })`. No baseline, junction, smoke or integration fixture has such a block (the junction helper and the subsystems
smoke both state `standalone`; the scaffold states `embedded`), so no snapshot changed.

### Tests

- Barrel: an absent key (`jobs: { backend: 'drizzle' }` and no `jobs:` block at all) produces byte-identical output to
  the value the jobs-config template writes (read from the template file), and that output contains the embedded
  worker — the barrel and the scaffold agree.
- Schema: `memory` + absent parses and is `embedded`; `memory` + `standalone` still fails naming both keys.
- The scaffold-locals `worker_mode` test is deleted with the local.

## #661 — `subsystem install` regenerates from the config it just wrote

### Today (before)

The vendored branch of `SubsystemInstallCommand.execute` ran the scaffolds (which inject the config block) and then
called `regenerateSubsystemBarrel({ ctx })` with the `ctx` loaded at the top of `execute` — before the injection. The
package path (`executePackageMode`) reloaded (`loadContext(...)`) before regenerating. Repro: a fresh vendored
`subsystem install jobs` composed `JobsDomainModule.forRoot({ backend: 'drizzle', multiTenant: false, pools })` — no
`extensions` (and, before #659, no embedded worker) — until the next `entity new`.

### Decision

One `private loadInstallContext()` on `SubsystemInstallCommand` is both the initial load and the post-write reload;
both install paths call it after writing `codegen.config.yaml` and regenerate from the result. The runtime-mode branch
is otherwise unchanged: what genuinely differs (vendoring + per-subsystem scaffolds vs `subsystems.install` + the
package config-block action + the schema barrel) is not shared, only the reload is. The vendored reload sits outside
the regeneration `try` so an invalid injected block surfaces as the config error it is, not as a `GeneratedFileError`
with no file.

The scaffold locals still come from the pre-injection config (`runJobsScaffold(ctx.cwd, ctx.config, …)`); that is
correct — on a fresh install the block is absent and the scaffold writes it; with #659 no scaffold local depends on
`worker_mode`.

### Tests

- `regeneration-failure.test.ts` › *subsystem install regenerates from the config block it just wrote*: in-process
  `subsystem install jobs --force` for `vendored` and `package` — `subsystems.ts` carries
  `JobsDomainModule.forRoot({ backend: 'drizzle', extensions: { drizzle: { pollIntervalMs: 1000 } }, pools: jobPools })`
  and the embedded `JobWorkerModule.forRoot({ …, domainModuleExtensions: … })`; `app-config.ts`'s `jobWorkerOptions`
  carries `backend: 'drizzle'` + the same extension. The vendored case fails on the #659 commit.
- The subsystems smoke (vendored leg) asserts the same three things right after `subsystem install jobs`, on a real
  scaffolded project, before any further command.

## #660 — every `entity new` post-step fails the command

### Audit

Every step after the barrels, what it writes, who imports it:

| Step | Writes | Imported by | Verdict |
|---|---|---|---|
| `generateScopeEntityType` | `ScopeEntityType` union (`<generated>/scope-entity-type.ts` / vendored `jobs/generated/`) | job handlers (`scope: { entity: … satisfies ScopeEntityType }`) | fail |
| `generateEventCodegen` | `types` / `schemas` / `registry` / `bus` / `index` (`<generated>/events/` / vendored `events/generated/`) | `subsystems.ts` (package), the events module (vendored), typed publishers | fail — **including error-severity issues**: they make the generator write nothing |
| `generateBridgeRegistry` | `bridge-registry.ts` / vendored `bridge/generated/registry.ts` | `subsystems.ts` (package), `BridgeModule` (vendored) | fail — including trigger validation (duplicate / unknown / audit-tier) |
| `generateOrchestrationModules` | `<orchestration_src>/<slug>/*` + root barrel | the app's orchestration wiring | fail |
| `emitFrontendSet` | the frontend tree | the frontend app | fail |
| `generateProviderModules` | `<slug>.provider.module.ts` | surface / assembly modules | fail |
| `emitAdapters` | adapter scaffolds, surface modules, typed views, assemblies, tokens, sinks, change emitters | the app's integration modules | fail |
| `emitJobHandlers` | `@generated` handler bases + emit-once subclasses | the app's jobs module | fail |

**Genuinely optional output: none.** What stays soft is not a failure: declared skips (bridge not installed; no
entities for the frontend; a provider surface with no registered port package; an assembly skipped with a reason) keep
printing info / warnings. The provider step's blocking *issues* already exit 1 (unless `--continue-on-error`) and are
unchanged.

### Decision

- **The error is named where the file is known.** Each emitter's write helper wraps its own write in
  `generating(outPath, …)`: `emit-utils.ts` › `writeFile` (frontend), `provider-module-generator.ts` › `writeIfChanged`,
  `adapter-emission-generator.ts` › `writeFile`, `emit-jobs.ts` › `writeFresh` (which `writeIfChanged` now calls), and
  the direct writes in the scope / event / bridge / orchestration generators.
- **Each CLI step is wrapped in `generating(<step output root>, …)`** — the scope file, the event output dir, the
  bridge output dir, the orchestration root, `paths.frontend_src`, `<backend_src>/integrations/providers`,
  `<backend_src>/integrations`, the job handlers dir — so a failure before any write (a YAML that does not load, a
  rejected trigger, an event-codegen error issue) names the step's output. A nested `GeneratedFileError` passes through,
  so a write failure names the innermost file.
- Every step `return reportRegenerationFailure('entity new', err)` — exit 1, `printError` in text mode, `{ command,
  status: 'error', file, error }` in JSON mode.
- **`generating` handles async steps** (a returned promise's rejection is rethrown as the named error); four of the
  steps are async.
- **`GeneratedFileError` + `generating` move to `src/utils/generated-file.ts`.** The frontend emitter
  (`src/emitters/`) must not import the CLI UI layer; `src/cli/shared/generated-file.ts` keeps only
  `reportRegenerationFailure`. Every importer is repointed; no re-export (I7).
- `loadOrchestrationPatterns` loses its `catch { return [] }`: a throw emptied the pattern set, so the orchestration
  step wrote nothing and reported success. Per-file pattern import errors are the loader's (collected, printed once at
  startup by `loadAppPatternsForCli`) and unchanged.
- The JSON result's `scopeEntityType`, `eventCodegen`, `bridgeRegistry` and `orchestration` are never `null` now (a
  failed step returns before the summary); the `? … : null` branches are deleted.
- **Dry-run is unchanged.** The dry-run *plan* writes nothing; its orchestration-plan warning stays.

### Partial state

A post-step failure exits 1 with everything written before it still on disk: hygen's per-entity trees, the barrels,
and the earlier post-steps' output. No rollback (not trivial: hygen writes through its own process, and each step is a
whole-set regeneration). Every step is idempotent, so fixing the cause and re-running converges — the same position
JOBS-0 recorded for the barrels.

### Tests

- `regeneration-failure.test.ts` › *entity new fails when a post-step …* (CLI, in-process, real `EISDIR` / real
  invalid input): scope-entity-type (text), event codegen blocked file (JSON: `status`, `file`, `error`), event codegen
  error-severity issue (names the events output dir, nothing written), bridge registry duplicate trigger (names the
  output dir, `DuplicateTriggerError`). All four fail on the #661 commit (warning, exit 0).
- `emitter-write-failure.test.ts`: `generating` (sync throw, async rejection, nested pass-through); job handler base,
  orchestration per-pattern file, frontend writer, provider module, adapter surface module — each a
  `GeneratedFileError` naming exactly the blocked file.

## Out of scope

- The generic `Register <Name>Module.forRoot(...)` install hint names a module that does not exist and invites a
  second registration next to the barrel's → #663.
- An error-severity `definitions/jobs/*.yaml` issue is still printed and skipped → #664.
- `memory` has no job-draining worker (#658).

## Found

- **A third `worker_mode` default** — `templates/subsystem/jobs/prompt.js` coerced `--workerMode` the same way as
  `normaliseWorkerMode`, for a local no template reads. Deleted with it (#659).
- **Event codegen error issues were a silent stale path** — `generateEventCodegen` writes nothing when any issue is an
  error; the CLI printed the issues (text mode only) and exited 0. Folded into #660.
- **`loadOrchestrationPatterns` swallowed a throw into an empty pattern set** — folded into #660.
- **The vendored install hint** (`Register JobsModule.forRoot({ backend: 'drizzle' }) in your app.module.ts`) — #663.
- **Invalid job definitions are skipped with exit 0** — #664.
- **Provider blocking issues are silent in JSON mode** (`return 1` with no payload) — noted, not changed: the command
  already fails.

## Gates

Run after the last code edit.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass |
| `just test-all` | pass: 3513 unit, 0 fail; baseline unchanged; every smoke (base, subsystems both modes — vendored leg asserts the #661 post-install barrel + `jobWorkerOptions`; relationship; junction ×4; cross-domain ×2; capability both modes); junction snapshots 10 pass; integration-emit 56 pass; smoke-integration |
| `just test-integration` | pass (74 pass, 2 skip, 0 fail) |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** errors (#602) |
| `just test-post-publish` | pass (shipped CLI / template changes) |
| New tests, pre-fix | #661 vendored case fails on the #659 commit; the four #660 CLI cases fail on the #661 commit (warning, exit 0) |
