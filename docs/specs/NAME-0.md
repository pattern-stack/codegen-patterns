# NAME-0 — cross-entity names resolve from the target's YAML, never re-pluralized at emit time

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issues:** #630 (clean-lite-ps `belongs_to` / `has_many`) · #611 (junction endpoints) · **Project:** #578
**Depends on:** CAP-3 (#595) — `createEntityLookup` / `entityModuleNaming`
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Frontend
Emitter ("FK target names resolve against the cross-entity registry, never re-pluralized at emit time") · ADR-038

## Why

A generator that needs another entity's table export or module folder derives it by calling `pluralize()` on the
target's *name*. The target's own emission uses its YAML's `plural:` (and nests its folder under `context:`). When
the two disagree — `entity: { name: person, plural: persons }`, where `pluralize('person')` is `people`, or any
`context:`-nested target — the referencing file imports a table that does not exist from a folder that does not
exist. The REL-1 relations manifest resolves parent tables through the registry, so the templates and the manifest
would also disagree about the same edge.

Sites, all of them one defect:

| Generator | Site | Uses the re-derived name for |
|---|---|---|
| clean-lite-ps | `processBelongsTo` | `.references()` table identifier, entity/repository/service/module imports |
| clean-lite-ps | `processHasMany` | repository/entity imports, the `targetExists` two-pass check |
| clean-lite-ps | `processFieldFeatures` (field `foreign_key: <table>.<col>`) | entity-file import (`singularize(table)`, flat folder) |
| clean-lite-ps | EAV `eav_definition_table` | definition module + repository imports |
| junction | `prompt.js` endpoints | FK `.references()`, entity/repo/module imports, parent inject targets + class names |

Every one of these also assumed the target's folder is a sibling (`../<plural>/`), which is wrong for any
`context:`-nested entity on either side of the edge.

## Charter invariants this PR touches

- **I1 declare once.** A target's plural and folder are stated once, in its YAML. Every site above reads them from
  there through one function (`entityModuleNaming`), the same one the target's own emission uses — agreement by
  construction, not by two derivations that happen to match.
- **I2 generated means regenerated.** Output for a target with a regular plural and no `context:` is byte-identical:
  the baseline (clean pipeline, untouched) and the 10 junction snapshots do not move.
- **I7 no backwards compatibility.** No fallback to `pluralize()` when a target YAML is missing — see Design §3.
- **I9 gates are honest.** The new fixtures compile in both runtime modes; any package-mode junction diagnostic is a
  named, exact #624 expectation, never a filter.
- **I11 scope.** clean-lite-ps and the junction generator only. The `clean` pipeline's own re-pluralization
  (`templates/entity/new/prompt.js`, the `targetPlural` locals) is its known-red territory (#602) and stays out.

## Design

1. **One shared module.** `templates/_shared/entity-naming.mjs` holds `entityModuleNaming`, `createEntityLookup`
   and `projectEntityLookup`. They moved out of the clean-lite-ps extension because they now have three readers: the
   entity prompt, the clean-lite-ps extension and the junction prompt.
   - `loadEntityRegistry` still cannot be imported from a hygen prompt (CAP-3 Found #9).
   - The lookup is keyed by name and, for field-level `foreign_key: <table>.<col>`, by plural.
   - Where the YAMLs live and how the tree is walked are **not restated**. The module imports the CLI's own
     `src/config/entities-dir.ts` and `src/utils/find-yaml-files.ts`, which are now in `files` (Found #11).
2. **A resolved import directory.** `entityModuleNaming` also returns `moduleDir`. Each relationship entry carries
   `importDir` — the posix-relative path from the referencing entity's module folder to the target's. Flat→flat is
   `../<plural>`, so existing output does not change; nested↔flat becomes `../../<plural>` or `../<context>/<plural>`.
   Templates use `importDir` instead of a hand-built `'../' + plural`.
3. **A missing target YAML.**
   - `belongs_to`, field `foreign_key:`, EAV definition, junction endpoint → **generation error naming the target**.
     These edges emit an import and a `.references()` of the target's table unconditionally; with no YAML there is
     nothing to read the table name from, and the old guess compiled only when it happened to match. (#611 asks for
     exactly this for the junction.)
   - `has_many` → **unchanged soft behaviour.** `targetExists` stays a file-on-disk check (two-pass generation: the
     target YAML can exist and not be generated yet), now at the target's resolved path. A target with no YAML is
     simply not wired, as before.
   - A self-reference needs no lookup; it is the entity's own naming.
4. **Where YAMLs are read: one rule, `src/config/entities-dir.ts`.** Read by the CLI context and the prompts.
   - Find `codegen.config.yaml` by walking upward from the working directory.
   - Try `paths.entities`, else `paths.entities_dir`, then `<cwd>/entities`. The first that exists wins.
   - The tree is walked with `findYamlFiles`, which is recursive and skips dot-directories.
   - Before this PR the prompt honoured only `entities_dir` and had its own walk.
5. **Junction.** Both endpoints resolve through the lookup. `leftTable` / `rightTable`, the parent service/module
   paths the `_inject-parent-*` templates target, the parent module class names, and every relative import (both
   directions) come from the resolved naming. Under `architecture: clean` the endpoint folder ignores `context:` (the
   clean pipeline has none) but the plural is the declared one.
   > **2026-09-19 — JUNC-0 (#678):** the `_inject-parent-*` templates are deleted; the parents render their own
   > fan-out through `templates/_shared/junction-fan-out.mjs` (same NAME-0 lookup). See `docs/specs/JUNC-0.md`.

## Acceptance

- Unit: lookup + naming (incl. by-plural), `importDir` for flat/nested in both directions, each missing-YAML error,
  `has_many` soft skip, junction endpoint resolution (irregular plural, `context:`, missing endpoint).
- Smoke: the capability fixture set gains an irregular-`plural:` entity and a `context:`-nested entity, reached via
  `belongs_to`, `has_many`, and as the two endpoints of a junction; `tsc` in **both** runtime modes.
- Baseline byte-identical; junction snapshots 10/10 unchanged; `test-smoke-junction-clean` still exactly 118.

## Found during implementation

1. **The plural was half the defect; the folder was the other half.** Every template built its cross-module import as
   `'../' + plural + '/'`, so a `context:` on *either* side of an edge broke it, not just on the target. Each entry
   now carries a resolved `importDir` (`relatedImportDir` on belongs_to, `targetImportDir` on has_many,
   `eavDefinitionImportDir`), and `service.ejs.t` / `module.ejs.t` use it.
2. **The junction's counterparty inject reused the wrong path.** `_inject-parent-service-counterparty-clp-*` imported
   the other endpoint's entity type using the path *from the junction's folder*, reused from the parent's folder.
   That is right only when all three are flat siblings. Its `skip_if` dedupes it against the parent's own belongs_to
   import, and only when both are byte-identical, so a nested endpoint got a broken import *and* a duplicate
   identifier (TS2300). New locals `rightEntityImportFromLeft` / `leftEntityImportFromRight`. The
   `_inject-parent-service-import-clp-*` and `entity.ejs.t` hand-built paths are gone too
   (`junctionEntityImportFromLeft/Right`, `left/rightEntityImportFromJunction`).
   > **2026-09-19 — JUNC-0 (#678):** the counterparty import now comes from `junctionFanOutFor` and is deduped against
   > the parent's composed-repository imports by path in the prompt, not by `skip_if`. See `docs/specs/JUNC-0.md`.
3. **Field-level `foreign_key: <table>.<col>` had the mirror-image defect.** It named the entity file
   `singularize(table)` in a flat folder. The lookup now also resolves **by plural** (`lookup.byPlural`), so the
   import comes from the entity whose YAML declares that table.
4. **`eav_definition_table` re-pluralized too** (module + repository imports). Resolved the same way.
5. **`targetExists` checked a layout clean-lite-ps never emits.** Besides the nested path it accepted a flat
   `modules/<target>.entity.ts`. That branch is deleted; the check is the target's own `moduleDir`.
6. **The prompt honoured only `paths.entities_dir`.** The CLI resolves `paths.entities ?? paths.entities_dir`. The
   prompts now use the CLI's rule (Found #11). The frontend emitter still reads only `entities_dir`:
   **#634**. (2026-09-18, CLI-0: `paths.entities_dir` is deleted. `paths.entities` is the one key, and the frontend
   emitter takes the resolved directory as an argument. See `docs/specs/CLI-0.md`.)
7. **Unit tests that build locals by hand now name their targets.** `src/__tests__/clean-lite-ps/_entity-lookup.ts`
   (`withEntities(base)`) supplies a fixed lookup with declared plurals. That is 8 files, plus the two junction test
   files, which now write endpoint YAMLs into their temp project.
8. **Smoke placement (deviation).** The brief asked for the relationship or junction fixture set. Neither harness
   compiles in package mode, and adding a package leg to either would mean building a new harness mode. The
   capability smoke is the only one that runs `tsc` in **both** runtime modes and already generates a junction, so
   the fixtures went there: `crew` (`context: org`), `person` (`plural: persons`), `squad`, `shift`, and junction
   `crew_person`. The package leg's #624 expectation now enumerates the same 16 diagnostics per junction for both
   junctions (`issue624Junction(folder, name, Pascal)`). It is still exact, named and asserted present-and-sole, not
   a filter. Against the **pre-NAME-0 generator** the extended smoke fails with 20 `TS2307`s per leg
   (`../people/…`, `../crews/…`), so the gate is real.
   **Revision 2026-09-17:** fixed by RT-0 (#624, `docs/specs/RT-0.md`): both templates resolve these imports by runtime mode, and the expectation is deleted.
9. **Pre-existing defects that shaped the fixtures** (not naming; filed, not fixed):
   - **#631**: two entities with FKs to each other fail `tsc` (TS7022/TS7024). Only a self-FK gets
     `AnyPgColumn`.
   - **#632**: an entity that both belongs_to and has_many the same target imports its repository twice (TS2300).
   - The NAME-0 fixtures are therefore a DAG (shift → crew → person → squad).
   - *(Fixed in NAME-1, `docs/specs/NAME-1.md`, which restores the `person.crew` edge.)*
10. **Still re-pluralizing, out of scope:**
    - `relationship new` (**#633**; same fix, same primitive). *Fixed in NAME-1.*
    - The `clean` pipeline's own `targetPlural` locals (`templates/entity/new/prompt.js`). That is #602 territory
      (I11).
    - Not a defect: `Communication`'s `via:` junction is addressed as `pluralize(via)`. That is the junction's
      *own* naming rule (`junction new` has no `plural:` override), not a re-derivation of another entity's
      declared name.

11. **(Review) The entities-dir rule must be the CLI's, not a copy.** The first cut restated it and drifted in
    two ways:
    - It returned a configured `paths.entities` even when that directory did not exist, where the CLI falls back
      to `<cwd>/entities`. A stale config key would then have hard-failed every `belongs_to`.
    - Its walk did not skip dot-directories.

    The rule is now `src/config/entities-dir.ts`: `findConfigUpward` (moved out of `src/cli/shared/context.ts`),
    `entitiesDirCandidates` and `resolveEntitiesDir`. The CLI context and `projectEntityLookup` both call it. The walk
    is `findYamlFiles`. Both modules are in the package's `files`, as `src/roles/derive.ts` already is (bun resolves
    the `.js` specifiers to `.ts`). The manifest-coverage test walks the import graph and pins this.
12. **(Review) Errors name what was searched.** The lookup carries `missingEntity(name)` / `missingPlural(plural)`.
    Each gives the absolute directory searched and an example of the file expected (`<dir>/<name>.yaml`), or the
    candidates tried when no directory exists. All three throw sites use them.
13. **(Review) A field `foreign_key:` to a host-owned table.** For example `tenants.id` with no `tenant.yaml`, as in
    `test/fixtures/*`, which escape only because the baseline runs the `clean` pipeline.
    - It stays a hard error, because the old import could never resolve.
    - The message now says the table is not owned by any entity YAML. It offers two options: declare that entity,
      or drop the column-level `foreign_key:`.
    - The real design question, how a YAML references a table the host owns, is **#636**, cross-referenced to TEN-1
      (#585).
14. **(Review) Two YAMLs declaring the same `plural:` is a load error naming both files.** Before, `byPlural` was
    last-write-wins.
15. **(Review) The lookup is cached per process** (`projectEntityLookup`, keyed by the resolved directory). This
    does **not** make `entity new --all` walk once: the CLI runs each entity's hygen in its own process
    (`execSync` in `src/cli/shared/hygen.ts`). The walk is lazy, so it only happens for an entity that references
    another. The cost is one directory walk plus YAML parse per such entity, which is negligible at tens of
    entities. A cross-process cache would need an on-disk index with invalidation, which is not worth it at this
    size.
16. **(Review) #602 records the `clean` pipeline's cross-entity `pluralize()` sites** in its census, mirroring
    #633.

## Gates

Output from the runs made **after the last code edit** (charter I9). The only edit since is this table.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | **exit 0**; baseline byte-identical (the clean pipeline is untouched) |
| `just test-all` | **exit 0**. Unit **3340 pass / 0 fail**. Also: baseline, smoke, smoke-subsystems, smoke-relationship, smoke-junction ×2, **smoke-capability (vendored + package)** with the NAME-0 fixtures, path assertions and the #624 expectation over both junctions, junction snapshots **10/10 unchanged**, integration-emit 56/56, smoke-integration |
| `just test-integration` | **exit 0**: 74 pass · 2 skip (pre-existing `test.skip`) · 0 fail |
| `just test-post-publish` | **exit 0**. The tarball ships `templates/_shared/entity-naming.mjs` plus the two `src/` modules it imports (`src/config/entities-dir.ts`, `src/utils/find-yaml-files.ts`), and the consumer workflow compiles from it |
| `just test-smoke-junction-clean` | exit 1. **Known-red, #602**, still exactly **118** |

- **No filter, no `.skip`.** The #624 expectation grew by one junction's worth of the same 16 named diagnostics
  (Found #8). It is still exact, present and sole.
- **New `any`s:** none. **No `as unknown as`.**

## What downstream must know

- **The primitive.** `templates/_shared/entity-naming.mjs` exports:
  - `entityModuleNaming(block, srcRoot)` → `{ plural, moduleGroupDir, moduleDir, entityFile }`
  - `relativeModuleDir(from, to)`
  - `projectEntityLookup(cwd)`: the CLI rule, cached per process
  - `createEntityLookup(dir, candidates)`: a function by name, plus `.byPlural`, `.missingEntity`, `.missingPlural`
  - `entityLookupFrom(blocks)`

  Any new hygen site that names another entity uses it, never `pluralize(target)` or a hand-built `'../<plural>/'`.
- **The entities-directory rule lives in `src/config/entities-dir.ts`.** Anything that needs "where are the entity
  YAMLs" calls it. The frontend emitter does not yet (#634).
- **Field `foreign_key:` to a table the host owns** (a tenants or users table with no entity YAML) is a generation
  error in clean-lite-ps. **TEN-1 (#585) will hit this** for `tenant_id`. The design for referencing a host-owned
  table is #636.
- **A missing target YAML is a generation error**, naming the target, for belongs_to, field `foreign_key:`, EAV
  definition and junction endpoints. A missing has_many target is silently not wired, as before.
- **The relations manifest (REL-1) and the templates now agree.** Both take a parent's table from its YAML's
  `plural:`.
- **Locals added:**
  - clean-lite-ps: `relatedImportDir`, `targetImportDir` (null when the has_many target has no YAML; `targetPlural`
    and `importPath` too), `eavDefinitionImportDir`.
  - junction: `junctionEntityImportFromLeft/Right`, `rightEntityImportFromLeft`, `leftEntityImportFromRight`.
- **`buildCleanLitePsLocals` callers** must pass `entityLookup` whenever the definition references another entity.
  `prompt.js` always does; tests use `withEntities()`.
