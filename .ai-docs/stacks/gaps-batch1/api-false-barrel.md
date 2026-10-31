---
issue: pattern-stack/codegen-patterns#811
github_issue: https://github.com/pattern-stack/codegen-patterns/issues/811
stack: gaps-batch1
stack_position: "B: generated-tree-compile-fixes (2 of 2, after #814; no code dependency)"
key: api-false-barrel
layer: L0
size: S
gate: auto
status: strategy-approved
base: origin/main @ a8629dfc
branch: dugshub/811-api-false-barrel
plan: ".ai-docs/stacks/gaps-batch1/plan.yaml on branch dugshub/gaps-batch1-plan (Gate 0 approved 2026-10-31 with every open_questions recommendation)"
related:
  - docs/adrs/ADR-043-data-plane-authentication-guard.md   # §6: `api: false` = no network data plane
  - docs/specs/REL-2.md                                      # §5.3: strict `api: false` traversal error (not triggered here)
  - pattern-stack/codegen-patterns#814                       # Stack B sibling; disjoint files
---

# Spec: #811. An `api: false` module barrel no longer exports a controller that was never emitted

PR title: `fix(#811): an \`api: false\` module barrel no longer exports a controller that was never emitted`

## Goal

When an entity has no HTTP surface (`api: false` or `api: { enabled: false }`), its generated module barrel
`<module>/index.ts` stops exporting `<Entity>Controller` from `./<entity>.controller`. The generator does not emit
that file for such an entity, so today every one of these barrels fails `tsc` with TS2307. A host application with
about 30 internal entities deletes the line after every generation.

The fix is one guard in one template. Most of this PR is the gate: no YAML under `test/` declares `api: false`, so
nothing has ever compiled one. The PR adds the first two fixtures (one per YAML form), a smoke assertion and render
tests.

## Root cause (checked at a8629dfc)

| Where | What it does |
|---|---|
| `templates/entity/new/backend/controller.ejs.t:3` | `skip_if: "<%= apiEnabled === false %>"`: no controller file for an `api: false` entity |
| `templates/entity/new/backend/search-controller.ejs.t:3` | the same for the search controller |
| `templates/entity/new/backend/module.ejs.t:33-35, 56-58, 80` | controller import, search-controller import and `controllers: [...]` are guarded by `apiEnabled` |
| **`templates/entity/new/backend/index.ejs.t:14`** | **`export { <Controller> } from './<stem>.controller';`, unguarded. This is the defect.** |
| `templates/entity/new/backend/entity-locals.js:1442-1448` | `apiEnabled` is `false` for `api: false` and for `api: { enabled: false }`, otherwise `true`. Returned at `:2236`. |

The barrel is the only generated file that references the controller without a guard. In `templates/` and `src/`,
the only imports of a `./<stem>.controller` file are in `module.ejs.t` (guarded), `index.ejs.t` (this defect) and
the relationship templates (see *Checked and unchanged*). The `'.controller'` strings in `src/scanner/` are suffix
lists, not imports.

## Decisions

The plan settled the shape: guard the export with the existing `apiEnabled` local, add a smoke fixture for each YAML
form, keep the baseline unchanged, and do not make either fixture an include target. The spec settles the rest:

