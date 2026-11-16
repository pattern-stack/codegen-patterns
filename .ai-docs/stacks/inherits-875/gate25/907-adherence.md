## Gate 2.5 — Adherence (lens=adherence) · PR #907 @ 4d0589c9

**Against:** RFC-0006 §12 (A1, the item this PR closes) + §13.2 S1 (plan, "S1 as built", phase R, phase R2)
**Verdict:** REVISE

Reviewed tip: the worktree's `e6316ff3`, which is patch-identical to the PR head `4d0589c9`. `git range-diff` shows
`=` on all six commits; the PR head is the same series rebased onto `main` @ `3c422b91`. Diff base: the merge-base
with `origin/main`. The round-1 resolutions posted on the PR were re-checked at this tip (run-level refusal, the
`ParsedEntity` validator, the type-compared M2, the derived columns, the per-pattern R6, the resolved R8, R7 over
search queries). Each one holds. The findings below are new.

### Blockers
None.

### Should-fix
1. `src/patterns/library/activity.pattern.ts:51` — `activityColumnsRead` omits `user_id`, which
   `ActivityEntityRepository.findByUserId` reads unconditionally (`runtime/base-classes/activity-entity-repository.ts:91`,
   `this.col('userId')`). The function's own doc says it lists "the columns `ActivityEntityRepository` reads". The
   RFC's as-built R6 bullet (`RFC-0006:1145-1148`) repeats the same two-column list. So R6 (§1.2: "a pattern … is
   declared on the table that owns its columns") misses one column the pattern reads.
   **Scenario** (verified with a scratch probe against `validateInheritance` + `familyWith`): `communication` declares
   `user_id: { type: uuid, required: true }`; `meeting` declares `patterns: [Activity]` with
   `config: { Activity: { occurredAt: starts_at } }`. The result is `[]`, with no R6 error. Once S2+ generates the
   child, `meetingRepository.findByUserId(...)` throws at runtime, because `col()` throws on a column the table does
   not have (`base-repository.ts:327`).
   **Fix:** return `user_id` from `activityColumnsRead`. `baseOnly()` fires only when the base owns the column and
   the child does not, so an entity with no `user_id` anywhere gets no new false positive. Add an R6 case for it, and
   correct the as-built R6 bullet's column list.

2. `src/patterns/library/metadata.pattern.ts:14` and `src/parser/validate-inheritance.ts:319-322` — a pattern with no
   `columnsRead` reads as "reads no columns", so R6 passes it whatever it reads. `MetadataEntityRepository` reads the
   fixed columns `entity_id` and `entity_type` (`runtime/base-classes/metadata-entity-repository.ts:85-86, 96, 104`).
   The as-built note says "only a pattern that declares `columnsRead` is checked (today, `Activity`)". That reads as
   if Activity is the only pattern whose repository reads columns, and it is not. This is CLAUDE.md's
   "absent input must not default to permissive" shape.
   **Scenario** (verified with the same probe): `communication` declares `entity_id` and `entity_type`; `meeting`
   declares `pattern: Metadata`. The result is `[]`. R4 forbids the child from redeclaring either column, so the
   child's `findByEntityIdAndType` / `listByEntityId` read columns its table can never have.
   **Fix:** give `MetadataPattern` a `columnsRead: () => ['entity_id', 'entity_type']`, add an R6 case, and reword the
   as-built note so it does not imply Activity is the only column-reading pattern. Also update §1.3 (`RFC-0006:156-157`,
   "Config that names a base field is an error naming the base"). As built, R6 compares the columns a pattern *declares
   it reads*, not config strings. §1.3 should say that, so the two sections of the RFC agree. (Optional, stronger: make
   `columnsRead` required on every pattern that has a `repositoryClass`, so the next pattern cannot opt out by
   omission.)

### Nits
3. `src/__tests__/parser/validate-inheritance.test.ts:303` — the test named "R6: a string in config that merely equals
   a base column name is not a column read" has the body `{ occurredAt: 'starts_at' }`. That is the same body as the
   next test (`:315`, "Activity on a child over its own column is fine"), and `starts_at` is not a base column. The
   behaviour the name claims, and the as-built "Config strings are not compared", is never exercised.
   **Scenario:** a regression that compared config strings to base columns would keep this test green.
   **Fix:** use a config string that equals a base column but is not a column read. For example,
   `{ occurredAt: 'starts_at', subject: 'source' }`: the base owns `source`, the pattern reads `source_id`, and the
   probe returns `[]`, as intended.

4. `src/schema/inheritance.ts:179-181` — `eav_value_table: true` is refused on a **child** only, with the message
   "EAV is refused in a family in v1 (R9)". On a **base** it is accepted. R9 (§1.2) names only `eav: true` and
   `pattern: Junction`, and §8's refusal list does not mention `eav_value_table` at all. So the code holds a refusal
   the RFC does not record, and labels it with a rule whose scope ("anywhere in a family") it does not apply.
   **Scenario:** `communication` with `eav_value_table: true, eav_definition_table: …` passes the schema, while the
   same key on `meeting` fails as "R9".
   **Fix:** either apply it family-wide under R9 and add it to R9's row and the as-built note, or record it in §8 as
   a child-only refusal and drop the "(R9)" label.

5. `src/index.ts:111-113` — this comment says the validator runs "from the definitions: `ParsedEntity` does not
   carry these keys". The call passes `ParsedEntity[]`, and this PR adds the keys to `ParsedEntity`. That is the
   as-built's own point ("The validator reads `ParsedEntity` … carried onto it"). Likewise, the header of
   `src/schema/inheritance.ts:5-9` says "Both halves read the declaration shape through the helpers below". The
   cross-entity half imports none of them: it keeps its own `columnNotNull` / `declaresColumn` over `ParsedEntity`
   (`validate-inheritance.ts:150, 163`), and the exported `declaresColumn` in `inheritance.ts:48` has no caller.
   **Fix:** correct both comments, and drop the unused export.

