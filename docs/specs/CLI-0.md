# CLI-0 — three generator-hygiene defects

**Status:** Designed
**Date:** 2026-09-17
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

- Every pre-flight rejection goes into one `rejected` list with `{ file, message, details }`. It is printed in every
  mode: `printError` for the file and message, one bullet per detail. In JSON mode it is in the payload (`failed[]`
  entries carry `details`; the dry-run payload gains `invalid[]`).
- `--continue-on-error` decides only whether the run stops after the pre-flights. When it stops, JSON mode prints a
  payload too (previously `--json --no-continue-on-error` fell through and generated anyway).
- An entity whose `emits:` fails the cross-check is now rejected like a bad role: it is not generated and counts as
  failed. Before, the default mode generated it anyway, and `prompt.js` emitted a TODO-only payload mapping for the
  unknown event. The EVT-7 comment already said "reported and skipped by default".
- A dry run exits 1 when anything was rejected, as the real run does.
- Dead code removed: the roles block's `e.entity ?? '(unknown)'` and `if (e.entity)` fallbacks
  (`validateRolesForGeneration` returns only issues with an `entity`), and the `!isJsonMode()` wrappers around
  `printError` / `printWarning` (both are already no-ops in JSON mode).

## #634: one key for the entities directory — `paths.entities`

Kept `paths.entities`: it is the CLI's primary key and matches `paths.<thing>`. `paths.entities_dir` is deleted.

Readers, before → after:

| Reader | Before | After |
|---|---|---|
| `src/config/entities-dir.ts` (CLI context + hygen prompts) | `entities ?? entities_dir ?? entities/` | `entities ?? entities/` |
| `src/emitters/frontend/load-context.ts` | own default `entities_dir ?? 'entities'` | `entitiesDir` is a required argument (the CLI passes `ctx.entitiesDir`) |
| `src/cli/shared/auth-integrations-scaffold-locals.ts` | own rule `entities ?? entities_dir ?? definitions/entities/` | the resolver |
| `src/config/paths.mjs` `BASE_PATHS.entitiesDir` | `entities_dir ?? 'entities'`, unread | deleted |
| `src/cli/shared/init-scaffold.ts` | wrote `entities_dir: entities` | writes `entities: entities` |

`PathsConfigSchema` loses the key. That schema is type-only: `.passthrough()`, and nothing `.parse()`s the config
at runtime. So an old config's `entities_dir` is ignored like any unknown key; it does not fail loudly. Runtime
validation of `codegen.config.yaml` is a separate pre-existing defect (filed; see Found).

## #638: clean-lite-ps bodies — contain the shared render

Option 2 from the issue. Option 1 (split action directories per architecture) is moot if charter Q5 retires
`clean`.

- Each `templates/entity/new/clean-lite-ps/**/*.ejs.t` body is wrapped in one guard:
  `<%_ if (typeof clpOutputPaths !== 'undefined') { _%> … <%_ } _%>`. Under `clean` the body renders empty (the
  write was already skipped by `skip_if` / a null `to:`).
- Inside the guard every local is referenced unguarded, and the `typeof x !== 'undefined' ? x : '<fallback>'`
  defaults are gone. A missing local is a `ReferenceError`.
- `buildCleanLitePsLocals` asserts that none of the keys it returns is `undefined`. A forgotten key throws at the
  template; a key set to `undefined` throws at the prompt.
- The clean-architecture stub locals in `prompt.js` are deleted.
- The mode-resolved runtime import specifiers move from inline `prompt.js` code to
  `runtimeImportLocals(mode)` in `src/config/runtime-mode.mjs`, so the unit tests that render clean-lite-ps bodies
  get the same values the prompt does. Before, those tests relied on the `typeof` fallbacks.

## Found

(filled in at implementation)

## Gates

(filled in after the last edit)
