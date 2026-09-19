# ARCH-0 — delete the `clean` backend architecture (#677)

**Status:** Implemented
**Date:** 2026-09-19 · **Implemented:** 2026-09-19
**Issue:** #677 (closes charter Q5; closes #602 as obsolete; resolves the rest of #638)
**Project:** #578
**Depends on:** CLI-1 (#673, the PR base), CFG-0 (#640: strict config, so a removed key is an unknown-key error naming
the key and the file), NAME-0 (#611: cross-entity names come from the target's YAML), CLI-0 (#627/#638: the single
`typeof clpOutputPaths` body guard this PR removes)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles
**Follow-up:** ARCH-1 (#682). It deletes the config surface only `clean` read.

Owner decision, 2026-09-19: delete `clean`, don't just change the default. After this PR, clean-lite-ps is the only
backend pipeline.

## Charter invariants this PR touches

- **I7 no backwards compatibility.** `generate.architecture` is removed from the schema, not kept as a one-value enum.
  Writing it is CFG-0's unknown-key error:
  `<file> is not a valid codegen.config.yaml: - generate.architecture: unknown key (expected one of: frontend, analytics)`.
  The four `clean`-only toggles get the same treatment: `generate.drizzleSchema`, `commands`, `queries` and `dtos`.
  There is no alias, no deprecation notice and no migration shim.
- **I9 honest gates.** The known-red `test-smoke-junction-clean` leg is deleted along with the pipeline it tested.
  The baseline gate used to compile only the `clean` pipeline's `domain/` files. It now generates **and
  typechecks** clean-lite-ps output. That surfaced one real defect, #680. It gets a named expectation (exact file,
  exact codes, asserted present and sole), not a filter.
- **I11 scope discipline.** Updated: "clean-lite-ps is the only backend pipeline".

## Measured before deciding

- `templates/entity/new/backend/` held 28 templates. 27 carried `skip_if: !isCleanArchitecture` (or an
  `isCleanArchitecture ? … : ''` `to:`). **One was shared:** `modules/core/integration-source.ejs.t`, the
  `detection:` change-source module. Its `to:` branched on `isCleanLitePs`, so clean-lite-ps used it too. It moved to
  `templates/entity/new/clean-lite-ps/integration-source.ejs.t`, with the clean branch and the guards stripped, and
  now reads `classNames.entity` / `entityName` rather than `className` / `name`. `electric-migration.ejs.t` looked
  shared (its `to:` has no architecture test), but its `skip_if` is `!isCleanArchitecture`, so it was clean-only.
- **The schema default was `clean`.** `init` wrote `clean-lite-ps` explicitly. A project whose config never set the
  key was generating `clean`. The CHANGELOG says so.
- Readers of `architecture`: `prompt.js` (entity), `junction/new/prompt.js` + 14 `_inject-parent-*-clp-*` templates,
  `barrel-generator.ts`, `entity.ts` / `junction.ts` / `relationship.ts` (passed to the barrel generator),
  `project.ts` (status pane, init summary), `init-scaffold.ts`, the scanner's config proposal, the frontend emitter
  (update verb `PUT` for clean, `PATCH` for clean-lite-ps), and `validatePatternProject`, whose only rule was the
  `clean` no-op warning. `relationship/new` and `broadcast/new` carry **no** architecture guard.

## Decisions

1. **`generate.architecture` is removed, not narrowed to one value.** A one-value enum is a key that does nothing. The
   issue and I7 both rule it out.
2. **The four `clean` toggles go in this PR.** They sit in the same `generate` block, their only reader was the deleted
   templates, and the schema doc already labelled them "`clean` pipeline".
