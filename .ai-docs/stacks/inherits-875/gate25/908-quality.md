## Gate 2.5 — Quality (lens=quality) · PR #908 @ d7176186

**Against:** CLAUDE.md + quality canvas + reuse/layering
**Verdict:** REVISE

Reviewed `git diff dugshub/875-s1-inherits-schema...HEAD` in the S2 worktree at `d7176186`. The PR head on GitHub is
`e235a90d`, the same ten patches rebased onto a newer S1 tip (`git range-diff` marks all ten `=`), so every finding
below holds at the PR head too. Findings marked *(repro)* were confirmed by generating the fixture family
(`test/fixtures/inheritance/entities/`) with the real CLI into a scratch project.

### Blockers
None.

### Should-fix

1. `src/cli/shared/entity-render.ts:301-311`: **a counterpart rejection does not propagate past one hop.**
   *(repro)* The dependent-rejection loop reads `rejectedNames` but never adds to it, and it makes a single reverse
   pass. So a child is rejected with its rejected base, but that child's own children and `match:` referrers are
   not. `--continue-on-error` defaults to `true` (`src/cli/commands/entity.ts:259`), so this happens on a plain
   `entity new --all`.
   **Scenario:** the fixture family, with `emits: [no_such_event]` appended to `communication.yaml`.
   - `communication` is rejected for `emits:`.
   - `communication_part` (whose `match:` targets `communication`) is rejected with it.
   - `email_communication_part` and `transcript_communication_part` (which inherit `communication_part`) both
     print `[OK]` and are written. `email-communication-part.entity.ts` imports
     `../communication-parts/communication-part.entity` and `../communications/communication.enums`, and neither
     module was generated.

   This is the half run the loop's own comment says the pre-flight exists to prevent. Category: correctness.
   **Fix:** iterate to a fixpoint. On each rejection, call `rejectedNames.add(v.name)`, and repeat the pass until
   it rejects nothing. Add a case to `src/__tests__/cli/inheritance-ddl.test.ts` that puts an `emits:` error on
   `communication` and asserts that neither `email-communication-parts/` nor `transcript-communication-parts/` is
   written.

2. `templates/entity/new/backend/entity-locals.js:1099-1115` (C5), with `:1104` and
   `src/__tests__/backend/constraint-name-length.test.ts:2-7`: **the 63-byte gate does not see most FK names, but
   says it does.**
   - The comment says "Every emitted index, unique, FK and CHECK passes through here". The test header says
     "Every constraint passes through `assertDistinctConstraints`". In fact only the extra-config
     `tableConstraints` of entity tables pass through it.
   - Every single-column `belongs_to` / field `foreign_key:` FK is a `.references()`. Drizzle names those itself:
     `<table>_<cols>_<foreignTable>_<foreignCols>_fk` (`node_modules/drizzle-orm/pg-core/foreign-keys.js:53-63`).
   - Junction tables never call the check.

   *(repro)* The fixture family this PR adds already emits two such names over the limit:
   - `transcript_communication_parts_participant_id_communication_participants_id_fk` (78 bytes);
   - `transcript_communication_parts_transcript_id_meeting_transcripts_id_fk` (70 bytes).

   **Scenario:** Postgres truncates both names to 63 bytes, with only a NOTICE. The database then holds a
   constraint named something no generated file says. A 23503 on that FK reports a name the author cannot find,
   which is exactly the case the C5 docstring gives as its reason to exist. Round 1 #7 was closed as "every name";
   that closure does not hold. Category: a gate that cannot fail on its own subject.
   **Fix (`DECISION`):** either way, closing the gap changes behaviour outside this PR.
   - (a) Compute Drizzle's default name for every emitted `.references()`, and for the junction's constraints, and
     run them through the same check. This fails generation for existing long FK names, including the two above,
     whose fixtures would then need `entity.table:`.
   - (b) Emit every FK with an explicit `foreignKey({ name })`. This renames FKs across all generated schemas.
   - The minimum that needs no decision: narrow both claims to "every name the extra-config callback declares",
     and file the gap as an issue.

