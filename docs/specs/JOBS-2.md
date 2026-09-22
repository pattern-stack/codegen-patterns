# JOBS-2 — an invalid job definition or an unloadable app-pattern file fails `entity new` (#664), the install hint says what is true (#663)

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issues:** #663 (first commit), #664 (+ the pattern-file row of the JOBS-1 audit)
**Project:** #578
**Depends on:** JOBS-1 (#660: every post-step fails loud; the audit that left these two input paths soft), CLI-0
(#627: the pre-flight rejection list and what `--continue-on-error` means)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles

## Charter invariants this PR touches

- **I2 generated means regenerated.** An invalid job YAML left its `<type>.job.generated.ts` while the event / bridge
  registries dropped its schedule and triggers; an unloadable pattern file let the orchestration barrel be rewritten
  without its module. Both exited 0.
- **I7 no shims.** `capitalize(desc.name) + 'Module'` is deleted, not kept as a fallback.
- **I9 gates are honest.** A broken input is an exit code, printed in every mode and carried in `--json`.

## #663 — the install hint says what is true about `AppModule`

### Before

The vendored install's generic hint printed `Register <Capitalized>Module.forRoot({ backend })` for events / jobs /
bridge / integration (and cache / storage). There is no `JobsModule`, and the regenerated `<generated>/subsystems.ts`
already composes those four into `SUBSYSTEM_MODULES`, so following the hint registered a second `forRoot`.
Observability had its own branch with the same defect (`Register ObservabilityModule.forRoot() AFTER …` — the barrel
composes it, last). `subsystem remove` synthesised the same name (`Remove the JobsModule.forRoot(...) registration`).
Package mode printed no module hint at all, which was right for the composed five and silent for cache / storage /
auth.

### Decision

- **The composed set is read from the barrel, not restated.** `composesSubsystem(name)`
  (`subsystem-barrel-generator.ts`) is `COMPOSERS[name] !== undefined`: events, jobs, bridge, integration,
  observability. A unit test pins that set against `SUBSYSTEMS`.
- **Composed →** `<name> is composed into SUBSYSTEM_MODULES by the regenerated <generated>/subsystems.ts (spread once
  into AppModule) and configured by its \`<name>:\` block in codegen.config.yaml — do not register it in
  app.module.ts.` Observability's special branch is deleted; the barrel owns its ordering.
- **Not composed →** the module the runtime exports, with its real `forRoot` shape, from one table
  (`HAND_REGISTERED`): `CacheModule.forRoot({ backend })`, `StorageModule.forRoot({ backend })`,
  `AuthModule.forRoot({ encryptionKey, oauthStateStore, enableController, redirectUriBase })`. A name in neither
  throws — nothing is synthesised. `openapi-config` and `auth-integrations` are in neither on purpose: install and
  remove short-circuit both before any hint, so a table entry for them would be dead (a test pins the table's keys to
  exactly the non-composed, non-short-circuited subsystems).
- **Where it prints.** Vendored: the generic branch (auth keeps its next-steps block). Package: after the
  `SUBSYSTEM_MODULES` wire-once line, for every subsystem — which gives cache / storage / auth the registration hint
  package mode never printed. `subsystem remove`: step 1 names the hand-registered module, or says there is nothing
  to remove for a composed one; steps are numbered from what applies.

### Tests

`subsystem-install-hint.test.ts`: the composed set equals the composers; the hint text per composed subsystem; cache /
storage / auth; the throw; in-process vendored `install jobs` (no `JobsModule`), vendored `install cache`, package
`install events`, package `install storage`, vendored `remove jobs`. `subsystem-install.observability.test.ts` asserts
the composed hint instead of the old one. The `HAND_REGISTERED` keys equal the non-composed subsystems minus the two
short-circuited ones.

## #664 — an invalid job YAML or an unloadable app-pattern file rejects the run

### Before

- `loadJobs(jobsDir)` ran after the pre-flight; error-severity issues were `printError`ed outside JSON mode only and
  the run continued: the job contributed no scheduled events, no bridge triggers and no handler base; exit 0. A
  previously valid job left its `<jobs>/<type>.job.generated.ts` on disk while the regenerated registries no longer
  carried it.
- `loadAppPatternsForCli` errors were `printWarning`ed; the pattern set was partial and `generateOrchestrationModules`
  rewrote `<orchestration_src>/index.ts` without the lost module; exit 0 (JOBS-1 audit row).

### Decision

- **Both are run-level pre-flight rejections.** A new `runRejections` list sits beside CLI-0's per-entity `invalid`
  list. Both are printed together (`printError` `<basename> — <message>`, one bullet per detail — every mode; JSON
  mode prints nothing on stderr and carries them), and `entity new` stops when `runRejections` is non-empty **or**
  (`invalid` is non-empty and `--no-continue-on-error`). The stop's JSON payload is CLI-0's: `stopped: 'pre-flight'`,
  `failed[]` = entity rejections then run rejections, same `{ name, file, message, details }` entry.
- **`--continue-on-error` does not apply to them.** It decides whether a rejected *entity* stops the run; a job YAML or
  pattern file is not one entity's problem. A job's handler base, scheduled events and bridge triggers land in the
  event registry, the bridge registry and the jobs dir that every entity's module graph imports; an app pattern is
  resolved by name by every entity's hygen prompt and by the orchestration barrel. Skipping them yields a partial
  whole-set regeneration — exactly the stale-output-with-success class JOBS-0/1 removed. So the run stops before hygen,
  whatever the flag says, and writes nothing.
- **What counts as a pattern rejection: every loader error.** Not only an import failure — an invalid contribution, a
  duplicate name and a library-name reuse also leave the pattern unregistered, so the set is partial the same way.
  `loadAppPatterns`' `errors` become `AppPatternLoadError { file, message }` (the file relative to `cwd`, or the glob
  when expansion failed); the rejection is `{ file: <abs>, message: 'app pattern file could not be loaded', details:
  [<loader message>] }`. Every other caller prints `.message` as before; `orchestration validate --json`'s
  `loaderErrors[]` entries are now objects (no compat shim — I7).
- **One job rejection per YAML.** `jobLoadRejections(issues, jobsHandlersDir)` (`emit-jobs.ts`) groups the
  error-severity issues by path: the first is the message (`Validation failed for …`, `Job file 'x' must contain …`,
  `Duplicate job type …`), the rest are details (the Zod issues). An issue with no path (the type allows it; `loadJobs`
  always sets one for errors today) groups under `file: null` — no stale base is derived, the JSON entry's `name` /
  `file` are `null`, and text mode prints the message alone.
- **A stale base is left and named — no rollback.** If `<jobsHandlersDir>/<yaml basename>.job.generated.ts` exists, the
  rejection's details carry `<path> is stale: emitted from this job's last valid definition, it is left on disk until
  the YAML loads again`. Deleting it would be the command acting on a broken input (the author may be mid-edit; the
  emit-once subclass beside it is theirs and imports it); the run already stops before anything is regenerated, so the
  project is exactly as the last successful run left it — JOBS-1's partial-state rule, with nothing partial.
- **`loadJobs` moves into the pre-flight** (it had to run before the stop); its result feeds the event / bridge / emit
  steps unchanged. `loadOrchestrationPatterns` keeps reloading for the orchestration step; its comment now says a
  loader error has already stopped the run.
- **Dry-run.** The stop precedes the dry-run branch, as CLI-0's `--no-continue-on-error` stop does: a dry run with a
  run rejection prints the rejection (JSON: the `stopped: 'pre-flight'` payload, not the plan) and exits 1 — the exit
  code the real run would give.

### Tests

`entity-run-rejections.test.ts`, in-process through `cli.run`, a package-mode project with one valid entity:

- invalid job YAML, text mode (default `--continue-on-error`): exit 1, `broken_poll.yaml — …` and the Zod reason
  printed, no hygen, no barrel, no handler base for the valid job beside it;
- filename/type mismatch, JSON mode: `stopped: 'pre-flight'`, `failed[0]` names the YAML with the loader message;
- an existing `note_poll.job.generated.ts` whose YAML is now invalid: named as stale in `details`, byte-identical after;
- a valid job: exit 0, the base emitted and the `note` entity generated (unchanged behaviour); every rejection case
  asserts that entity file is absent — hygen never ran;
- a `*.pattern.ts` that throws at import, text mode: exit 1, the file and the import error printed, a pre-existing
  `src/orchestration/index.ts` byte-identical, no barrel; JSON mode: `failed[0]` names the file.

The five rejection cases fail on the #663 commit (exit 0 / warning); the valid-job case passes on both.
`emit-jobs.test.ts`: a path-less issue yields `{ file: null, message, details }` and no stale base.

## Default output

Unchanged: no fixture carries an invalid job YAML or a broken pattern file. Baseline, junction snapshots and every
smoke pass unchanged.

## Found

- **The jobs skills said "there is no jobs-as-YAML codegen"** — both the repo and consumer `jobs` skills; RFC-0005's
  job definition kind (`definitions/jobs/*.yaml` → `emit-jobs.ts`) has shipped. Corrected in both, with the #664
  behaviour. RFC-0005's status line still said the emitter was pending — dated revision note added.
- **CONSUMER-SETUP said to wire every subsystem in `app.module.ts`** — corrected with #663: the five composed ones come
  through `SUBSYSTEM_MODULES`.
- **Provider blocking issues are still soft under the default `--continue-on-error`** (JOBS-1 audit) — the same
  question as #664, out of this scope: **#666**.
- **`orchestration gen` emits from a partial pattern set** on loader errors (text-mode warning, exit 0), and the
  validators (`entity validate`, `project analyze` / `validate` / `stats`) print loader errors in text mode only:
  **#667**.
- **This PR introduces a contradiction for observability, fixed next by #668.** The printed install hint now says
  observability is composed through `SUBSYSTEM_MODULES` — "do not register it in app.module.ts" — while the vendored
  scaffold still appends the opposite to `app.module.ts` (`templates/subsystem/observability/main-hook.ejs.t:8`,
  described in `prompt.js:18`: `TODO: Register ObservabilityModule … ObservabilityModule.forRoot()`). The TODO was
  already wrong (the barrel composes it); after #663 the two outputs of one command disagree. Deliberately not fixed
  here: **#668**.
- **`entity new --json` with no entity YAML returns 1 with no payload** (JOBS-1 Found, noted for this sweep): **#669**.
- **A dirty generated-output tree without `--force`** (`entity.ts`, the git-safety check after the pre-flight) exits 1
  in text mode, but under `--json` it only warns (a no-op in JSON mode) and falls through to generate — no payload,
  and the check it exists for is skipped. Handed to **CLI-1** (the next task), not fixed here.
- **CLI-0's "`--continue-on-error` decides only whether the run stops"** no longer holds for run-level rejections —
  dated revision note added to `docs/specs/CLI-0.md`.

## Gates

Run after the last code edit.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass |
| `just test-all` | pass: 3536 unit, 0 fail; baseline unchanged; every smoke (base, subsystems both modes, relationship, junction ×4, cross-domain ×2, capability both modes); junction snapshots 10 pass; integration-emit 56 pass; smoke-integration |
| `just test-integration` | pass (74 pass, 2 skip, 0 fail) |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** errors (#602) |
| `just test-post-publish` | pass (shipped CLI / template change) |
| New tests, pre-fix | #664: the five rejection cases fail on the #663 commit; #663: the hint tests fail on the JOBS-1 tip |
