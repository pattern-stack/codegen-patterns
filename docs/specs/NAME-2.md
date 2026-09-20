# NAME-2 — one emitted-file naming rule; the `clean-lite-ps` name retires

**Status:** Implemented
**Date:** 2026-09-20 · **Implemented:** 2026-09-20
**Issues:** #695 (retire the name + settle the rule) · #684 (mixed snake/kebab stems) · **Project:** #578
**Depends on:** ARCH-0 (#677 — frees `templates/entity/new/backend/`) · ARCH-1 (#682 — deletes the clean-only
config surface; this PR bases on it)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) §4 · `docs/specs/ARCH-0.md`
§Decision 5 (proposed this rename and deferred it) · `docs/specs/NAME-0.md` · `docs/specs/NAME-1.md` ·
`docs/specs/ARCH-1.md`

## Why

Two leftovers from ARCH-0, both naming, both cheap now and expensive later.

**(a) `clean-lite-ps` names a choice that no longer exists.** The name distinguished one backend pipeline from
another; ARCH-0 (#677) deleted the other one. `generate.architecture` is an unknown-key error and
`git grep -nE "architecture|isClean" -- templates/` returns nothing. What is left is *the* backend pipeline,
wearing a comparative name, in a directory beside the empty slot the comparison used to occupy. ARCH-0 §Decision 5
recorded this verbatim and deferred it pending the owner's call; the owner called it (2026-09-20).

`prompt-extension.js` has the same problem one level down: `templates/entity/new/prompt.js` imports it
**unconditionally** — no architecture branch, no second extension anywhere in the tree. It does not extend
anything. It is the second half of the one prompt.

**(b) There is no file-naming rule — there is a convention typed by hand, ~18 times.** No emitted backend path is
produced by a case converter. Every one is raw interpolation of the snake_case YAML `entity.name` /
`entity.plural` into a template literal whose *hyphens are typed characters*:

```js
// templates/entity/new/clean-lite-ps/prompt-extension.js:1758-1780
findByIdUseCase: `${moduleDir}/use-cases/find-${entityName}-by-id.use-case.ts`,
listUseCase:     `${moduleDir}/use-cases/list-${entityNamePlural}.use-case.ts`,
outputDto:       `${moduleDir}/dto/${entityName}-output.dto.ts`,
listQueryDto:    `${moduleDir}/dto/list-${entityNamePlural}.query.ts`,
```

For a single-word entity the result is kebab-case **by accident**. For `deal_state` it is
`find-deal_state-by-id.use-case.ts` — the defect #684 names. `deal_state` is the only multi-word entity in any
fixture, which is why nothing has caught it.

### The state of "kebab-case" in this repo, measured on this base

| Where | Shape | Status on `dugshub/682-clean-config-surface` |
|---|---|---|
| `src/config/case-converters.mjs` | `splitWords`-based; `toKebabCase` / `toSnakeCase` / `toCamelCase` / `toPascalCase` / `applyCase` | **dead — zero importers.** ARCH-1 removed its last one when `paths.mjs` stopped reading `applyCase` |
| `src/cli/shared/orchestration-generator.ts:115` | `splitWords` + `toKebabCase` (same algorithm, TS) | **live** — orchestration pattern slugs, which name emitted files |
| `src/cli/shared/barrel-generator.ts:99` | local `toPascalCase` only, comment: *"intentionally local to avoid a dependency on case-converters.mjs from a TS module"* | live, identifier casing |
| `src/cli/shared/event-codegen-generator.ts:183` | local `toCamelCase`/`toPascalCase`, *"matches barrel-generator.ts convention"* | live, identifier casing |
| `templates/junction/new/prompt.js:36` | `kebabCase = (s) => s.replace(/_/g, '-')` — snake-only, wrong for camel/Pascal input | **dead** — `entityNameKebab` / `entityNamePluralKebab` are exported and read by **no** `.ejs.t` |
| `templates/relationship/new/prompt.js:32` | byte-identical copy | **dead** — same |
| the hand-typed hyphens above | not a function | what actually emits the names |

The duplication is *policy*, not accident: two TS modules say in comments that they keep private copies
specifically to avoid importing the `.mjs` converter. A rule the TS side refuses to import is not a rule — and
that is the root cause of #684. So the fix must **delete spellings**, and must live in a module every caller is
willing to import.

## The rule

> **The filesystem is kebab-case. The database is snake_case. TypeScript identifiers follow TypeScript
> convention.**
>
> Every directory and file stem **this generator emits** is kebab-case, derived by one function — the backend
> module tree, the junction and relationship trees, the frontend tree and the integration sinks and assemblies.
>
> Two kinds of name deliberately do not go through it:
>
> 1. **Database identifiers** — the `pgTable('…')` / `pgEnum('…')` argument, a column name, and the Drizzle table
>    export whose entire job is to mirror the SQL name.
> 2. **Paths into code this generator does not emit** — the frontend imports entity types from the consumer's own
>    db package (`frontend.dbEntitiesImport`, e.g. `@repo/db/entities/deal_state`). That file is named by its
>    owner, so the specifier keeps the entity's YAML name.

Applied to `entity: { name: deal_state, plural: deal_states }`:

| Kind | Before | After |
|---|---|---|
| module directory | `src/modules/deal_states/` | `src/modules/deal-states/` |
| entity / repository / service / controller | `deal_state.entity.ts` … | `deal-state.entity.ts` … |
| module file | `deal_states.module.ts` | `deal-states.module.ts` |
| use-case | `find-deal_state-by-id.use-case.ts` | `find-deal-state-by-id.use-case.ts` |
| DTO | `deal_state-output.dto.ts` · `list-deal_states.query.ts` | `deal-state-output.dto.ts` · `list-deal-states.query.ts` |
| **SQL table** | `pgTable('deal_states', …)` | **unchanged** |
| **table export** | `export const deal_states` | **unchanged** |
| **column** | `uuid('opportunity_id')` | **unchanged** |

The precedent is already in the tree: `templates/subsystem/auth/auth-oauth-state.schema.ejs.t:29` is a kebab-cased
file declaring `pgTable('auth_oauth_state', …)`. The subsystem templates already obey the rule; the entity
pipeline is the outlier.

**Why the directory goes kebab too, when it currently equals the table name.** The folder/table equality is a
mnemonic, not a contract — nothing reads the directory name back as an identifier (the table name reaches Drizzle
from `entity.plural`, never from the path). Keeping directories snake while stems go kebab would leave the
pipeline with *two* filesystem conventions and a rule that cannot be stated in one sentence, which is the
condition #684 was filed about. One rule, one sentence, or it drifts again.

## Charter invariants this PR touches

- **I1 declare once.** After this PR exactly one function decides the case of an emitted path segment, and one
  assembles a stem. The dead and duplicate spellings are deleted, not left beside it.
- **I2 generated means regenerated.** The baseline and the junction snapshots are regenerated, never hand-edited.
  The regeneration **is** the gate for (b).
- **I7 no backwards compatibility.** No alias for `buildCleanLitePsLocals`, no `clp*` local kept beside its
  replacement, no compatibility path emitting the old stems. Dead code found on the way is deleted, not left.
- **I9 gates are honest.** The new unit test pins the rule by **property**, not by listing today's filenames. Any
  defect found on the way gets its own issue (#697 already), never a filter.
- **I11 scope discipline.** **This PR edits I11 itself** — the invariant names `clean-lite-ps` as the in-scope
  pipeline. It becomes the backend pipeline, `templates/entity/new/backend/`.

## Design

### 1. `src/config/file-naming.ts` — the casing rule, beside the two rules it completes

`src/config/` now holds two shipped, `.ts`, template-importable rule modules, both created by this project:

- `module-tree.ts` — *where* an entity's module lives.
- `junction-naming.ts` (ARCH-1, #678) — *what a junction is called*: `<left>_<right>` and `pluralize(name)`. Both
  outputs are **database identifiers** (the table name and the name the table is derived from).

`file-naming.ts` is the third and completes them: given a name, *how does it become a path*. `junction-naming.ts`
needs no change — it keeps producing snake, and `file-naming.ts` is what turns that into a folder.

```ts
/** The one kebab primitive: handles snake_case, camelCase, PascalCase and kebab-case input. */
export function kebab(name: string): string;

/** A directory segment: `deal_states` → `deal-states`. */
export function emittedDir(name: string): string;

/** A file stem from ordered segments: ('find', 'deal_state', 'by-id') → 'find-deal-state-by-id'. */
export function emittedStem(...segments: string[]): string;
```

**It is `.ts`, not `.mjs`, and that is the whole point.** `case-converters.mjs` has the right algorithm in a
module kind the TS side refuses to import. `module-tree.ts` is the working precedent for the opposite — a `.ts`
module imported by both the TS generators and the `.mjs` hygen prompts (`templates/_shared/entity-naming.mjs`
imports `../../src/config/module-tree.js`). `file-naming.ts` follows it.

**`case-converters.mjs` is deleted.** It has zero importers on this base (ARCH-1 took the last one). Its
`splitWords` algorithm moves into `file-naming.ts`; its `applyCase` / `getCaseSeparator` served the
`naming.fileCase` surface ARCH-1 deleted and die with it (I7 — dead code is deleted, not parked).
`orchestration-generator.ts` drops its own `toKebabCase` and imports `kebab`, because its pattern slugs name
emitted files and are therefore the same question. Its `toPascalCase` / `toCamelCase`, and the local helpers in
`barrel-generator.ts` / `event-codegen-generator.ts`, are **identifier** casing for other domains and stay — out
of scope here (see §5).

Net: kebab implementations go **3 live + 3 dead → 1**.

**`package.json` `files` must list it.** `.ts` modules ship individually (`"src/config/module-tree.ts"`,
`"src/config/junction-naming.ts"`, …) while only `src/config/*.mjs` is globbed, so a new `.ts` module the
templates import is **absent from the tarball** unless added. That is silent from a checkout and is exactly the
#190 class; `just test-post-publish` is the gate that catches it, and
`src/__tests__/templates/files-manifest-coverage.test.ts` should too.

### 2. `module-tree.ts` applies the rule — the choke point for directories and three named files

`entityModuleNaming` is already the single source for `moduleDir`, `entityFile`, `moduleFile` and
`repositoryFile`, read by the hygen prompts, the barrel generator and the assembly emitter — so applying the rule
*inside it* fixes all three readers at once, which is why the function exists (charter I1).

```diff
 export function entityModuleNaming(entity: ModuleTreeEntity, modulesDir: string): EntityModuleNaming {
 	const plural = entity.plural || pluralize.plural(entity.name);
-	const moduleDir = entity.context ? `${modulesDir}/${entity.context}/${plural}` : `${modulesDir}/${plural}`;
+	const dir = emittedDir(plural);
+	const moduleDir = entity.context ? `${modulesDir}/${emittedDir(entity.context)}/${dir}` : `${modulesDir}/${dir}`;
 	return {
-		plural,
+		plural,            // UNCHANGED — the SQL table name and the Drizzle export, not a filesystem name
 		moduleDir,
-		entityFile: `${moduleDir}/${entity.name}.entity`,
-		moduleFile: `${moduleDir}/${plural}.module.ts`,
-		repositoryFile: `${moduleDir}/${entity.name}.repository.ts`,
+		entityFile: `${moduleDir}/${emittedStem(entity.name)}.entity`,
+		moduleFile: `${moduleDir}/${emittedStem(plural)}.module.ts`,
+		repositoryFile: `${moduleDir}/${emittedStem(entity.name)}.repository.ts`,
 	};
 }
```

**`plural` is deliberately untouched.** `entity.ejs.t` uses it for both the `pgTable` argument and the exported
table identifier. Kebabbing it would rename the SQL table — a database migration, not a file rename, and not what
#684 asks for. This is the one field where the two conventions meet, and its comment now says so.

### 3. The open-coded stems route through `emittedStem`

| Site | Stems | Change |
|---|---|---|
| `templates/entity/new/backend/entity-locals.js` (`outputPaths`, ~`:1751-1803`) | ~15 | `` `find-${entityName}-by-id` `` → `emittedStem('find', entityName, 'by-id')` |
| `templates/junction/new/prompt.js` (`resolveOutputPaths`, `resolveParentPaths`) | 2 | the `service` / `module` stems built beside `entityModuleNaming`'s |
| `templates/relationship/new/prompt.js` | ~12 | **and** it stops hand-rolling `` `${modulesDir}/${entityNamePlural}` `` and calls `entityModuleNaming` — NAME-0's rule, missed at this one site |

The two dead `kebabCase` helpers and their four unused locals (`entityNameKebab`, `entityNamePluralKebab` in both
prompts) are deleted — a wrong-by-construction kebab sitting next to the new correct one is precisely the trap
#695 warns about.

### 4. The rename, mechanically

| What | From | To |
|---|---|---|
| template dir (23 files) | `templates/entity/new/clean-lite-ps/` | `templates/entity/new/backend/` |
| the prompt's second half | `clean-lite-ps/prompt-extension.js` | `backend/entity-locals.js` |
| its export | `buildCleanLitePsLocals` | `buildBackendLocals` |
| ~28 locals | `clpOutputPaths`, `clpApiEnabled`, … | `outputPaths`, `apiEnabled`, … — bare, there is no second pipeline to disambiguate from |
| ~~junction injects (14)~~ | — | **Already gone.** JUNC-0 (#678) replaced the parent injects with a fan-out rendered by the parent's own templates, so the 14 `-clp-` files #695 lists do not exist on this base. |
| unit tests (21 files) | `src/__tests__/clean-lite-ps/` | `src/__tests__/backend/` |
| one test file | `templates/integration-source-clean-lite-ps.test.ts` | `…-backend.test.ts` |

All moves use `git mv`.

**Historical text keeps the old name.** CHANGELOG entries, `docs/adrs/**`, `docs/specs/**` (including ARCH-0
§Decision 5, the record of why this PR exists), the self-labelled-historical `docs/relationship-pattern-audit.md`,
`.ai-docs/**`, and `ai-docs/specs/a6-clean-lite-ps-templates.md` (the spec that created the pipeline) are records
of the past and are not rewritten. Two test literals also stay: `path-defaults.test.ts` and `schema-v2.test.ts`
assert `'clean-lite-ps'` is a **rejected** config value — they pin the retirement and must keep naming it.

Live references renamed: `CLAUDE.md` · `README.md` · `justfile` · `.claude/skills/{codegen,dev-companion,
integration,openapi}/SKILL.md` · `consumer-skills/codegen/SKILL.md` · `docs/CONSUMER-SETUP.md` ·
`src/cli/commands/entity.ts` (user-visible `--help`) · `test/run-test.ts` and `test/smoke/run-smoke.ts`
(user-visible log lines) · the charter's **I11** · ~25 stale doc comments in `src/`. Two already-stale-since-ARCH-0
lines are fixed in passing: `.claude/agents/team/architect.md` ("Two template pipelines") and
`no-v1-relations-emission.test.ts` ("all three backend pipelines").

**Completeness is checked by grep, not by inventory:** after the rename, `git grep -niE "clean[-_ ]?lite[-_ ]?ps|\bclp[A-Za-z]*|-clp-"`
must return hits only in the historical set named above.

### 5. What this implies for the eventual user-chosen layout

The owner's direction is that a consumer eventually chooses their own file layout. This PR is the naming half and
deliberately constrains that feature:

1. **Casing is not a layout knob.** ARCH-1 deleted `naming.fileCase` — the configurable case surface only the
   dead `clean` pipeline ever read. This spec does not bring it back in another shape. A layout feature chooses
   *where files go and how they are grouped*; it does not choose whether `deal_state` is spelled with a hyphen or
   an underscore. One project-wide convention is what makes generated imports predictable and what makes the
   property test in §Gates possible at all.
2. **There is now exactly one seam.** Before this PR a layout feature would have had to intercept ~18 hand-typed
   literals across three prompt files. After it, `emittedDir` / `emittedStem` decide every segment and
   `entityModuleNaming` decides every directory — a layout feature hooks two functions and inherits correct casing.
3. **The stem vocabulary is data, not prose.** `emittedStem('find', name, 'by-id')` states a name's *parts*. A
   layout wanting `use-cases/find-by-id.ts` (entity implied by the folder) reorders segments at one call site
   instead of rewriting a literal.
4. **The one thing a layout must not touch is `plural`** — the SQL table name, the only field in
   `EntityModuleNaming` that is not a filesystem fact. Its comment now says so.
5. **Identifier casing is a separate, still-open axis.** This rule governs paths only. TypeScript identifiers are
   still cased by four local helpers across `orchestration-generator.ts`, `barrel-generator.ts` and
   `event-codegen-generator.ts`, and #697 records a place where a snake_case plural reaches a **method name**
   (`async deal_statesList(`). A layout feature does not need that settled; an identifier-naming rule would be its
   own NAME-3.

## Gates

**The baseline regeneration is the gate for (b).** `deal_state` is the only multi-word entity in the fixtures, so
(b)'s entire observable effect lands in one module and is fully reviewable.

Expected snapshot classes, each explained in the PR body:

1. **`test/baseline/**/modules/deal_states/` → `deal-states/`** — 15 files: the directory, 4 pure-snake stems
   (`deal_state.{entity,repository,service,controller}.ts`), the module file, 4 DTO stems, 5 use-case stems, and
   `index.ts` (moves with the directory, content unchanged).
2. **Import lines inside those files and anything importing them** — `./deal_state.repository` →
   `./deal-state.repository`. Content-only churn in the same files.
3. **No other baseline entity moves.** `accounts`, `contacts`, `deals`, `opportunities`, `organizations`,
   `persons`, `tenants`, `users` are single-word, so `kebab(x) === x`. They must be **byte-identical** — a diff
   there means the rule is wrong.
4. **`export const deal_states = pgTable('deal_states', …)` is unchanged** inside `deal-state.entity.ts` — the
   proof the database half held.
5. **Junction snapshots** (10 keys) — all re-key on (a), because the keys carry `(clean-lite-ps)` from the
   `describe` string; bodies move on (b) only where a multi-word junction name appears.

**New unit test, pinning the rule by property** (`src/__tests__/config/file-naming.test.ts`): for a multi-word
entity, **no path segment of any emitted path may contain `_`**, asserted over the complete entity, junction and
relationship path sets. That is airtight against a stem added by hand later, which listing today's expected
filenames would not be. The converse case asserts `plural`, the `pgTable` argument and the table export **are**
snake for the same entity.

Full run, after the last edit (charter I9): `bun run typecheck` · `bun run build` · `bun run test` ·
`just test-all` · `just test-integration` · `just test-post-publish` (the templates ship **and** `file-naming.ts`
must reach the tarball, so the rename is proven from an installed package, not only from the checkout).

**Harness, shared host.** Gates run under a private `TMPDIR` (`TMPDIR=$(mktemp -d) just test-all`) because
`bunx --bun hygen` populates a machine-wide `/tmp` cache (#691). The per-worktree compose project and derived port
that keep two concurrent `just test-integration` runs from sharing a container (#615) are **already on this base**
— `22f7dda` / `39f6bee`, cherry-picked by ARCH-1 — so this PR adds no harness commits of its own. A gate that goes
red as `ENOENT` under `bunx-0-hygen`, `network scaffold_default not found`, `Connection terminated unexpectedly`
or drizzle-kit `unresolved decisions` is re-run isolated before it counts as a finding, and the PR body says so.

## Risks

| Risk | Mitigation |
|---|---|
| A `clp*` local is renamed in `entity-locals.js` but missed in one of 23 template bodies | every body references its locals unguarded and `assertNoUndefinedLocals` (#638) throws on a missing one — a miss fails generation loudly in the baseline gate, not silently |
| `file-naming.ts` is missing from `package.json` `files` | invisible from a checkout; `just test-post-publish` is the gate, and it is in the required set |
| The junction `skip_if` at `_inject-parent-service-counterparty-*.ejs.t` keys on a literal import specifier, which the rule changes for multi-word entities | consumers regenerate (I7); a project generated across the change would double-inject. Called out in the CHANGELOG as the breaking half |
| Deleting `case-converters.mjs` breaks a reader I did not find | it has **zero** importers on this base (verified by grep); `src/config/*.mjs` in `files` means the tarball gate would catch a consumer-side reader |

## Found during implementation

1. **The 14 `-clp-` junction inject templates were already gone.** #695 lists them; JUNC-0 (#678) had already
   replaced the parent injects with a fan-out rendered by the parent's own service/module templates. Nothing to
   rename. The `-clp-` part of (a) was a no-op on this base.

2. **#697's cited paths were stale, and the defect had moved.** The snake_case *method* name was filed against
   `_inject-parent-service-clp-left.ejs.t:36`, which no longer exists. The same code now lives at
   `templates/_shared/junction-fan-out.mjs:136-137` (`listMethod: \`${counterpartyPlural}List\``), where the two
   neighbouring methods **do** case their names (`attach${counterpartyPascal}`), so one generated service gets
   `attachDealState()` beside `deal_statesList()`. The issue was corrected in place rather than left pointing at
   deleted files.

3. **A churn class the design did not predict: importers of a multi-word entity move too.** The spec said only
   `deal_states` would change. Three files under `modules/opportunities/` also changed — `opportunity` is
   single-word, but it `belongs_to` `deal_state`, so its import specifiers carry the renamed path. Obvious in
   hindsight, invisible when reasoning about "which entity's own files move". It is still one class (path churn,
   no behavior), and it is why the churn is 19 files rather than 15.

4. **Three cross-entity `importPath` sites and the EAV field-value stem were missed on the first pass, and the
   gates caught both.** `entity-locals.js` builds a target's specifier as `${resolved.importDir}/${target}.entity`
   in three places, and four templates hardcoded `/field_value.service`. The first produced
   `'../deal-states/deal_state.entity'` — kebab directory, snake stem — in the regenerated baseline; the second
   failed the EAV unit tests. Both are the reason the baseline regeneration is the gate for (b) rather than a
   formality: a rule applied at *most* call sites reads as working right up until a multi-word name reaches the
   one that was missed.

5. **The smoke harness recomputed the naming rule instead of importing it.** `run-smoke-junction.ts` derived
   `<modules>/<plural>/<name>.entity.ts` with its own pluralizer, so it asserted the pre-rule paths. It now
   imports `emittedDir` / `emittedStem` from `src/config/file-naming.ts`, so the harness and the generator cannot
   disagree about the rule — the same I1 argument that put the rule in `module-tree.ts` rather than in each prompt.

6. **`case-converters.mjs` was dead, not just duplicated.** ARCH-1 removed its last importer along with
   `naming.fileCase`; only its own docstring and two comments explaining why TS modules avoid it still referred to
   it. Deleted (I7) rather than extended, and `orchestration-generator.ts` — whose pattern slugs name emitted
   files — now re-exports the shared rule instead of keeping a private copy.

7. **The rule's universal claim was false in two more pipelines — found in review.** The first implementation
   routed the hygen pipelines and stopped there, while `file-naming.ts` and this spec claimed *every* emitted stem
   went through the rule. The frontend emitter (`emit-api` / `emit-collections` / `emit-entities` / `emit-fields`
   and the barrels and store imports that reference them) and the integration emitter (sink base, sink subclass,
   change emitter, assembly module and the three specifiers that import them) still built raw `${entity.name}`
   stems, so `deal_state` would have emitted `api/deal_state.ts` beside `modules/deal-states/deal-state.entity.ts`
   — internally consistent, and exactly the extra spelling #684 exists to kill. **Twenty sites routed**, not the
   eight the review counted: the file writes are the visible half, the barrels and cross-file imports that must
   move with them are the other.

   The fix is the registry, not the call sites: `EntityRegistryEntry` now carries `fileStem` / `pluralFileStem`
   beside `className` / `camelName`, so every generator reading the registry gets the emitted spelling the same
   way it already gets the class name (I1). The frontend had **no multi-word entity in its golden fixture**, so
   `kebab(x) === x` made the whole tree pass either way — `test/frontend-golden/entities/deal_state.yaml` is now
   the one fixture there that can fail, and the golden test asserts no emitted path contains `_`.

   It also forced the rule's second boundary into the open: the frontend imports entity types from the
   *consumer's* db package (`@repo/db/entities/deal_state`). That file is named by its owner, not by this rule, so
   the specifier keeps the YAML name — the claim in §The rule is narrowed to say so rather than left overstated.

8. **Environment, not code: a fresh worktree has no `node_modules`.** Worktrees live *inside* the main checkout,
   so resolution walks up and silently finds the parent's — which tracks another branch. The baseline typecheck
   failed on `@nestjs/swagger` and a drizzle version mismatch **before any edit**, and the control run on a clean
   base branch failed identically, which is what identified it. `bun install` in the worktree fixed it. Worth
   knowing because it reads exactly like a real regression.