3. `src/cli/shared/entity-render.ts:114-118`, `src/parser/validate-inheritance.ts:521-526`,
   `src/schema/inheritance.ts:47-49`, test title `src/__tests__/cli/inheritance-ddl.test.ts:277`: **the stated
   reason for re-rendering a base with its child is false. This is the claim round 1 #9 closed as fixed.**
   - `entity-render.ts` says that rendering a child alone must re-render the base, "otherwise a newly added child
     leaves the base's table stale". `schema/inheritance.ts` says the base "carries the uniques the child's two
     composite FKs point at".
   - But `inheritanceFor` (`templates/_shared/inheritance.mjs:216-224`) builds the base's `unique(id, kind)` /
     `unique(id, tenant)` from the base's *own* discriminator and tenancy. *(repro)* `communications/` is
     byte-identical (ignoring the banner) whether or not any child exists.
   - `validate-inheritance.ts`'s doc now contradicts itself. Its first sentence says the base's table "depends on
     a rendered one's YAML, and so must be re-rendered with it". Its second paragraph says the base depends "NOT
     on its children".
   - The test at `:277` proves only that a hand-corrupted base file gets rewritten.

   **Scenario:** the next agent reads the dependency direction backwards, for example when adding S3/S4 readers or
   extending the counterpart set. Category: stale/incorrect documentation (CLAUDE.md "living documentation").
   **Fix:** state the real reasons for including the base. The child imports the base's table and `.enums`
   module, so the base must exist and validate; and a rejected base must reject the child. Rename the test to
   match. Or keep only the real re-render direction (a `match:` referrer brings its target) and leave the base in
   the rejection set only.

### Nits

4. `src/cli/shared/entity-render.ts:120-133`, `:279`: **the `counterpartSchemaRejections` branch is
   unreachable.** `allEntitiesForEmits` comes from `loadEntities`, which keeps only entities whose
   `loadEntityFromYaml` succeeded (`src/parser/load-entities.ts:386-392`). So re-parsing a counterpart cannot fail.
   *(repro)* A schema-invalid base is simply absent, and it surfaces as an R3 run rejection. That leaves dead code
   and a second parse of every counterpart. **Fix:** push `{ file: counterpart.sourcePath, name }` directly, and
   delete the `else` branch and `counterpartSchemaRejections`.

5. `src/cli/shared/entity-render.ts:308`: **the message prints a doubled quote:** "is rendered from
   `'communication''s` YAML". **Fix:** word it as "is rendered from the YAML of 'communication'".

