# JUNC-0 — a parent's junction fan-out is rendered by its own templates, never injected (#678)

**Status:** Approved (design) — implementation pending
**Date:** 2026-09-19
**Issue:** #678
**Project:** #578 · epic #580 (relation graph)
**Depends on:** ARCH-0 (#677 — deletes the `clean` pipeline; this spec assumes `clean-lite-ps` is the only backend
pipeline and carries no `architecture ===` branches)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility) · `docs/relationship-pattern-audit.md` (the junction shape contract)
**Does not prejudge:** #679 (junction ↔ relationship convergence) — see § #679

## Why

`entity new` writes a parent's `<entity>.service.ts` / `<plural>.module.ts` with `force: true` from templates that
know nothing about junctions. `junction new` then **injects** the fan-out into those two files through 14
`templates/junction/new/_inject-parent-*` templates. Any later `entity new` (a YAML edit, `--all`) rewrites the
parents and the fan-out is gone. `tsc` stays green because nothing generated calls the fan-out methods — the loss is
silent. The parent file is therefore a function of *which command ran last*, not of the YAML: a direct breach of
charter I2 ("generated means regenerated … complete-file, idempotent").

### Repro (this branch @ `4a07e61`, `dugshub/666-run-level-inputs`; fixtures `opportunity × contact`, `clean-lite-ps`, vendored)

`bootstrapJunctionProject({ scenario: 'junction', architecture: 'clean-lite-ps' })` (= `entity new --all --force` →
`junction new --all --force`), then `entity new --all --force`, then `junction new --all --force`. Refs = occurrences
of `OpportunityContact`.

| File | entity → junction | → entity new again | → junction new again |
|---|---|---|---|
| `src/modules/opportunities/opportunity.service.ts` | 89 lines, 10 refs | **35 lines, 0 refs** | 89 lines, 10 refs |
| `src/modules/opportunities/opportunities.module.ts` | 70 lines, 2 refs | **61 lines, 0 refs** | 70 lines, 2 refs |
| `src/modules/contacts/contact.service.ts` | 103 lines, 10 refs | **52 lines, 0 refs** | 103 lines, 10 refs |
| `src/modules/contacts/contacts.module.ts` | 73 lines, 2 refs | **64 lines, 0 refs** | 73 lines, 2 refs |

The last column is byte-identical to the first: the injects are themselves idempotent (per-junction `skip_if`
markers); the defect is purely that `entity new` owns the file and does not know the fan-out exists. The same
mechanism also means:

- **Order dependence.** `junction new` before the parents exist fails on a missing inject anchor (the "ordering
  contract" comment in `test/smoke/run-smoke-junction.ts`). A junction YAML present before the first `entity new`
  contributes nothing until `junction new` runs.
- **Removal only by accident.** Deleting a junction YAML leaves its fan-out in both parents until some unrelated
  `entity new` happens to wipe it; flipping `expose_on_parent.left` to `false` never removes the left fan-out,
  because the inject templates only ever add.

## Charter invariants this PR touches

- **I1 declare once.** The fan-out is derived from the junction YAML set (`between`, `expose_on_parent`) — never from
  a file-existence probe of the junction's generated files (the `targetExists` pattern the `has_many` composition
  uses is *not* copied). The junction naming rule (`<left>_<right>`, table `pluralize(name)`, flat folder
  `<modules_dir>/<plural>`) is today spelled in `templates/junction/new/prompt.js` **and**
  `clean-lite-ps/prompt-extension.js` (`resolveLibraryCapabilityConfig`, Communication many-roles). Both move to one
  shipped helper (§ Design 1).
