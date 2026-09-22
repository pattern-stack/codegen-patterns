# NAME-1 — the three template defects NAME-0 surfaced

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issues:** #633 (`relationship new` re-pluralizes) · #632 (duplicate repository import) · #631 (FK cycles) ·
**Project:** #578
**Depends on:** NAME-0 (#635): `templates/_shared/entity-naming.mjs`
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Template
System (the naming rule)

NAME-0 reshaped its smoke fixtures into a DAG (shift → crew → person → squad) to stay scoped to naming. Three
pre-existing defects were behind that reshape, or next to it. This PR fixes all three and restores the fixture edges
that NAME-0 removed.

## Charter invariants this PR touches

- **I1 declare once.** A `relationship new` endpoint's table and folder come from its YAML, through the same
  function its own emission uses (#633). The FK annotation is one unconditional rule, so no second model of the FK
  graph (cycle detection) exists to drift from the YAMLs (#631).
- **I2 / I7 generated means regenerated; no backwards compatibility.** The junction snapshots are regenerated. The
  diff is the annotation and nothing else (see Gates). `clpHasSelfFk` is replaced by `clpHasFk`, not aliased.
- **I9 gates are honest.** The package leg of the capability smoke now also compiles `relationship new` output.
  Its `@shared/*` diagnostics are the existing #624 defect. They are added to that named expectation, enumerated
  exactly and asserted present and sole. They are not filtered. (RT-0 fixed #624 and deleted the expectation,
  2026-09-17.)
- **I11 scope.** clean-lite-ps, `junction new` and `relationship new`. The `clean` pipeline is not touched (#631
  below).

## #633: `relationship new` endpoints

`templates/relationship/new/prompt.js` derived `pluralize(from)` / `pluralize(to)` and imported
`'../<plural>/<name>.entity'`.

- Each endpoint resolves with `projectEntityLookup(cwd)` + `entityModuleNaming`, as the junction prompt does. A
  self-referential relationship resolves once.
- `fromTable` / `toTable` are the declared plurals. The new locals `fromEntityImport` / `toEntityImport` hold the
  import paths. They are `relativeModuleDir` from the relationship's own flat folder to each endpoint's folder.
  `entity.ejs.t` uses them.
- A missing endpoint YAML is a generation error. The error names the endpoint and the directory searched
  (`entityLookup.missingEntity`).
- The relationship's own table name (`table:` else `pluralize(name)`) is its own naming rule and is unchanged.

**Gate placement.** No existing gate ran `relationship new`. `just test-smoke-relationship` exercises clean-lite-ps
`belongs_to` / `has_many`, not the `relationship` generator, and it runs vendored only. The capability smoke is the
two-mode harness, and it already holds the irregular-plural `person` and the `context:`-nested `crew`. So it gained
`relationships/crew_assignment.yaml` (`from: person`, `to: crew`) and a `relationship new --all` step in both legs.

- **Vendored leg:** compiles clean.
- **Package leg:** the relationship's repository, service and two use-cases hit the same `@shared/*` hardcoding as
  the junction (#624, which already names `relationship new`). That is 12 diagnostics: 6 × TS2307, 4 × TS4112 and
  2 × TS2339. They are added to `applyIssue624Expectation` as `issue624Relationship(...)`.
- **Against the pre-NAME-1 generator:** the new fixture fails both legs with `Cannot find module
  '../people/person.entity'` and `'../crews/crew.entity'`.

## #632: one repository per composed target

`service.ejs.t` and `module.ejs.t` deduped belongs_to targets and has_many targets separately, not across the two
lists.

- `prompt-extension.js` now builds `clpRepositoryDeps` with `collectRepositoryDeps(belongsTo, existingHasMany)`.
  It is keyed by target entity and holds non-self belongs_to targets, then wired non-self has_many targets. Each
  entry is `{ entity, entityClass, repositoryClass, property, importDir }`.
- The service's imports and constructor parameters, and the module's imports and providers, each iterate that set
  once. The templates keep a `typeof` guard on it, like every clean-lite-ps local. Under
  `architecture: clean` hygen still renders these bodies (the `skip_if` only suppresses the write), and it renders them
  without clean-lite-ps locals. Dropping the guard broke the baseline. The cost is that a genuinely missing local
  silently emits nothing. That is **#638**: gate the render, or fail loudly on a missing local.
- The per-relationship methods are unchanged. They still iterate `clpBelongsTo` / `clpExistingHasMany`, and
  `property` is the same `<camel>Repo` name they address.
- **Same class, one more site:** the EAV value-table block (`eav_definition_table`) imported and injected its
  definition repository on its own. A value table that also belongs_to its definition entity would import it twice.
  When the set already holds that entity, the new local `eavDefinitionRepositoryImported` skips the EAV block's import
  and its `definitionRepo` parameter. The EAV methods address the repository by `eavDefinitionRepoProperty`: the
  deduped `<entity>Repo` in that case, and `definitionRepo` otherwise. The result is one constructor parameter per
  repository class (review nit).
- **Order change:** the module used to list has_many repositories before belongs_to repositories. It now follows the
  set order (belongs_to first). This only affects an entity with both kinds of edge onto *different* targets. No
  baseline or snapshot covers that.

## #631: every FK callback is annotated

Only a self-FK got `.references((): AnyPgColumn => …)`. A cross-file FK cycle (A → B → A, or longer) made
TypeScript type both table consts `any` (TS7022/TS7024).

**Decision: annotate every generated FK callback, unconditionally.** The alternative was cycle detection over the
YAMLs. That is a second model of the FK graph (I1), it has to be kept correct, and it buys nothing: the annotation
has no runtime effect and, as measured below, no type effect.

**Measured before choosing** (drizzle-orm `1.0.0-rc.4`, `strict`): a mutual-FK pair in two files, both callbacks
annotated.

- `InferSelectModel` of a not-null FK column is exactly `string`, and of a nullable one exactly `string | null`.
- `InferInsertModel` gives exactly `string` and `string | null | undefined`.
- The column's `_['notNull']` is `true`.
- Checked with a type-equality helper, `tsc` exit 0. With the annotations removed the same pair gives TS7022/TS7024
  and the table types collapse to `any`.
- The FK callback's return type does not feed the column type, so the REL-1 relations manifest, which reads tables
  and columns, is unaffected. The capability smoke compiles it in both modes.

Sites:

- **clean-lite-ps** `entity.ejs.t`: belongs_to FK. `processFieldFeatures`: field-level `foreign_key:`. The
  `type AnyPgColumn` import is gated by the new `clpHasFk` (any belongs_to or field FK), which replaces
  `clpHasSelfFk`.
- **junction** `entity.ejs.t`: both endpoint FKs, always imported.
- **relationship** `entity.ejs.t`: both endpoint FKs, always imported.
- **Not touched: the `clean` pipeline** (`templates/entity/new/backend/database/schema.ejs.t`). It has the same
  defect, but:
  - it is #602 territory (I11, charter §5);
  - it has a sqlite dialect branch, where the type would be `AnySQLiteColumn`;
  - the baseline gate never compiles its schema files.

  So `test/baseline/` does not move. The defect is recorded on #602.

The capability fixtures regain `person.crew → crew` next to `crew.lead → person`, which is the #631 cycle.
`person` now both belongs_to and has_many `crew`, which is the #632 shape. The smoke also pins that
`person.service.ts` / `persons.module.ts` contain exactly one `CrewRepository` import, one provider and one
`crewRepo` parameter, and that `person.entity.ts` annotates its `crews.id` FK.

**Against the pre-NAME-1 generator** the extended smoke fails the vendored leg with 14 diagnostics:
- 2 × TS2307: the relationship endpoints (#633);
- 4 × TS7022/TS7024: `crews` and `persons` (#631);
- 8 × TS2300: `CrewRepository`, `Crew` and `crewRepo` in `person.service.ts` / `persons.module.ts` (#632).

The package leg fails with 26 diagnostics.

## Acceptance

- Unit tests:
  - `src/__tests__/templates/relationship-endpoint-naming.test.ts`: the real prompt in a temp project, covering an
    irregular plural, a `context:` endpoint, a self-reference and a missing endpoint.
  - `target-naming.test.ts`: `clpRepositoryDeps`, the service/module rendering once, the EAV + belongs_to case,
    the annotation on belongs_to and field FKs, and no import without an FK.
- Existing FK assertions (unit tests, `run-smoke.ts`, `run-smoke-capability.ts`) now expect the annotated form.
- Capability smoke is green in both modes. Junction snapshots are regenerated, and their diff is the annotation only.

## Gates

Output from the runs made after the last code edit (charter I9), re-run after the review nits. Nothing has been edited since those runs.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | **exit 0**. The baseline is byte-identical: the `clean` pipeline is untouched. |
| `just test-all` | **exit 0**. Unit tests: **3351 pass / 0 fail**. Also green: baseline, smoke, smoke-subsystems (both modes), smoke-relationship, smoke-junction ×2, and **smoke-capability (vendored + package)** with the NAME-1 fixtures and the #624 expectation now covering 2 junctions + 1 relationship. Junction snapshots: **10/10**, regenerated, and the diff is 4 FK lines + 2 `type AnyPgColumn` import lines, nothing else. integration-emit 56/56; smoke-integration green. |
| `just test-integration` | **exit 0**: 74 pass · 2 skip (the existing `test.skip`s) · 0 fail |
| `just test-smoke-junction-clean` | exit 1. **Known-red, #602**, still exactly **118** |
| `just test-post-publish` | not run: `files` is unchanged. `relationship new` imports `templates/_shared/entity-naming.mjs`, which NAME-0 already ships. |

- **No filter, no `.skip`.** The #624 expectation grew by the relationship's 12 named diagnostics. It is still
  exact, present and sole.
- **New `any`s:** none. **No `as unknown as`.**

## What downstream must know

- **Every generated FK callback is `(): AnyPgColumn =>`** in clean-lite-ps, junction and relationship output. A
  new generator that emits `.references()` follows the same rule. FK cycles between entities are supported.
- **`clpHasSelfFk` is gone**; `clpHasFk` gates the `AnyPgColumn` import.
- **`clpRepositoryDeps`** is the one list of other entities a clean-lite-ps service injects a repository for. A new
  edge kind that composes another repository adds to `collectRepositoryDeps`, not a new template loop.
- **`relationship new` requires endpoint YAMLs**, like `junction new`. It still hardcodes `srcRoot = 'src'`. Its
  `@shared/*` runtime imports now resolve by runtime mode (RT-0, #624, 2026-09-17).