6. `templates/_shared/inheritance.mjs:130`: **`matchReferrers` treats a lookup with no `.definitions` as "no
   referrers".** That undoes the strictness `lookup.definitions()` was given on purpose
   (`templates/_shared/entity-naming.mjs:72-85`: "would answer 'no referrers' for an entity it simply could not
   read, so it throws instead"). It is reachable when `entityLookup` is `null`, i.e. locals built by hand.
   **Scenario:** a base unit-tested without a lookup silently loses its `match:` uniques. Category:
   `convenient_fallback` (CLAUDE.md gate rule (c)). **Fix:** throw, as `requireDefinition` does, and give the
   hand-built-locals helpers `entityLookupFrom([])`.

7. `templates/entity/new/backend/entity-locals.js:2218-2302`: **the RFC-0006 constraint block re-derives what the
   function already holds.**
   - `propOf` is an alias of `camelCase`, and `:2261` then calls `camelCase(rel.field)` / `camelCase(l)` directly.
     Meanwhile `rel.camelField` exists, and `propByColumn` (`:1032`) is built from `entityTableColumns`, which this
     PR extended with `extraColumns` for exactly these columns.
   - The child's tenant index (`:2276-2285`) is a second copy of the tenant-index entry at `:2175-2182`.
   - `:2302` is mis-indented.

   **Fix:** read `rel.camelField` and `propByColumn`, and build the tenant index through one helper.

8. `templates/entity/new/backend/entity-locals.js:1090` vs `src/schema/entity-definition.schema.ts:1420`: **the
   Postgres identifier limit has two owners**, a bare `.max(63, …)` that counts characters and
   `PG_IDENTIFIER_MAX_BYTES` that counts bytes. Category: `magic_constants`. **Fix:** export one constant (for
   example beside `sqlTableName` in `src/config/table-naming.ts`) and read it in both places.

9. **Stale fixture header, copied.** Four copies say "Loaded by unit tests, never generated from.":
   - `test/fixtures/inheritance/entities/communication.yaml:3`, which `inheritance-ddl.test.ts` now generates
     from;
   - `test/fixtures/entities/communication.yaml:3`;
   - `test/smoke/fixtures/communication.yaml:4`;
   - `test/scaffold/entities/communication-scaffold.yaml:4`.

   The last three exist only to be generated from. **Fix:** delete the sentence.

10. **Four committed copies of the family, held equal by `src/__tests__/fixtures/inheritance-fixtures-agree.test.ts`.**
    The copies differ from the source only in a header comment and in the spelling `tenant_scoped: true` vs
    `{ column: tenant_id }`. The explicit spelling resolves identically under every location's project column,
    so it could be the one spelling. **Fix (optional):** spell the column out in the source, and have the smoke and
    scaffold harnesses copy from it instead of committing copies. Category: derivation over duplication.

11. **Small test-hygiene items:**
    - `src/__tests__/fixtures/inheritance-fixtures-agree.test.ts:89`: `void firstLocation;` is dead.
    - `src/__tests__/cli/inheritance-ddl.test.ts:165`: `toBeGreaterThan(8)` is a magic floor. The family has 12
      entities, so up to four modules could go unloaded and the runtime-load gate would still pass. **Fix:** assert
      the exact family count.
    - `test/scaffold/tests/inheritance-ddl.test.ts:6` says every rejection is asserted by constraint name. The case
      at `:98` asserts only `23503`, because either composite FK can fire. **Fix:** assert that the constraint is
      one of the two names, or state the exception in the header.

12. `templates/_shared/sql-predicate.mjs:4`: **the header still documents the two-argument signature**
    `renderSqlPredicate(predicate, columns)`.

13. `.claude/skills/codegen/SKILL.md:137`: **"Every generated FK callback is `.references(…)`" is no longer true
    for a `match:` `belongs_to`,** which emits a composite `foreignKey(...)`. Three generator-wide changes in this
    PR are not in CLAUDE.md or the skill: the `<entity>.enums.ts` leaf module, the `tCols` callback parameter, and
    C5. RFC-0006 schedules the docs for S6, inside the same atomic stack, so this is a nit. S6 should cover these
    three explicitly, because none of them is specific to inheritance.

### Checked and fine
- **The `tCols` parameter has one owner.** `templates/_shared/table-callback.mjs`. Every builder in
  `entity-locals.js`, the junction template and `renderSqlPredicate` read it, and `renderSqlPredicate` throws
  without it. The junction's `ix.expr.replace(/\bt\./g, …)` text rewrite is gone. A string literal in a partial
  predicate is not rewritten (`inheritance-ddl.test.ts`, the literal case).
- **The write side has one owner.** `writesDisabledBy` in `src/derived/api/entity.ts`.
  - `entity-locals.js` derives `outputPaths.*UseCase` from `apiSurface.useCases`, and `controller.ejs.t` /
    `module.ejs.t` read `_useCase(...)`.
  - The `generateWrites` local is deleted and nothing still reads it.
  - Studio renders the off-reason from `writesDisabledBy`.
  - The required keys stop a narrowed call from compiling.
  - The removed `locals.generateWrites` assertions were replaced by `apiSurface` assertions, not dropped.
- **`match:` has one normaliser.** `matchPairsOf` (`src/schema/inheritance.ts`), read by `load-entities.ts`, the
  validator and the templates. The old `matchPairs` and the inline normaliser in `load-entities.ts` are deleted.
- **Cross-entity names go through the NAME-0 helpers.** They come from `projectEntityLookup` /
  `entityModuleNaming` / `relativeModuleDir`. The `.entity` and `.enums` specifiers use `emittedStem`. `enumsFile`
  joined `EntityModuleNaming`, and its test was updated. No `pluralize`, and no hand-built `'../<plural>/'`.
- **Enum names have one rule.** `enumTypeNames`, read by `processFields` and by every importer. The leaf module is
  emitted only when the entity declares enums (`skip_if`, the same pattern as the use-case templates). It is a
  complete file, not an inject template.
- **Tenancy has one owner.** The child's tenancy is `resolveChildTenancy`, which wraps `resolveTenancy`. The base's
  `unique(id, tenant)` goes through the same deduplicated set as a `match:` onto the tenant column, and a test
  covers that.
- **Generated output is right.** *(repro)* Every table in the family has the right imports: `AnyPgColumn` only
  where a `.references()` remains, and `sql` only where a CHECK or partial index exists. A child redeclares no enum
  and does not import pg-core's `pgEnum`. `foreignColumns` read the target's Drizzle export, and constraint names
  start with `sqlTableName(entity, prefix)`.
- **No gate was loosened.** No filtered error class, no directory carve-out, no loosened assertion. The smoke-harness
  regexes were rewritten literally for `tCols`. S1's refusal test was deleted together with the refusal it
  covered.
- **The scaffold DDL test ties rejections to the right constraint.** Each rejection asserts SQLSTATE plus
  constraint name (except the item 11 case) and has a passing control. So it fails on its subject: removing the
  kind FK turns it red.