- **I2 generated means regenerated.** The parent service + module become complete-file renders of the full YAML set
  again. The last `inject:` templates in the repository are deleted (ARCH-0 deletes the `clean` pipeline's four).
- **I7 no backwards compatibility.** The inject templates, their `// junction:<name>:<side>-fan-out` markers, the
  `CGP-60` import-comment scaffolding and the "entity before junction" ordering contract are deleted, not kept in
  parallel. Junction snapshots regenerate.
- **I9 gates are honest.** The new assertions are byte-equality across command orders — no tolerance, no filter.
- **I11 scope.** `clean-lite-ps` only; the parent files stay hygen (per-entity backend files). No new whole-set
  emitter.

## Design

### 1. One fan-out model, shipped with the templates

New `templates/_shared/junction-fan-out.mjs` (ships under `templates/`, like `entity-naming.mjs`):

- `junctionNaming(between, modulesDir)` → `{ name, plural, moduleDir, entityFile, serviceFile, moduleFile,
  serviceClass, moduleClass, entityClass, linkInputType, serviceProperty }`. The single statement of the junction
  naming rule. Consumers: `templates/junction/new/prompt.js` (its own output paths + class names),
  `prompt-extension.js` › `resolveLibraryCapabilityConfig` (Communication `via:` table + import), and the fan-out
  below. `src/schema/junction-definition.schema.ts › deriveJunctionName` stays as the CLI-side statement of the name
  only; both are pinned against each other by a unit test (the CLI cannot import a `.mjs` template helper into its
  zod graph without shipping it — same constraint NAME-0 documents for `loadEntityRegistry`).
- `loadJunctionDefinitions(cwd)` → every junction YAML under the junctions directory, raw-parsed (the CLI has already
  schema-validated them — § 3), filtered to `pattern: Junction`, sorted by junction name. The directory rule
  (`<cwd>/junctions`, no config key) moves from `src/parser/load-junctions.ts › junctionsDirFor` to a new shipped
  `src/config/junctions-dir.ts` (added to `package.json` `files`), imported by both the CLI and this helper.
- `junctionFanOutFor(entityName, { cwd, modulesDir, entityLookup, selfModuleDir })` → the ordered list of fan-out
  blocks this entity carries: one per junction naming it in `between` whose side is exposed
  (`expose_on_parent.<side> !== false`). Each block carries everything the templates print — side, junction naming,
  counterparty `{ pascal, camel, plural, entityImport }` (counterparty folder via `entityLookup` + `entityModuleNaming`,
  NAME-0), junction service / entity / module import paths from `selfModuleDir` (`relativeModuleDir`), and the four
  method names:

  | Side | attach | detach | list | setPrimary |
  |---|---|---|---|---|
  | left (`between[0]`) | `attach<Right>` | `detach<Right>` | `<rightPlural>List` | `<rightPlural>SetPrimary` |
  | right (`between[1]`) | `addTo<Left>` | `removeFrom<Left>` | `<leftPlural>List` | `<leftPlural>SetPrimary` |

  Unchanged from today (the locked contract: mirrored on both parents, delegating to one junction service; list shape
  `Array<{ entity; link }>`; `opts?: { cursor?: string; limit?: number }`).

### 2. The parent templates render the fan-out

`prompt-extension.js` adds `clpJunctionFanOut` (from § 1) to the locals. Then:

**`clean-lite-ps/service.ejs.t`**
- `forwardRef` joins the existing `@nestjs/common` import when `clpJunctionFanOut.length > 0` (no second import line).
- Per block: `import { <Svc>, <LinkInput> } from '<junctionService>'`, `import type { <Junction> } from
  '<junctionEntity>'`, and `import type { <Counterparty> } from '<counterpartyEntity>'` — the counterparty import is
  **deduped** against `clpRepositoryDeps` (a parent that already composes the counterparty via `belongs_to` /
  `has_many` imports the same type from the same path) and against other blocks.
- A `Junction fan-out` section after the relationship composition methods (no longer splitting the
  `// Inherited from` comment block, which today's inject anchors on). Per block: the
  `@Inject(forwardRef(() => <Svc>)) private readonly <serviceProperty>!: <Svc>;` property and the four methods, with
  bodies **identical** to today's `_inject-parent-service-clp-{left,right}.ejs.t`.

**`clean-lite-ps/module.ejs.t`**
- `forwardRef` joins `import { Inject, Module, type OnModuleInit }` when fan-out is non-empty.
- `import { <JunctionModule> } from '<junctionModule>'` per block; `forwardRef(() => <JunctionModule>),` in `imports`
  after `DatabaseModule,`.

**Byte compatibility.** Method names, signatures, bodies and the module wiring are byte-compatible with today's
injected output. Layout is **not**, deliberately: today's bytes are an artifact of inject anchoring (a second
`import { forwardRef } from '@nestjs/common'`, `// CGP-60 —` comments between import lines, the fan-out wedged
inside the lifecycle comment, marker comments that only existed for `skip_if`). Reproducing inject artifacts in a
complete-file template would preserve the mechanism's scars for no consumer (CLAUDE.md: no backwards compat). The
parent-service snapshots in `test/junction/__snapshots__` regenerate; the reviewed diff must show only import
layout, comments and placement — any method-body change is a defect.

### 3. `entity new` knows the junction set, and validates it

The pre-flight already loads `loadJunctionSummaries` for the roles check, which **skips** junction files that fail
the schema. A skipped junction would now silently drop fan-out — the exact defect class being fixed. So:

- `entity new`'s pre-flight loads the junction set with errors (`loadJunctionSet` → `{ junctions, issues }`) and
  makes each issue a **run-level rejection** (the #666 posture — an input other entities' output depends on): a
  junction YAML that fails `JunctionDefinitionSchema`, or whose `between` names an entity with no entity YAML.
- The roles cross-check consumes the same loaded set (no second load).
- The hygen prompt re-reads the raw YAMLs through § 1 — like every other cross-entity read in the prompts — trusting
  the CLI's validation, as `junction new`'s prompt already does.

### 4. `junction new` re-renders both parents through the entity path

Decision: **yes, `junction new` still updates the parents**, so a new junction is wired without a separate
`entity new` — but by re-rendering them through the entity pipeline, not by injecting.

- The per-target part of `EntityNewCommand` (pre-flight + hygen loop) is extracted to
  `src/cli/shared/entity-render.ts` (`preflightEntityTargets(ctx, files)` / `renderEntityTargets(ctx, validated)`).
  `entity new` = that + its whole-set post-steps (barrels, events, bridge, orchestration, frontend, providers, jobs),
  unchanged. `junction new` = junction pre-flight + junction hygen + `preflightEntityTargets` / `renderEntityTargets`
  on the **union of every generated junction's two endpoints** (each once), then barrels as today.
- **Both** endpoints are re-rendered regardless of `expose_on_parent`: flipping a side to `false` must remove that
  side's fan-out.
- `junction new` runs no entity post-step: none of them reads the junction set, so the per-entity files are exactly
  what `entity new` would write for those two entities. An endpoint rejected by the entity pre-flight fails
  `junction new` (named, per endpoint), same as `entity new` would.
- `--dry-run` lists the parents it would re-render; `--json` adds `parents: { succeeded, failed }`.

Rejected alternatives: (a) `junction new` leaves parents alone and tells the author to run `entity new` — correct but
two commands for one change; (b) `invokeEntityNew` on the endpoints without the entity pre-flight — a second,
unvalidated render path (the hygen prompt assumes `emits:` / `roles:` are valid); (c) folding junction generation into
`entity new` as a post-step — a larger command-surface change that #679 should decide.

### 5. Resulting properties

For a fixed YAML set, the parent files are a pure function of that set:

- `entity new` ↔ `junction new`, any order, any number of times → identical bytes on both parents.
- Junction YAML present before the first `entity new` → the fan-out renders on that first run. Until `junction new`
  emits the junction's own files the parent imports a missing module (`tsc` names it); `entity new` prints a hint
  (`junction <name> is declared but not generated — run codegen junction new`) when the junction's module file is
  absent. The hint reads the filesystem; the bytes never do.
- `junction new` on a fresh project (no parent files yet) now works — the anchor-ordering failure mode is gone.
- Deleting a junction YAML → the next `entity new` removes its fan-out from both parents. (The junction's own
  generated folder is left on disk and dropped from the barrels, like any deleted entity YAML — out of scope.)

### Deletions

- `templates/junction/new/_inject-parent-*.ejs.t` (all 14).
- `templates/junction/new/prompt.js`: `resolveParentPaths`, `parentServicePath*` / `parentModulePath*`,
  `injectionMarker*`, `junction*ImportFrom{Left,Right}`, `*EntityImportFrom{Left,Right}`, `exposeOnParent` and the
  other fan-out-only locals; naming comes from `junctionNaming`.
- `test/smoke/run-smoke-junction.ts`: the "Ordering contract (CGP-60)" block, the `// Inherited from` anchor
  assertions and the per-junction marker assertions (they assert the inject mechanism).
- `junctionsDirFor` moves; `loadJunctionSummaries` is replaced by the error-reporting loader (its one other caller,
  `analyzeDomain`, reports the issues instead of skipping).

## Gate

Extend the existing junction smoke leg (`test/smoke/run-smoke-junction.ts`, no new harness); runs in both runtime
modes (`just test-smoke-junction` already runs `vendored` + `package`, default + custom layout):

1. **Round trip.** After the bootstrap (entity → junction): snapshot both parents' service + module; run
   `entity new --all --force`; assert byte-identical; run `junction new --all --force`; assert byte-identical.
2. **Order swap.** A second project dir in the same leg: junction YAMLs copied **before** the first
   `entity new --all --force`, then `junction new --all --force`; assert the four parent files are byte-identical to
   step 1's. (Needs `bootstrapJunctionProject({ junctionsFirst: true })` — a flag on the shared helper, not a second
   harness.)
3. **Removal.** Delete the junction YAML, `entity new --all --force`: assert both parents carry no reference to the
   junction service / module, then `tsc` is clean (the orphaned junction folder still compiles against its parents).
4. The existing fan-out grep assertions and `tsc` run stay.

Plus: unit tests for `junctionFanOutFor` (sides, `expose_on_parent`, counterparty-import dedupe, a context-nested
endpoint) and for the `junctionNaming` ↔ `deriveJunctionName` pin; `entity new` pre-flight tests for the two new
run-level rejections; junction snapshots regenerated and reviewed.

Gates after the last edit: `bun run typecheck && bun run build && bun run test`, `just test-all`,
`just test-integration`, `just test-post-publish`.

## #679

This fix is neutral on convergence: the fan-out is computed from a `(between, expose_on_parent)` pair by one helper,
and the emitted API is today's. Whichever kind #679 keeps feeds the same helper; REL-3 may later replace the
hand-composed `listAssoc` with a `.through()` read without touching where the fan-out is rendered.

## Out of scope

- The junction/relationship model (#679); `relationship new` (it emits a standalone entity and injects nothing into
  parents).
- Orphaned generated folders after a YAML is deleted (general, all kinds).
- Frontend junction accessors (FE-REL).

## Found

- **Pre-existing: mirrored junctions collide on the shared parent.** Junctions `a × b` and `b × a` both land on `a`
  with `<bPlural>List` / `<bPlural>SetPrimary` (left side of one, right side of the other) — duplicate members, a loud
  `tsc` error, not silent. Unchanged by this spec; filed as #681.
- **CLAUDE.md** describes `_inject-` templates under § Template System; after ARCH-0 + this PR none exist — the line
  is removed in the implementing PR.

## Downstream must know

_(filled in at implementation)_
