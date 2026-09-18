# CLI-1 — the last soft input paths and empty JSON payloads (#666, #667, #668, #669)

**Status:** Designed
**Date:** 2026-09-18
**Issues:** #668 (first commit), #669 (+ the dirty-tree `--json` fall-through from the #670 review), #666, #667
**Project:** #578
**Depends on:** JOBS-2 (#664: run-level pre-flight rejections, `stopped: 'pre-flight'`), JOBS-1 (#660: the audit that
left these paths soft), CLI-0 (#627: the rejection list and what `--continue-on-error` means)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles

## Charter invariants this PR touches

- **I1 declare once.** One rejection implementation: the run-rejection type, its grouping of error issues by file,
  its printing and its `stopped: 'pre-flight'` payload move out of `entity.ts` into `src/cli/shared/run-rejections.ts`;
  `entity new` (jobs, patterns, providers) and `orchestration gen` (patterns) all use it. `jobLoadRejections` keeps
  only what is job-specific (the stale-base detail).
- **I2 generated means regenerated.** A broken provider YAML left provider modules and the adapter / assembly files
  derived from them stale while `entity new` exited 0 (#666); an unloadable pattern file let `orchestration gen`
  rewrite the root barrel without its module (#667).
- **I7 no shims.** The observability `main-hook.ejs.t`, its `prompt.js`, the hygen invocation and every local it alone
  consumed are deleted, not left inert (#668). `entity new`'s post-step provider gate, unreachable once the
  pre-flight rejects, is deleted rather than kept "just in case".
- **I9 gates are honest.** A broken input is an exit code, printed in every mode and carried in `--json`; a JSON run
  never exits non-zero with an empty stdout (#669).

## #668 — observability install no longer appends a register-it-yourself TODO

### Before

`subsystem install observability` (vendored) ran hygen `subsystem observability`, whose only template
(`main-hook.ejs.t`) appended `// TODO: Register ObservabilityModule … ObservabilityModule.forRoot()` to
`app.module.ts`. The regenerated `<generated>/subsystems.ts` already composes `ObservabilityModule.forRoot(...)` into
`SUBSYSTEM_MODULES`; since #663 the same command's printed hint says "do not register it in app.module.ts".

### Decision

- Delete `templates/subsystem/observability/` (the template and its `prompt.js`). With no template left, the hygen
  invocation in `runObservabilityScaffold` goes too; the scaffold is the `observability:` config block alone.
- Delete `src/cli/shared/observability-scaffold-locals.ts` and its unit test: every local it resolved (`appName`,
  `appModulePath`, `bridgeMetricsEnabled`) existed only as a hygen argument. `runObservabilityScaffold` resolves the
  config path itself, as the other config-block steps do.
- `planned` lists only `codegen.config.yaml`; the success line reads `observability scaffold applied (config block)`.
- **Other scaffolds, checked.** `grep TODO templates/subsystem`: `auth/app-module-hook.ejs.t` and
  `auth-integrations/app-module-hook.ejs.t` append registration TODOs — both for hand-registered modules
  (`AuthModule`, `ConnectionsAuthModule`), which the barrel does not compose, so they are true. `jobs/main-hook.ejs.t`
  says the opposite of a register-it-yourself TODO (never hand-wire `JobWorkerModule`). No other composer-backed
  subsystem appends one.

### Tests

`subsystem-install.observability.test.ts`: dry-run plans only the config file; a real install leaves `app.module.ts`
byte-identical (asserts the absence of `ObservabilityModule` / `TODO`) and appends the config block; re-install is a
no-op; `--force-config` unchanged.

## #669 — every `entity new` early return has a JSON payload

### Before

`--all` with no entity YAML (exit 1), `--all` plus a path (exit 2) and neither (exit 2) called `printError` — a no-op
in JSON mode — so `--json` returned non-zero with empty stdout. From the #670 review: a dirty generated-output tree
without `--force` exited 1 in text mode, but under `--json` the `printWarning` was a no-op and the run fell through
and generated anyway — the check it exists for skipped, and no payload.

### Decision

- Each early return goes through one local `reportUsageError(error, code)`: `printError` in text mode (byte-identical),
  `{ command: 'entity new', status: 'error', error }` in JSON mode, the same exit code as before.
- The dirty-tree check returns 1 in both modes: text mode unchanged (the warning, exit 1); JSON mode prints
  `{ command: 'entity new', status: 'error', error: 'Uncommitted changes in N generated-output files. Pass --force to
  overwrite.' }` and writes nothing.

### Tests

`entity-new-json-errors.test.ts`, through `cli.run`: each of the three early returns in JSON mode (payload + exit code)
and one in text mode (unchanged message); a git repo with a dirty generated file: `--json` exits 1 with the payload
and the dirty file byte-identical, no barrel written; text mode exits 1 as before.

## #666 — a provider blocking issue rejects the run

### Before

`generateProviderModules` loaded and cross-validated `definitions/providers/*.yaml` in the post-step, after hygen and
the barrels. Under the default `--continue-on-error` a blocking issue printed (text mode only) and the run exited 0 with
the provider modules — and the adapter / assembly / aggregator files derived from them — left as they were. Under
`--no-continue-on-error` it exited 1, after hygen had already written every entity.

### Decision

- **Run-level, by JOBS-2's test.** A provider is not one entity's input. Its module is imported by the surface
  adapters module, its `changeSources` feed the surface aggregator's `<SURFACE>_ENTITY_SOURCES` registry, and its
  per-entity assembly modules are imported by every integrated entity's integration wiring. Skipping it yields a
  partial integration layer beside a fresh entity set — the stale-output-with-success class JOBS-0/1/2 removed. So a
  blocking issue joins `runRejections`: printed in every mode, `--json` `failed[]` + `stopped: 'pre-flight'`, exit 1
  before hygen, nothing written. `--continue-on-error` does not apply.
- **Split load/validate from emit.** `loadProviderSet(opts)` (discover → load → cross-validate, no writes) and
  `emitProviderModules(set, { outputRoot, mode, dryRun })`; `generateProviderModules` is their composition for its
  other callers. `entity new` runs `loadProviderSet` in the pre-flight (the entity-surface set and tsconfig aliases are
  computed there) and hands the same set to `emitProviderModules` in the post-step — one load, one validation.
- **One rejection per provider YAML.** The error issues are grouped by file with the shared grouping (first issue →
  message, rest → details); every provider issue carries its `path`.
- **The post-step gate goes.** The `providerErrors … && !this.continueOnError` branch and the text-mode issue printing
  are unreachable once the pre-flight rejects, and are deleted. The adapter step's gate becomes `!providerSet.skipped`.
- **Dry run.** Like every run-level rejection, the stop precedes the dry-run branch: a dry run with a broken provider
  prints the rejection and exits 1.

### Tests

`entity-run-rejections.test.ts` gains a provider block, a package-mode project with one valid entity declaring a
surface: a provider YAML naming an unknown surface, text mode (default `--continue-on-error`): exit 1, the file and
reason printed, no hygen, no provider module; JSON mode: `stopped: 'pre-flight'`, `failed[0]` names the YAML; a
schema-invalid provider YAML in JSON mode; a valid provider: exit 0, the provider module emitted (unchanged).

## #667 — an unloadable pattern file fails `orchestration gen` and is an error in the validators

### Before

`orchestration gen` printed loader errors as text-mode warnings and emitted from the partial set, rewriting
`<orchestration_src>/index.ts` without the lost module; exit 0. `entity validate` and `project inspect --kind
analyze|stats|doc` printed them as text-mode warnings and validated against the partial registry; JSON carried
nothing.

### Decision

- **`orchestration gen`**: loader errors are run rejections (`patternLoadRejections`, shared with `entity new`),
  printed with the shared printer and, in JSON mode, the shared `stopped: 'pre-flight'` payload; exit 1 before the
  validator and before writing. Dry run included.
- **The validators**: each loader error becomes an `AnalysisIssue` `{ severity: 'error', type:
  'app_pattern_load_failed', path: <abs file>, message }` (`patternLoadIssues`) added to the analysis issues, so it is
  printed with the other errors, carried in `--json` (`errors[]` for `entity validate`; `issues[]` / the error count
  for `project inspect`), and the exit code follows each command's existing error rule (1 on any error).
- **Scope note.** The issue names "`project analyze` / `validate` / `stats`"; the commands are `project inspect --kind
  analyze|stats|doc` (one code path). `project inspect --kind manifest` and `project graph` load patterns too but have
  no error-severity exit rule — whether a loader error should fail them is its own decision: filed as a follow-up.

### Tests

`pattern-load-errors.test.ts`, through `cli.run`, a project with a pattern file that throws at import:
`orchestration gen` text (exit 1, file named, a pre-existing `index.ts` byte-identical) and JSON (`stopped:
'pre-flight'`, `failed[0].file`); `entity validate --json` (exit 1, the error in `errors[]`); `project inspect --kind
analyze --json` (exit 1, the issue in `issues[]`); `--kind stats --format json` (exit 1, `issueCount.errors` counts it).

## Default output

Unchanged: no fixture carries a broken provider, pattern file or entities dir. Baseline, junction snapshots and every
smoke pass unchanged. The observability install no longer touches `app.module.ts` (not part of any baseline).

## Found

(filled at implementation)

## Gates

(filled after the last edit)
