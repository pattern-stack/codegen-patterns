## Gate 2.5 — Quality (lens=quality) · PR #907 @ 4d0589c9

**Against:** CLAUDE.md + quality canvas + reuse/layering
**Verdict:** REVISE

The remote tip `4d0589c9` is a rebase of the local `e6316ff3` onto `origin/main` `3c422b91`. `git diff origin/main...<tip>` is
byte-identical for the two, and `src/` + `test/` do not differ between them, so every `path:line` below holds at both.
The probes cited below were run as scratch `bun test` files outside the repo, through the PR's own `familyWith`
helper. Nothing in the worktree was written.

Two of the four should-fix findings are correctness: R6 and R4 each accept a family that should be refused. The other
two are second copies of rules that already have an owner.

### Blockers
None.

### Should-fix
1. `src/parser/validate-inheritance.ts:316-322`, `src/patterns/library/activity.pattern.ts:51-54`. **R6 falls open:** a
   pattern with no `columnsRead` counts as reading nothing, and `Activity`, the only pattern that has one, leaves out a
   column it reads. Three gaps:
   - (a) `activityColumnsRead` omits `user_id`, which `ActivityEntityRepository.findByUserId` reads unconditionally
     (`runtime/base-classes/activity-entity-repository.ts:91`).
   - (b) `Metadata` reads `entity_id`, `entity_type` and `valid_from` (`runtime/base-classes/metadata-entity-repository.ts:85-105`)
     and declares no `columnsRead`.
   - (c) `CapabilityPatternDefinition` has no `columnsRead` field at all. The `'columnsRead' in definition` guard skips
     every capability without saying so.

   Both column defaults, `occurred_at` and `<subject>_id`, are now stated twice: `activity.pattern.ts:52-53` and
   `activity-entity-repository.ts:55,69`. (Canvas: `convenient_fallback`; CLAUDE.md gate rule (c), an absent input must
   not default to permissive.)

   **Scenario (probed):** the fixture, with `communication.fields.user_id: { type: uuid, required: true }` added and
   `meeting` declaring `patterns: [Activity]` with `config: { Activity: { occurredAt: starts_at } }`. `validateInheritance`
   returns `[]`. Once S2+ generates, the child's `findByUserId` throws at call time from `col('userId')`, because
   `user_id` is on the base table. The same holds for `meeting` declaring `pattern: Metadata` against a base that owns
   `entity_id` / `entity_type`: the result is `[]`.

   **Fix:**
   - Add `user_id` to Activity's list, and give `Metadata` a `columnsRead`.
   - Add `columnsRead` to `CapabilityPatternDefinition`.
   - Fail closed: a child that declares a pattern (other than `Base`) with no `columnsRead` is an R6 error naming the
     pattern. **DECISION:** this reverses the as-built note "only a pattern that declares `columnsRead` is checked
     (today, `Activity`)".
   - Move the Activity column defaults into one dependency-free helper. The repository getter and `activityColumnsRead`
     both call it.

2. `src/schema/inheritance.ts:40-45` and `src/parser/validate-inheritance.ts:316`. These are a **third and fourth copy
   of `declaredPatternNames`**. The owner is `src/patterns/compose.ts:68`, exported from `src/patterns/index.ts`. A
   private copy also sits in `src/patterns/implied-behaviors.ts:28`. `src/schema/tenancy.ts` already imports from
   `src/patterns/`, so no new layer edge is needed. The copies already differ: `compose.ts` returns `patterns` when it
   is non-empty, else `pattern`, while the new one concatenates both.

   **Scenario:** the two agree today only because the schema keeps `pattern:` and `patterns:` mutually exclusive.
   Relax that rule, or add a third declaration form, and R9's Junction/Integrated checks see a different pattern list
   from the one composition resolves.

   **Fix:** import `declaredPatternNames` from `src/patterns/compose.js` in both files and delete the new copy.

