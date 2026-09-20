# ARCH-1 — delete the clean-only config surface (#682)

**Status:** Implemented
**Date:** 2026-09-20 · **Implemented:** 2026-09-20
**Issue:** #682 (follow-up to ARCH-0, #677)
**Project:** #578
**PR base:** `dugshub/688-review-followups` (#692)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles

ARCH-0 deleted the `clean` pipeline. The config and YAML surface that existed **only** to feed its templates
survived: accepted by the schema, resolved into `prompt.js` locals, and then read by nothing. That is the
silent-config class CFG-0 exists to prevent. ARCH-1 deletes it.

## Charter invariants this PR touches

- **I7 no backwards compatibility.** Every key is removed from the schema, not accepted-and-ignored and not aliased.
  Writing one is CFG-0's unknown-key error, naming the key and the file.
- **I1 declare once.** The EVT-7 `emits:` payload mapping used to ask a second field pass (`prompt.js`'s own
  `processedFields`) which keys exist on the entity and on `CreateXDto`. It now asks the clean-lite-ps locals the
  entity and its DTOs are emitted from.
- **I9 honest gates.** The baseline snapshot is byte-identical: this PR deletes inputs nothing read, so no generated
  file changes.

## How each key was measured

For every key: grep its readers across `src/`, `templates/`, `runtime/` and `test/`, then follow each reader to a
template that consumes the local it feeds. A key is dead when every path ends in a `prompt.js` local that no
clean-lite-ps template and no `prompt-extension.js` reads.

The locals themselves were measured mechanically: extract the top-level keys of `prompt.js`'s `locals` object (85),
extract the keys `buildCleanLitePsLocals` returns (68, which are spread **over** the base locals and win on
collision), and grep each remaining name across every `templates/entity/new/clean-lite-ps/**/*.ejs.t` and the
extension. Names that matched only inside a comment, or only as a property of another object (`field.camelName`,
`rel.name`, a NestJS `imports:` key), were checked by hand and are not reads.

**Result: 69 of 85 locals are dead.** 16 survive: four the extension reads off the base
(`modulesDir`, `runtimeMode`, `entityLookup`, `junctions`), seven the templates read
(`generatedBanner`, `hasDetection`, `detectionConfigsLiteral`, `hasEmits`, `createEventType`, `updateEventType`,
`deleteEventType`) and the five `runtimeImportSpecifiers` entries.

## Key → evidence → outcome

| Surface | Measured readers | Outcome |
|---|---|---|
| **`naming:`** (`fileCase`, `suffixStyle`, `entityInclusion`, `terminology`, per-layer) | `naming-config.mjs` → `paths.mjs` (`computeFileName*`, `FILE_NAMING`, `getEntityFileNames`) → `prompt.js` `fileNames` / `namingConfig` / `applicationLayerSuffix` / `queryLayerSuffix` / the four `*CommandClass` + `*QueryClass` locals. Every one dead. clean-lite-ps file names are fixed (`<entity>.repository.ts`, …) and built by the extension. | **Deleted**, with `src/schema/naming-config.schema.ts`, `.mjs`, `src/config/naming-config.mjs` and their unit test. |
| **`locations.backend*`** (14 names) | `paths.mjs` `BACKEND_LAYERS` / `getBackendPath` / `getImportPaths` / `getEntityPaths` → `prompt.js` `paths` / `imports` / `outputPaths` / `backendLayers` / `basePaths.…`. All dead. | **Deleted.** |
| **`locations.dbSchemaServer` / `dbSchemaClient` / `dbMigrations` / `dbContextEngine`** | No reader at all — only the `DEFAULT_LOCATIONS` table itself. | **Deleted** (scope addition beyond #682's list; measured by the same sweep, and leaving them would leave four accepted-and-ignored keys behind in a block whose other three are live). |
| **`locations.dbEntities` / `frontendGenerated` / `frontendCollectionsAuth`** | `src/emitters/frontend/load-context.ts`, which resolves them from the raw config against its own defaults. | **Kept** — the whole `locations:` block is now exactly these three. |
| **`database:`** (`dialect`) | `paths.mjs` `getDatabaseDialect` / `DATABASE_CONFIG` → `prompt.js` `databaseDialect`. Dead. The Drizzle templates that branched on dialect were `clean`'s. | **Deleted.** |
| **`behaviors:`** (`strategy`) + entity **`behavior_strategy:`** | `prompt.js` `behaviorStrategy`. Dead. clean-lite-ps always extends a pattern base; there is no inline variant. | **Deleted.** The entity-level **`behaviors:` list** (timestamps / soft_delete / …) is a different, live key and is untouched. |
| **entity `folder_structure:` / `file_grouping:`** | `paths.mjs` `getLayoutConfig` → `prompt.js` `layout` / `isNested` / `isGrouped` / `folderStructure` / `fileGrouping`, all dead; plus `parser/load-entities.ts` → `ParsedEntity.folderStructure` → `formatters/json-formatter.ts`, which only echoed it into `analyze --json`. clean-lite-ps emits one module folder per entity regardless. | **Deleted**, including the parsed field and the JSON-formatter line. |
| **entity `expose:`** | **Live.** `parser/load-entities.ts` → `ParsedEntity.expose` → the frontend field-metadata emitter (write capabilities). Only `prompt.js`'s `expose` / `exposeRepository` / `exposeRest` / `exposeTrpc` / `exposeElectric` locals were dead. | **Kept**; the five dead locals deleted. |
| **~69 `prompt.js` locals** | See "How each key was measured". | **Deleted** with the passes that computed them (fields, relationships, queries, events, UI inference, Electric where-clause, behavior resolution). `prompt.js`: 1570 → 377 lines. |

## What `prompt.js` is now

It parses the YAML, merges role-derived relationships (CAP-2), loads the pattern registry, calls
`buildCleanLitePsLocals`, and returns the four things the extension does not build — the banner, the runtime-import
specifiers, the `detection:` literal, and the EVT-7 `emits:` descriptors — with the extension's locals spread over
them.

The `emits:` payload mapping now reads `clpProcessedFields` + `clpBelongsToFkFields` (entity columns) and
`clpCreateDtoFields` + `clpBelongsToFkFields` (DTO keys) instead of its own field pass. The FK sets matter: the
clean-lite-ps field lists are the **non-FK** fields, while the entity and `CreateXDto` both carry the `belongs_to` FK
columns. Without them a `contact_created` payload's `account_id` fell through to the rule-5 `null` placeholder —
caught by the baseline, which is byte-identical with them.

## Also deleted

- `src/config/locations.mjs` — after the `locations` local went, nothing imported it. The three surviving defaults
  live in `load-context.ts`, which already declared its own copy.
- `paths.mjs` is down to `BASE_PATHS`, `getOrchestrationPath`, `getProjectConfig`, `getGeneratedDir`.
- `project init` no longer writes a `naming:` or `database:` block; `project scan` no longer proposes `naming:`, and
  `ProposedConfig` drops `naming` / `folder_structure` / `file_grouping` with the scanner helpers behind them
  (`buildNamingConfig`, `deriveSuffixStyle`, `deriveTerminology`, `inferFolderStructure`).
- `test/fixtures/codegen.config.dealbrain.yaml` and `codegen.config.custom-naming.yaml` — both existed to exercise
  `naming:` / `locations.backend*`.
- The layout keys were stripped from 32 entity fixture YAMLs.

## Kept deliberately

- **The scanner's file-naming detectors** (`profile.naming.fileCase` / `fileGrouping`). They no longer feed any
  config key, but `project scan` still reports them as facts about the scanned project and they carry a confidence
  score. Reporting a detected convention is not the same as accepting a knob; deleting the detectors is a scanner
  decision, not this one.

## Gate

Extended the existing config tests — no new harness:

- `path-defaults.test.ts`: a named case per deleted block (`naming:`, `database:`, `behaviors:`) asserting the CFG-0
  error names the key **and** the file; one case walking all 18 deleted `locations.*` names the same way; one
  asserting the three surviving names still parse.
- `schema-v2.test.ts`: a named case per deleted entity key (`folder_structure`, `file_grouping`,
  `behavior_strategy`) asserting `unrecognized_keys`, plus one asserting `expose:` still parses.

`just test-baseline` is the regression gate for the `prompt.js` deletion: every generated file is byte-identical,
and the two-pass generation still typechecks with only the named #680 expectation.

## Found while implementing

- **#696** (filed): `src/schema/generate-json-schema.ts` cannot run. It calls `z.toJSONSchema`, a zod 4 API, and the
  repo pins zod 3, so `src/schema/entity-definition.schema.json` cannot be regenerated from its source of truth and
  nothing in CI notices the drift. The three deleted entity keys were removed from the committed JSON by hand.