1. **The guard is the `apiEnabled` local.** Use the same `<% if (apiEnabled) { -%> … <% } -%>` construct as
   `module.ejs.t:33`. No `typeof` guard: backend templates reference every local unguarded
   (`strict-locals.test.ts`, #638). No new local, and no second reading of `definition.api`.
2. **The barrel's comment follows the flag.** Under `api: false` the comment reads `// Value exports (module, service)`,
   the same text the junction barrel uses (`templates/junction/new/index.ejs.t:11`). With an API it stays
   `// Value exports (module, service, controller)`, so the barrels of entities with an API are byte-identical.
3. **The smoke checks content as well as compiling.** `tsc` proves the barrel compiles, but it cannot tell the
   fix apart from a wrong one. If someone deleted `controller.ejs.t`'s `skip_if`, every barrel would compile again,
   and every `api: false` entity would get a controller file again, against ADR-043 §6. A short
   `assertApiFalseEmission` in `run-smoke.ts` pins the absence. It reads the barrel and the module from the same
   directory, so a wrong path fails with ENOENT and cannot pass silently (CLAUDE.md gate rule (c)).
4. **Fixtures:** `audit_entry` (`api: false`) and `sync_cursor` (`api: { enabled: false }`). Neither has
   `relationships:`, and no smoke fixture declares `api.includes`, so REL-2 §5.3's strict traversal error cannot fire.
   `audit_entry` also declares a `name: search` query. That emits the search use case without a search controller,
   so `module.ejs.t:56` (the search-controller import guard) compiles under `api: false` for the first time too.
5. **The hygen-side reader gets pinned for the object form.** ADR-043 §6's 2026-09-20 note says "a unit test pins
   the pair". On base, the hygen local is only tested with the boolean form (`write-templates.test.ts:278`). This PR
   adds the `api: { enabled: false }` case and corrects the stale local name `clpApiEnabled` in that note.
6. **Not unified:** `entity-locals.js` and `apiEnabled(def)` in `src/schema/entity-definition.schema.ts:1468` stay
   as two readers of one rule, pinned by tests on both sides. Merging them is not part of this fix.

## File-level plan

| File | Change |
|---|---|
| `templates/entity/new/backend/index.ejs.t` | Guard L14 with `apiEnabled`. L11's comment follows the flag (decision 2). Front-matter unchanged. |
| `test/smoke/fixtures/audit_entry.yaml` | **new.** `api: false`, `pattern: Base`, fields `source` (string, required, `max_length: 100`), `message` (string, required), `level` (enum `[info, warn, error]`, default `info`); `behaviors: [timestamps]`; `queries: [{ by: [source] }, { name: search, filters: [level], search: message }]`. Header comment names #811 and ADR-043 §6, and says this is the boolean form. |
| `test/smoke/fixtures/sync_cursor.yaml` | **new.** `api: { enabled: false }`, `pattern: Base`, fields `source` (string, required, `max_length: 100`) and `position` (string, required); `behaviors: [timestamps]`. Header comment names #811, and says this is the block form. |
| `test/smoke/run-smoke.ts` | Add `assertApiFalseEmission(tmpDir)` and run it in the `default` scenario only. In `relationship`, `FIXTURES_DIR` is `fixtures/crm/`, which has neither fixture. Run it **after** the step-6 `tsc` (L879-890), catch its error, `logError` it and set `exitCode = 1`. A run on base then reports both the TS2307s and the assertion. Add the two fixtures to the header's fixture list (L13-16). |
| `src/__tests__/backend/write-templates.test.ts` | Add the tests below to the existing `describe('backend api:false HTTP-surface suppression (ADR-043 §6)')` block (L277), using the file's own `render()` helper. |
| `docs/adrs/ADR-043-data-plane-authentication-guard.md` | §6 *Backend* bullet (L183): add a dated revision note, *2026-10-31 (#811)*: `apiEnabled` also gates the module barrel's controller export. Before this fix the barrel exported it unconditionally, and no fixture caught the TS2307. In the 2026-09-20 note (L189), change `clpApiEnabled` to `apiEnabled`, and say that the hygen half is now pinned for both forms in `write-templates.test.ts`. |
| `consumer-skills/codegen/SKILL.md` | L78-80: say both forms (`api: false` / `api: { enabled: false }`), and that the entity's module barrel then exports the module, service and types, but no controller. |

`assertApiFalseEmission` checks these facts, with the paths under the smoke's default `src/modules/` layout (the same
root `assertRelationshipEmission` reads):

- `audit-entries/index.ts` and `sync-cursors/index.ts` exist and contain no `.controller'` specifier.
- `audit-entries/audit-entries.module.ts` and `sync-cursors/sync-cursors.module.ts` contain `controllers: []`.
- `audit-entries/audit-entry.controller.ts`, `audit-entries/audit-entry-search.controller.ts` and
  `sync-cursors/sync-cursor.controller.ts` do not exist.
- Positive control: `accounts/index.ts` contains `export { AccountController } from './account.controller';` and
  `accounts/account.controller.ts` exists. The assertion therefore also fails if the guard drops the export for
  every entity.

## Emitted shapes

`api: false` (`audit_entry`). This is the whole barrel after the fix, banner line abbreviated:

```ts
// @generated by @pattern-stack/codegen from entities/audit_entry.yaml — DO NOT EDIT. …
/**
 * AuditEntry module barrel export
 * Generated by entity codegen - do not edit directly
 */

// Value exports (module, service)
export { AuditEntriesModule } from './audit-entries.module';
export { AuditEntryService } from './audit-entry.service';

// Type-only exports (entity, DTOs)
export type { AuditEntry } from './audit-entry.entity';
export type { CreateAuditEntryDto } from './dto/create-audit-entry.dto';
export type { UpdateAuditEntryDto } from './dto/update-audit-entry.dto';
export type { AuditEntryOutputDto } from './dto/audit-entry-output.dto';
export type { ListAuditEntriesQueryDto } from './dto/list-audit-entries.query';
```

`api: { enabled: false }` (`sync_cursor`) has the same shape. The barrel of an entity with an API is byte-identical
to a8629dfc, for example `test/baseline/packages/api/src/modules/accounts/index.ts`. Nothing else changes: the
controller and search-controller `skip_if`, the module's guards, and every other file of an `api: false` module stay
as they are.

## Tests

In `write-templates.test.ts`, `baseEntity` is `contact`:

| # | Test | On base |
|---|---|---|
| U1 | `apiEnabled` is `false` for `api: { enabled: false }` (the hygen half, object form) | green (pin) |
| U2 | `api: false`: the barrel contains no `ContactController` and no `'./contact.controller'`. It still contains the module export, the service export, `// Value exports (module, service)` and all five type-only exports. | **red** |
| U3 | U2 for `api: { enabled: false }`. Each form is named in its test title. | **red** |
| U4 | Default (no `api:`) and `api: { enabled: true }`: the barrel contains `export { ContactController } from './contact.controller';` and `// Value exports (module, service, controller)` | green (pin) |

## Gates, and proof that each one can fail on its own subject

| Gate | Its subject in this PR | On base a8629dfc + this PR's fixtures and tests |
|---|---|---|
| `just test-unit` | U2 and U3: the barrel render under both forms | **red.** A probe ran these assertions against base `index.ejs.t` through `buildBackendLocals` + `withEntities()`. `api: false` FAILED, `api: {"enabled":false}` FAILED, and the default barrel passed. |
| `just test-smoke`, step-6 `tsc` | the two new barrels compile under the consumer tsconfig | **red, with exactly the subject.** A probe generated both fixtures with the base CLI (`entity new --all`) and typechecked `src/modules/**`. Inside it there were exactly two diagnostics: `audit-entries/index.ts(10,38)` and `sync-cursors/index.ts(10,38)`, both TS2307 `Cannot find module './…controller'`. After the controller line was deleted from the generated barrels, there were zero. The probe's tsconfig mirrored `test/tsconfig.baseline.json`. The smoke's own tsconfig (from `bun init`, merged by `project init`) has no `include`, so `tsc` checks every `.ts` in the project, barrels included. |
| `just test-smoke`, `assertApiFalseEmission` | barrel content, no controller files, `controllers: []` | **red.** The base barrel contains `'./audit-entry.controller'` (the probe output above). |
| `just test-smoke-subsystems`, vendored leg | the same fixtures directory (`run-smoke-subsystems.ts:39, 150-155`) in a full-tree `tsc` (`:378-383`) | **red**, with the same two TS2307s. The package leg typechecks only `src/worker.ts`, so it does not see the barrels. |
| `just test-baseline` | barrels of entities with an API stay byte-identical (9 under `test/baseline/packages/api/src/modules/*/index.ts`) | green before and after. It fails if the guard changes the output for entities with an API: an EJS tag without `-%>` adds a blank line to all 9 barrels, and a reworded comment changes all 9. |
| `just test-post-publish` (CI `publish` job) | tarball mode runs `run-smoke.ts`, and `FIXTURES_DIR` is in the repo | red on base, like `test-smoke` |

The `test-smoke`, `test-smoke-subsystems` and `test-baseline` gates are in `just test-all` already. No new gate
wiring is needed.

## Build order

1. **Gate commit:** add both fixtures, `assertApiFalseEmission`, and U1-U4. Run `nice -n 19 just test-unit`: U2 and U3
   should fail. Run `nice -n 19 just test-smoke`: the two TS2307s and the assertion should fail. Paste both red
   excerpts into the PR body.
2. **Fix commit:** guard `index.ejs.t` L11/L14.
3. **Docs commit:** the ADR-043 revision note and the consumer SKILL line.
4. Green: `just test-unit`, `just test-smoke`, `just test-smoke-subsystems`, `just test-baseline` (no snapshot diff;
   do not regenerate).

Base the branch on `origin/main`. When restacking Stack B, it goes after #814 (`dugshub/814-package-mode-typed-event-bus`).
The file sets are disjoint: #814 edits `run-smoke-junction.ts` and the junction harness, not `run-smoke.ts` or
`test/smoke/fixtures/`. Across the batch, #511 and #813 add files under `test/smoke/fixtures/` and #796 adds an
assertion to `run-smoke.ts`. A conflict there is a hunk-ordering merge. No snapshot is involved.

## Checked and unchanged

- **The relationship barrel** (`templates/relationship/new/index.ejs.t:14`) exports its controller unconditionally.
  That is correct: a relationship YAML has no `api:` key (`relationship-definition.schema.ts`), and its
  `controller.ejs.t` has no `skip_if`.
- **The junction barrel** exports no controller, and junctions have none.
- **The search controller** has never been exported from the barrel, with or without an API. That stays the same.
- **Package and vendored modes:** the barrel has no runtime-import specifier, so the fix is the same in both modes.
- **The frontend emitter** (`src/emitters/frontend/`) reads `expose:` and `sync:`. It does not read `api:`, so this
  fix does not touch it. Whether `api: false` should also suppress the frontend REST client is a separate
  question, outside #811.

## Acceptance

- [ ] `index.ejs.t` exports the controller only when `apiEnabled`, under both YAML forms (U2, U3).
- [ ] The smoke fixtures `audit_entry.yaml` (`api: false`) and `sync_cursor.yaml` (`api: { enabled: false }`) exist,
      and `just test-smoke` passes, `tsc` and `assertApiFalseEmission` included.
- [ ] The PR body shows the gate commit red: U2/U3 failing, the two TS2307s in the smoke and the assertion failing.
- [ ] `just test-smoke-subsystems` passes.
- [ ] `just test-baseline` passes with no snapshot change.
- [ ] The ADR-043 §6 revision note and the consumer SKILL line are in the same PR.
- [ ] The PR body carries the Changelog block below.

## Changelog block (PR body)

```
Changelog:
### Fixed
- Entities with `api: false` or `api: { enabled: false }`: the generated module barrel (`index.ts`) no longer
  exports a controller that the generator never emits. Every such barrel used to fail `tsc` with TS2307. The barrel
  now exports the controller only when the entity has an HTTP surface. Barrels of entities with an API are
  unchanged. (#811)
  Upgrade: regenerate (`codegen entity new --all --force`), then delete any post-generate step that removed the
  controller export. No schema or DDL change.
```