3. **The rest of the clean-only config surface goes to ARCH-1 (#682), not this PR.** Measured: `naming:`,
   `locations.backend*` (14 names), `database:`, `behaviors:` + entity `behavior_strategy:`, entity
   `folder_structure:` / `file_grouping:`, and 56 `prompt.js` locals are read only by the machinery that fed the
   deleted templates (see "Left for ARCH-1"). Each is config a user writes and `init` / `scan` emit, and a couple
   (`expose:`, `database.dialect`) may deserve a clean-lite-ps reader, not deletion. Doing that here would roughly
   double the diff and mix a pipeline deletion with a config redesign. **Recommendation: take ARCH-1 next.** Until
   it lands, those keys parse and do nothing, which is the CFG-0 class, and #682 lists them.
4. **Guards.** Every guard that existed only to exclude `clean` is deleted:
   - clean-lite-ps templates: the `<%_ if (typeof clpOutputPaths !== 'undefined') { -%>` body guard (21 templates),
     every `typeof clpOutputPaths` in `to:`, and `skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"`.
     A `skip_if` stays only for a real condition: an optional output path (`!clpOutputPaths.createUseCase`, …) or
     `clpApiEnabled === false`. With the guard gone, rendering a body without clean-lite-ps locals throws. That is
     #638's "gate the render" outcome, and `strict-locals.test.ts` asserts there is no `typeof` test in any
     clean-lite-ps template.
   - junction: `architecture === 'clean-lite-ps' &&` is dropped from the 14 parent-inject `to:` lines. The
     `exposeOnParent.<side> ? … : ''` guard stays, because it is the real per-side opt-out.
   - **Kept:** `<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>` in `relationship/new`,
     `broadcast/new`, `junction/new` and the subsystem templates. It dates from #373, predates and is unrelated to
     `clean`, and every one of those prompts supplies the local. Removing it is the #638 sweep for the other
     generators, outside this issue.
5. **No hygen restructuring.** The `clean-lite-ps/` directory name, the `clpOutputPaths` / `clp*` local names and the
   `-clp-` suffix on the junction inject templates are now vestigial. Renaming them (or moving the templates up to
   `templates/entity/new/`) is mechanical, but it touches ~40 paths and every clean-lite-ps unit test, and #678 is
   editing the junction templates in parallel. **Proposed as a follow-up, pending the owner's call.** It isn't done
   here.
6. **Scanner.** The folder-layout detector keeps detecting an existing domain/application layering (it still picks
   `backend_src`), but its value is renamed `clean` → `layered`, so `project scan` no longer prints
   "architecture: clean" for something unrelated to a pipeline.
7. **The baseline gate moves to clean-lite-ps** (no new harness): see "Tests and gates".

## Changes

| Area | Change |
|---|---|
| templates | `templates/entity/new/backend/` deleted, apart from `integration-source.ejs.t`, which moved to `clean-lite-ps/`. 21 clean-lite-ps templates lose their guards. 14 junction inject templates lose `architecture ===`. |
| `templates/entity/new/prompt.js` | No `architectureTarget` / `isCleanArchitecture` / `isCleanLitePs`, no `generate.*` locals. The clean-lite-ps extension always runs. The banner seam is always "a pattern … or the entity YAML". |
| `templates/junction/new/prompt.js` | `resolveOutputPaths(name, plural, modulesDir)`, `resolveParentPaths(name, naming)`. No `namingRoot` (the `clean` `.` root) and no context-stripping for `clean`. The `architecture` / `srcRoot` locals are deleted. |
| schema | `GenerateConfigSchema` = `{ frontend, analytics }`. |
| `src/config/paths.mjs` | `getGenerateConfig` deleted (no reader). |
| `barrel-generator.ts` | `Architecture` type, `architecture` option and the clean path branch deleted. `BarrelPaths = Pick<PathsConfig, 'modules_dir'>`. |
| CLI | `entity` / `junction` / `relationship new` stop passing an architecture. The `project` status pane and `init` summary drop the line. `init` writes `generate: { frontend }` (no `architecture` / `commands` / `queries`). |
| scanner | `ProposedConfig.generate` = `{ frontend }`. The layout value is renamed `clean` → `layered`. |
| frontend emitter | `FrontendEmitConfig.architecture` deleted; `update` is always `PATCH`. The golden snapshot changes `PUT` → `PATCH` in `api/person.ts` and `api/user.ts`. |
| analyzer | `validatePatternProject`, `PatternProjectContext`, `pattern_clean_pipeline_noop` and `AnalyzeDomainOptions.architecture` deleted. |
| deps | `@nestjs/swagger@^8` is a devDependency, like the other optional peers the runtime and tests import. The baseline typecheck compiles generated controllers. |

## Tests and gates

- **Baseline (`just test-baseline`).** The entity fixtures move to `test/fixtures/entities/`, a closed set:
  `account.yaml` and `tenant.yaml` are added so every `belongs_to` / `foreign_key` target resolves from its own YAML
  (NAME-0; clean-lite-ps rejects a dangling target where `clean` silently skipped it). The fixture config drops
  `architecture` and the `clean` `locations:` block and sets `paths.entities: test/fixtures/entities`. The runner's
  output paths become `packages/api/src/modules` (+ the two runtime `generated/` dirs), the `constants/tokens.ts`
  seed (a `clean` inject anchor) is deleted, and the two-pass generation stays: clean-lite-ps has its own
  file-existence `targetExists` check. `test/tsconfig.baseline.json` compiles `packages/api/src/modules/**` with the
  same `@shared/*` → `runtime/` mapping as the scaffold. The snapshot is regenerated: 150 clean-lite-ps files replace
  the `clean` tree. The events / jobs snapshots are unchanged, because the event and scope-type generators still read
  the whole `test/fixtures/` tree.
- **Named expectation (#680).** The typecheck surfaced that clean-lite-ps ignores `via:` / `select:` on declarative
  queries. `contact.repository.ts` gets TS7053 ×2 + TS2322. `ISSUE_680_EXPECTATION` in `test/run-test.ts` asserts
  exactly those three diagnostics in exactly that file, and nothing else anywhere. It fails when #680 is fixed.
- **Junction smoke.** The `--architecture` axis is deleted from `run-smoke-junction.ts` and `test/junction/_helpers.ts`,
  and so are `test-smoke-junction-clean` and `test-smoke-junction-cross-domain-clean` in the justfile. The junction
  snapshots (`just test-junction`) are byte-identical.
- **Unit.** `strict-locals.test.ts`: a template rendered without locals **throws**, and no `typeof` test remains.
  `path-defaults.test.ts`: `generate.architecture` (both old values) and the four toggles are unknown-key errors
  naming the key and the file. `schema-v2`, `project-config`, `project`, `config-generator`, `load-context`,
  `emit-api`, `barrel-generator`, `junction-endpoint-naming`, `generated-banner`, `emits-rendering`,
  `field-type-to-zod` and the two integration-source tests drop their `clean` cases. `entity-run-rejections` asserted
  `src/domain/note/note.entity.ts`, the `clean` default path. That made its "not emitted" assertions vacuous under
  clean-lite-ps. It now asserts `src/modules/notes/note.entity.ts`.

## Found

- **#680** (filed): clean-lite-ps ignores a declarative query's `via:` / `select:`. The generated method queries a
  column the table doesn't have and returns the wrong type. No gate had ever compiled that output.
- **The shared template.** `integration-source.ejs.t` lived under `backend/` but served clean-lite-ps. Deleting the
  directory wholesale would have silently stopped emitting `<entity>-integration-source.module.ts`. The baseline
  (`opportunity.yaml` has `detection:`) now locks it.
- **The frontend `PUT`.** With the schema default `clean`, a project that never set `architecture` got a frontend
  calling `PUT` against a backend that (under clean-lite-ps) serves `PATCH`. This is gone with the branch.
- **`expose:` is read by the frontend emitter** (`load-context.ts`), not only by the dead `prompt.js` locals. ARCH-1
  must not delete it as clean-only. Recorded on #682.

## Left for ARCH-1 (#682)

`prompt.js` locals that no clean-lite-ps template or `prompt-extension.js` reads (grep, after the move above):
`applicationLayerSuffix backendLayers basePaths behaviorFields behaviorStrategy belongsToRelations classNamePlural
createCommandClass databaseDialect deleteCommandClass detectionProviders drizzleImports electricWhereColumn
electricWhereValue emitsEvents entityRefFields enumFields existingBelongsTo existingHasOne existingRelationships expose
exposeElectric exposeRepository exposeRest exposeTrpc fileGrouping fileNames folderStructure getByIdQueryClass
hasBehaviors hasBelongsTo hasEntityRefFields hasEvents hasExistingRelationships hasHasMany hasHasOne
hasIntegrationBlock hasIntegrationProviders hasQueries hasRelationships hasTemporalValidity integrationElectric
integrationProviders isGrouped isNested layout listQueryClass locations namingConfig optionalFields processedEvents
queryLayerSuffix repositoryBehaviorConfig repositoryToken requiredFields updateCommandClass`. That is 56 of 85, and the
list undercounts: `paths`, `imports` and `outputPaths` are common words the grep can't separate. Behind them are
`paths.mjs` (`BACKEND_LAYERS`, `getImportPaths`, `getEntityPaths`, `getEntityFileNames`, `getLayoutConfig`,
`computeFileName*`, `FILE_NAMING`, `getDatabaseDialect`), `naming-config.mjs`, and the config keys listed in #682.

## What downstream must know

- **#678 (junction regeneration fix, stacked on this).** Junction changes in this PR:
  - `templates/junction/new/prompt.js`: `resolveOutputPaths(name, plural, modulesDir)` (was
    `(name, plural, architecture, srcRoot, modulesDir)`, with a clean branch). `resolveParentPaths(name, naming)` (was
    `(name, naming, architecture, srcRoot)`). `namingRoot` is gone: endpoint naming is `entityModuleNaming(block,
    modulesDir)` and `junctionModuleDir = ${modulesDir}/${entityNamePlural}`. The `architecture` and `srcRoot` locals
    are **no longer passed to the templates**. The prompt reads `config_.paths.modules_dir` only (not `backend_src`
    or `generate`).
  - The 14 `templates/junction/new/_inject-parent-{module,module-forwardref,module-import,service,service-counterparty,service-forwardref,service-import}-clp-{left,right}.ejs.t`:
    only the `to:` line changed, from `architecture === 'clean-lite-ps' && exposeOnParent.<side> ? … : ''` to
    `exposeOnParent.<side> ? … : ''`. Bodies, `inject` / `before` / `after` / `skip_if` markers and file names are
    unchanged (the `-clp-` suffix stays; see decision 5).
  - No other junction template changed. The junction snapshots are byte-identical.
- **Everyone:** `configOrDefaults(config).generate` is `{ frontend, analytics }`. `regenerateBarrels` takes no
  `architecture`. `entityFilePaths(info, { modules_dir })`. `analyzeDomain` options take no `architecture`.
- **Templates:** a clean-lite-ps template must not contain a `typeof` test (grep-asserted). A new optional output uses
  a real `skip_if` condition.
- **Baseline:** a new entity fixture goes in `test/fixtures/entities/`, and every target it references must have a YAML
  there. Regenerate with `bun test/run-test.ts generate && bun test/run-test.ts baseline`.
