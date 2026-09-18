# CLI-0 — three generator-hygiene defects

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-18
**Issues:** #627 (`entity new` hides why a YAML failed) · #634 (two keys for the entities directory) · #638
(clean-lite-ps bodies rendered under `clean`)
**Project:** #578
**Depends on:** RT-0 (#639)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility)

Three defects in the generator's own plumbing, found by CAP-1, NAME-0 and NAME-1. None changes generated output.

## Charter invariants this PR touches

- **I1 declare once.** One key names the entities directory, and one resolver reads it (#634). One pre-flight
  reporting path covers schema, `emits:` and `roles:` rejections (#627).
- **I7 no backwards compatibility.** `paths.entities_dir` is deleted, with no alias and no deprecation notice
  (#634). The clean-architecture stub locals, which existed only so clean-lite-ps bodies could render under `clean`,
  are deleted (#638).
- **I9 gates are honest.** A rejected YAML always says why (#627). A missing clean-lite-ps local throws instead of
  emitting nothing (#638).
- **I11 scope.** clean-lite-ps and the CLI. The `clean` pipeline is touched only where `prompt.js` stubs out
  clean-lite-ps locals for it; `just test-baseline` (which runs `clean`) is the check.

## #627: `entity new` always says why an entity was rejected

`entity new` has three pre-flights: the schema (`loadEntityFromYaml`), the EVT-7 `emits:` cross-check and the CAP-2
`roles:` cross-check. The first two printed their reasons only under `--no-continue-on-error`.

- Every pre-flight rejection goes into one list (`invalid`) with `{ file, message, details }`. It is printed in every
  mode: `printError` for the file and message, one bullet per detail. In JSON mode it is in the payload (`failed[]`
  entries carry `details`; the dry-run payload gains `invalid[]`).
- `--continue-on-error` decides only whether the run stops after the pre-flights. When it stops, JSON mode prints a
  payload too (previously `--json --no-continue-on-error` fell through and generated anyway).
  *Revision 2026-09-18 (JOBS-2, #664):* this holds for per-entity rejections only. JOBS-2 adds run-level pre-flight
  rejections — an invalid job YAML, an unloadable app-pattern file — which share this list, printing and payload but
  stop the run whatever `--continue-on-error` says; the flag decides nothing for them (`docs/specs/JOBS-2.md`).
- An entity whose `emits:` fails the cross-check is now rejected like a bad role, with the message
  `emits: validation failed` and one detail per error. It is not generated and counts as failed. Before, the default mode generated it anyway, and `prompt.js` emitted a TODO-only payload mapping for the
  unknown event. The EVT-7 comment already said "reported and skipped by default".
- A dry run exits 1 when anything was rejected, as the real run does.
- Dead code removed. The brief pointed at `entity.ts:423`, the roles block. Its `e.entity ?? '(unknown)'` and
  `if (e.entity)` fallbacks were dead: `validateRolesForGeneration` returns only issues that have an `entity`. Its
  `if (!this.continueOnError && !isJsonMode()) return 1` is replaced by the single stop after all three pre-flights.
  The `!isJsonMode()` wrappers around `printError` / `printWarning` / `printInfo` are gone too. All three are already
  no-ops in JSON mode.
- Tests (`src/__tests__/cli/entity.test.ts`): default mode with one invalid YAML prints the file and the Zod reason to
  stderr and exits 1; JSON mode carries `failed[].details`; `--json --no-continue-on-error` prints
  `stopped: 'pre-flight'` and writes nothing; an unknown `emits:` event rejects the entity with its reason. The
  existing dry-run test now expects exit 1 and asserts `invalid[]`. All five fail on the previous `entity.ts`.

## #634: one key for the entities directory — `paths.entities`

Kept `paths.entities`: it is the CLI's primary key and matches `paths.<thing>`. `paths.entities_dir` is deleted.

Readers, before → after:

| Reader | Before | After |
|---|---|---|
| `src/config/entities-dir.ts` (CLI context + hygen prompts) | `entities ?? entities_dir ?? entities/` | `entities ?? entities/` |
| `src/emitters/frontend/load-context.ts` | own default `entities_dir ?? 'entities'` | `entitiesDir` is a required argument (the CLI passes `ctx.entitiesDir`) |
| `src/cli/shared/auth-integrations-scaffold-locals.ts` | own rule `entities ?? entities_dir ?? definitions/entities/` | `entitiesDirCandidates(cwd, paths)[0]`: `paths.entities`, else `<cwd>/entities` |
| `src/config/paths.mjs` `BASE_PATHS.entitiesDir` | `entities_dir ?? 'entities'`, unread | deleted |
| `src/cli/shared/init-scaffold.ts` | wrote `entities_dir: entities` | writes `entities: entities` |

The auth-integrations resolver is filesystem-free by design (injected probes), so it takes the rule's first candidate
rather than the existence-checked `resolveEntitiesDir`. Its unconfigured default moves from `definitions/entities/`
to `entities/`, where `entity new` looks. `project init` has always configured `paths`, so scaffolded projects see
no change.

`PathsConfigSchema` loses the key. That schema is type-only: `.passthrough()`, and nothing `.parse()`s the config
at runtime. So an old config's `entities_dir` is ignored like any unknown key; it does not fail loudly. Runtime
validation of `codegen.config.yaml` is a separate pre-existing defect: **#640**.

Docs updated: README (configuration), `docs/CONSUMER-SETUP.md`, `examples/auth-integrations/README.md`, the codegen
skill, `docs/specs/CAP-3.md` (describes live prompt behaviour), and a dated note in `docs/specs/NAME-0.md`.

## #638: clean-lite-ps bodies — contain the shared render

Option 2 from the issue. Option 1 (split action directories per architecture) is moot if charter Q5 retires
`clean`.

- Each `templates/entity/new/clean-lite-ps/**/*.ejs.t` body is wrapped in one guard:
  `<%_ if (typeof clpOutputPaths !== 'undefined') { _%> … <%_ } _%>`. Under `clean` the body renders empty (the
  write was already skipped by `skip_if` / a null `to:`).
- Inside the guard every local is referenced unguarded, and the `typeof x !== 'undefined' ? x : '<fallback>'`
  defaults are gone. A missing local is a `ReferenceError`.
- `buildCleanLitePsLocals` returns the complete local set the templates render with: `{ ...baseLocals, <clean-lite-ps
  locals> }`. That is what `prompt.js` already ended up with after its `Object.assign`. It asserts that none of the
  keys it computes is `undefined` (`assertNoUndefinedLocals`; `null` is a real value). A forgotten key throws at
  the template, and an extension key set to `undefined` throws at the prompt. The assertion does not cover
  prompt-owned keys: `prompt.js` builds its locals from shorthand variables whose values across every consumer shape
  cannot be proven defined here. A prompt-owned key that is absent still throws in the template.
- The extension no longer defaults prompt-owned locals. Before, it re-exported `hasEmits`, `emitsEvents`,
  `*EventType` and seven `*Import` specifiers with `?? '@shared/…'` fallbacks. Those fallbacks were the same silent
  default, one layer up: a prompt that dropped `drizzleTokenImport` got the vendored specifier in package mode.
- The clean-architecture stub locals in `prompt.js` are deleted.
- The mode-resolved runtime import specifiers move from inline `prompt.js` code to
  `runtimeImportLocals(mode)` in `src/config/runtime-mode.mjs`, so the unit tests that render clean-lite-ps bodies
  get the same values the prompt does. Before, those tests relied on the `typeof` fallbacks.
- Tests: `withEntities(base)` (`src/__tests__/clean-lite-ps/_entity-lookup.ts`) now supplies the prompt-owned locals:
  the banner, `runtimeMode`, `runtimeImportLocals(runtimeMode)` (default `vendored`), `processedQueries` and the
  EVT-7 defaults. Ten test files that passed `{}` or a hand-built base now go through it.
  `templates/generated-banner.test.ts` asserts the guard-then-banner shape for clean-lite-ps and that a missing
  banner throws there; other generators keep their guarded banner line. The new
  `clean-lite-ps/strict-locals.test.ts` checks four things. Every body renders `''` with no locals. Every body renders
  with the full set. Deleting `clpHasFk` or `drizzleTokenImport` throws a `ReferenceError`, and an `undefined` extension
  local is rejected by name. Its grep assertion checks that `clpOutputPaths` is the only `typeof … 'undefined'` test left in
  any body.
- Generated output is unchanged. `entity new --all` over `test/smoke/fixtures` and `test/smoke/fixtures-junction`
  under clean-lite-ps, before and after this change: `diff -r` is empty (56 and 55 files).

## Found

1. **`codegen.config.yaml` is never validated at runtime.** `PathsConfigSchema` is `.passthrough()` and only used as
   a type, so a deleted key (`entities_dir`) is silently ignored rather than rejected. `src/config/paths.mjs` also
   reads three `paths.*` keys the schema does not declare (`packages`, `schema_dir`, `manifest_dir`). Filed:
   **#640**.
2. **An invalid `emits:` was generated anyway** in the default mode, and `prompt.js` emitted a TODO-only payload
   mapping. The EVT-7 comment said "reported and skipped". Fixed here (#627 section).
3. **`--json --no-continue-on-error` did not stop.** Both pre-flights returned 1 only outside JSON mode, so the JSON
   run went on to generate. Fixed here.
4. **A dry run exited 0 with rejected entities** in the default mode, while the real run exits 1. Fixed here.
5. **Auth-integrations had a third entities-directory rule**, defaulting to `definitions/entities/`. Fixed here
   (#634 section).
6. **`project init` wrote the losing key**, `paths.entities_dir: entities`. Fixed here.
7. **`BASE_PATHS.entitiesDir` was unread.** Deleted.
8. **#634's symptom did not occur through the CLI.** `entity new` already passed `ctx.entitiesDir` to
   `loadFrontendEmitContext`; only a direct caller relying on the default hit `entities_dir`. The emitter's own
   fallback is removed anyway, and the argument is now required.
9. **The extension defaulted prompt-owned locals.** This is the same class as #638. Fixed here (#638 section).
10. **The codegen skill described the pre-GATE-2 smoke filter** (`filterConsumerErrors`). Corrected to the
    location-only rule.
11. **Remaining `entities_dir` hits are dated records, left as history:** `CHANGELOG.md`, `docs/specs/GATE-1.md`,
    `docs/specs/NAME-0.md` (dated note added), `docs/specs/TEST-SESSION-1.md`, and this spec.

## Gates

Run on `af4a4f7`, after the last code edit (only this table changed after it).

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass. `bun run test` is the baseline runner, which runs the `clean` pipeline after the stub locals were deleted |
| `just test-all` | pass: 3421 unit tests, 0 fail; baseline; smoke; subsystems ×2 modes; relationship; junction ×4 legs; capability ×2 modes; junction unit; integration-emit; smoke-integration |
| `just test-integration` | pass: 74 pass, 0 fail, 2 skip. The skips are the hard-coded `test.skip` pair in `bridge-e2e.test.ts` and predate this change |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** errors (#602) |
| `just test-post-publish` | pass (tarball consumer contract + smoke from the packed artifact) |
| Before/after byte diff | `entity new --all` over `test/smoke/fixtures` and `fixtures-junction` (clean-lite-ps): `diff -r` empty |