3. `src/parser/validate-inheritance.ts:41,177` and `src/index.ts:44,117`. **The sync-mode default is a second copy.**
   The validator hard-codes `'electric'` "(the config default)", which restates
   `FrontendSyncConfigSchema.mode.default('electric')` (`src/schema/codegen-config.schema.ts:261`). `analyzeDomain`
   passes `opts.syncMode` through raw, yet its two sibling options route through their config schema, "the one owner of
   the default" (`src/index.ts:41,45,116`). R8 also restates `resolveSyncMode` (`src/emitters/frontend/types.ts:148`)
   inline at `:358-359`. (Canvas: `magic_constants`.)

   **Scenario:** the config default moves to `api`. Then `analyzeDomain(dir)` (exported package API), called without
   `syncMode`, resolves every undeclared entity to `electric` for R8, while the emitter resolves the same entity to
   `api`. R8 reports a mismatch the emitted code does not have, or misses one it does.

   **Fix:** in `analyzeDomain`, pass `FrontendSyncConfigSchema.parse({ mode: opts.syncMode }).mode`. Make `syncMode` and
   `tenancyColumn` required on `ValidateInheritanceOptions`, so no caller can fall into a literal.

4. `src/parser/validate-inheritance.ts:94-115`. `implicitColumns` is a **third statement of "the columns a table gets
   besides its declared fields", and it misses pattern-contributed columns.** The rule already lives in two places:
   - `validatePatternComposition`'s column-source table (`src/patterns/validate-composition.ts:78-166`), which covers
     fields, behavior fields and pattern `columns:`;
   - `reservedColumnOwner` (`src/schema/tenancy.ts:107`).

   The new copy leaves out `PatternDefinition.columns` contributions, so R4 and M2 cannot see them.

   **Scenario (probed):** register a pattern that contributes `display_name`, declare it on `communication`, and add a
   field `display_name` to `meeting`. `validateInheritance` returns `[]`, and per-entity composition on `meeting` also
   returns `[]`. Generated DTOs and flat rows would then merge two `display_name` columns. M2 has the same hole: a
   `match:` local column named like a pattern-contributed column is not reported as taken.

   **Fix:** write one exported helper that returns a table's columns with their origin: fields, FK columns, behavior
   fields including implied ones, pattern contributions, and the tenant column. Composition, tenancy and this validator
   all read it.

### Nits
1. **Dead code.**
   - `declaresColumn` (`src/schema/inheritance.ts:48`) has no caller in this PR or at the stack tip
     (`dugshub/875-s6-inherits-frontend`).
   - `ParsedEntity.naturalKey` (`src/analyzer/types.ts:269`, set at `src/parser/load-entities.ts:141-142`) is never read,
     here or at S6. The later slices read `natural_key` from the raw YAML (`naturalKeyIndexOf`, `entity-locals.js`).

   Delete both, or point the later readers at `naturalKey`.
2. **Two functions are each defined twice under one name.** `columnNotNull` is at `src/schema/inheritance.ts:56` (raw
   YAML) and `src/parser/validate-inheritance.ts:150` (`ParsedEntity`). `declaresColumn` is at `:48` and `:163`. The
   schema file's header (`:5-8`) says both halves read the shape "through the helpers below, so … is stated once". That
   is true only of `inheritsOf`. Correct the header, or give the two models one lookup.
3. **Stale comments.**
   - `src/index.ts:111-113` says the validator runs "from the definitions: `ParsedEntity` does not carry these keys".
     It runs over `ParsedEntity`, which this PR makes carry them.
   - `src/parser/load-entities.ts:99-101` says search queries are "consumed directly by the codegen templates, not by
     the analyzer". `ParsedEntity.searchQueries` (`:113-115`) now feeds R7.
4. **`BASE_ONLY_BEHAVIORS` is a hand-written list.** At `src/schema/tenancy.ts:183-188` it equals the whole behavior
   registry today. The R5 message restates it in prose at `src/schema/inheritance.ts:155`.
   - **Problem:** a fifth behavior is allowed on a child by default, and the message drifts from the list.
   - **Placement:** the rule lives in `tenancy.ts`, but it is not about tenancy.
   - **Fix:** render the message from the constant. Better, put the placement on each `BehaviorDefinition`, so a new
     behavior has to state it. `reservedColumnOwner`'s own doc (`tenancy.ts:102-106`) sets that standard: "names come
     from the behavior definitions".
5. **The R10 catch mislabels errors.** At `src/parser/validate-inheritance.ts:388-393` it prefixes any `resolveTenancy`
   throw with "R10 —", including a tenant column colliding with a behavior column and a non-uuid adopted field. Neither
   is R10. Report them without a rule number, or leave them to the tenancy check that owns them.