6. `RFC-0006:968` (§10 row 2), `RFC-0006:142-144` (§1.2's closing paragraph), and the PR body ("Cross-entity rules
   R1–R11 and M1–M5 live in `src/parser/validate-inheritance.ts`") — all three still give the pre-build placement.
   As built (§13.2, `:1126-1135`), R5, R9 and R11, R1's and R3's own-file halves, §8 and M1's belongs_to half are a
   Zod refinement in `src/schema/inheritance.ts`. Only the §13.2 bullet says so.
   **Fix:** point §10 rows 1–2 and the §1.2 paragraph at `src/schema/inheritance.ts` and `validate-inheritance.ts`,
   and correct the PR body.

7. `src/parser/validate-inheritance.ts:177` — `options.syncMode ?? 'electric'` restates the config default.
   `src/index.ts:117` passes `opts.syncMode` raw, though its option doc says "Absent: the config default", and the
   line above it resolves `tenancyColumn` through `TenancyConfigSchema`. The as-built says "the project mode reaches
   the validator as an option (`syncMode`, from `ctx.config.frontend`, as `tenancyColumn` does)". Today every caller
   passes the mode, so nothing misbehaves.
   **Fix:** resolve it in `analyzeDomain` with `FrontendConfigSchema`, as `tenancyColumn` is resolved, and make the
   validator's option required. Then the default has one owner.

8. `src/__tests__/cli/inheritance-refusal.test.ts:118-125` — the test is named "a directory without the family
   generates, barrels included", but it asserts only `email-thread.entity.ts`. The negative test at `:99-109` asserts
   `src/generated/schema.ts` and `relations.ts` are absent. Without a positive control, nothing in the file proves
   those are the paths the barrels are written to. (They are today: `paths.generated` defaults to
   `<backend_src>/generated`, and `barrel-generator.ts:312-319` writes there.)
   **Fix:** in the positive test, assert that `src/generated/schema.ts` and `src/generated/relations.ts` exist.

### Checked and fine
- **A1, the keys:** `inherits` (short and long form, `.strict()`), `discriminator`, `match` (map, or list shorthand
  expanded at `load-entities.ts:182-188`), `natural_key`, and `choices_of` (regex, enum-only, exclusive with
  `choices`/`choices_from`). Tests: `inheritance-schema.test.ts` "the keys" block. `checks:` is an unknown key
  (OQ-11), tested.
- **A1, each rule fails naming the entities:**
  - **R1:** schema `:80-112`; cross-entity `validate-inheritance.test.ts:54-128`.
  - **R2:** `:130-152`.
  - **R3:** schema `:114`; cross-entity `:154-175`.
  - **R4:** `:177-255`, including match- and role-derived columns.
  - **R5:** schema `:121-144`, including the object form and pattern-implied behaviours.
  - **R6:** `:257-324`, Activity only; see findings 1–2.
  - **R7:** `:326-358`, including search `filters`/`search`.
  - **R8:** `:360-397`, resolved modes.
  - **R9:** schema `:146-168`.
  - **R10:** `inheritance-tenancy.test.ts:43-58` and `validate-inheritance.test.ts:399-443`.
  - **R11:** schema `:197-251`, including `where` and undeclared columns.
  - **M1–M5:** `:445-686`, including the type-compared M2 exception, a child's derived columns, and the M4 static
    corollary (`set_null`).
- **§8 refusals on a child:** `Integrated`, `surface`, `integration`, `detection`, a declared `id`, and a non-uuid
  base `id`. Schema test `:170-195`.
- **Generation refusal (as built):** a run-level rejection in `preflightEntityTargets`
  (`entity-render.ts:219-238`). It covers `--all`, a single target, a plain entity in the same directory, and
  `--continue-on-error`. `junction new` sees it too (`junction.ts:249-258`; the file filter there only drops junction
  files). `natural_key:` alone is byte-identical (`inheritance-refusal.test.ts:143`), with a non-vacuity guard (`> 5`
  files).
- **`analyzeDomain`** runs `validateInheritance`, so `entity validate` and every `project` command that analyses get
  the same cross-entity errors. All four `analyzeDomain` callers pass `syncMode`.
- **Child tenancy:** `resolveChildTenancy` / `baseTenantColumnIssue` / `lifecycleBehaviorsDeclared` are in
  `src/schema/tenancy.ts`, as the as-built says. `resolveChildTenancy` has no S1 caller, but S2's
  `templates/_shared/inheritance.mjs` and S6's `build-graph.ts` consume it, so it is not dead across the stack.
- **The fixture family** matches §13.1 and §7 entity for entity: both bases, three children, the two plain entities,
  the lookup and the participant with two `match:` on one column, and `message` as a base-only kind. Names are
  generic.
- **Scope (§13.2 "Must not touch"):** the diff touches no file under `templates/`, `runtime/` or `src/emitters/`, and
  no `test/baseline/` snapshot. Every file outside the S1 "Touches" list is named by the as-built note, except
  `package.json`. That change is one `files` entry, `src/schema/inheritance.ts`, which the shipped schema now
  imports; it is necessary for the tarball, and its siblings `field-nullability.ts` and `tenancy.ts` are already
  listed.
- **ADR-046 phase R / R2 notes:** accurate. S1 adds no template, `entity-locals.js` or derivation change.
- **The editor JSON schema** gains all five keys (`entity-definition.schema.json`, `natural_key` at `:353`). Its
  generator now imports `zod/v4`, as stated.