6. **A type escape on the pattern config.** `src/parser/validate-inheritance.ts:320-321` uses `'columnsRead' in
   definition` plus `as never` to pass the raw, unparsed `config:` to a function typed on the parsed config. Parse it
   through `definition.configSchema` first, as composition does (`validate-composition.ts:134`), and drop the cast.
   (Canvas: `convention_workaround`.)
7. **`order:` is re-parsed inline.** `src/parser/validate-inheritance.ts:340` splits the string itself. `parseOrder`
   (`src/derived/api/entity.ts:702`) is the derivation's statement of the same split, and there are two older copies
   (`templates/entity/new/backend/entity-locals.js:1233`, `templates/relationship/new/prompt.js:323`). Move one parser to
   the schema layer, where `order:` is defined, and share it. Do not import `derived/` into `parser/`.
8. **Two tests are weaker than their names.**
   - `src/__tests__/parser/validate-inheritance.test.ts:25`: `only()` asserts at least one error, not exactly one, but
     its name says "only".
   - `:149`, "R2: a choice with no child is a base-only kind", repeats the fixture-clean assertion from `:32`. It cannot
     fail on R2 alone.
9. **A negative assertion with no positive control** (CLAUDE.md gate shape (b)).
   `src/__tests__/cli/inheritance-refusal.test.ts:107-108` asserts that `src/generated/schema.ts` and `relations.ts` are
   absent. The positive control (`:118-125`) never asserts they exist at those paths, so if the default barrel location
   moves, the negatives pass without testing anything. Add both existence checks to the positive case, or resolve both
   paths through `projectLayout`.
10. **Regex copies.** `src/schema/entity-definition.schema.ts:23`'s `SNAKE_NAME_PATTERN` is a byte copy of
    `TENANT_COLUMN_PATTERN`, imported at `:2`. The `choices_of` regex at `:244` restates the pattern twice as a literal.
    Build it from the one constant. The file has many older copies; this PR adds two.

### Checked and fine
- **Run-level refusal.** The S2 refusal is run-level (`src/cli/shared/entity-render.ts:219-238`), so no barrel or
  manifest is written over a set that is missing modules. `--continue-on-error` does not lift it, and a plain entity in
  the same directory stops too (tests `:99-116`).
- **The `natural_key` byte-identity gate can fail on its own subject.** It compares whole `src/` trees and asserts more
  than 5 files (`inheritance-refusal.test.ts:143-164`).
- **Nullability.** It always goes through `fieldColumnNullable` / `foreignKeyColumnNullable`, with no inline
  re-derivation. `ParsedRelationship.nullable` is carried for declared and role-derived relationships
  (`load-entities.ts:180,238`).
- **Config inputs.** Every CLI caller takes them from the config schemas: `entity.ts:1156-1160`, `project.ts` ×3, and
  `entity-render.ts:226-229`. Tenant names come from `tenantColumnName` / `resolveTenancy`.
- **No emitted-code rules apply.** No template, emitter or derivation is touched, so the ADR-046 "templates print" rule,
  `globalThis.<Name>`, `emittedStem`, `sqlTableName` and `projectEntityLookup` are not engaged, and there is no inject
  template.
- **`inheritsOf` is the single owner** of the short and long forms, and the loader reads through it.
- **`resolveChildTenancy` and `matchPairs` are not dead.** They have production consumers later in the stack:
  `build-graph.ts` and `templates/_shared/inheritance.mjs` at S6.
- **Earlier round's items are fixed at this tip:** 1 (run-level rejection), 2 (M2 compares `sqlTypeKey`), 3 (the
  child's derived kind and tenant column), 4 (per-pattern `columnsRead`), 5 (resolved R8), 6/7 (role- and
  `match:`-derived columns), 8 (no swallow-all `catch {}` in `src/index.ts`), 12 (no `choices_of` advice for a non-enum
  target) and C1 (search queries in R7). Item 11 is only partly fixed; see nit 10.
- **No filtered error class, no directory carve-out, no narrowed spread.**
- **Public-repo rule:** the fixtures and messages carry no host-application names.
