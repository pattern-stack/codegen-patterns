## Gate 2.5 — Adherence (lens=adherence) · PR #908 @ d7176186

**Against:** RFC-0006 §12 (A2 tables, A3, A4, A5 rejections) + §13.2 S2, including its "as built", "phase R" and "R2" notes
**Verdict:** PASS_WITH_NOTES

Reviewed `git diff dugshub/875-s1-inherits-schema...HEAD` in the S2 worktree at `d7176186`. The PR head on GitHub
(`e235a90d`, rebased onto a newer `main`) carries a byte-identical S2 diff (`git diff 4d0589c9 e235a90d` equals
`git diff e6316ff3 d7176186` apart from `index` lines), so every finding holds for both. One finding was reproduced in a
scratch project outside the worktree. No gate was run.

### Blockers

None.

### Should-fix

1. `templates/entity/new/backend/entity-locals.js:2364` (with `templates/_shared/inheritance.mjs:58-64`): a `match:`
   whose target is the entity itself and whose target column is that entity's own enum emits the enum import twice.
   **Scenario:** `node` has `kind: { type: enum, choices: [a, b], required: true }` and
   `parent: { type: belongs_to, target: node, foreign_key: parent_id, nullable: true, match: { parent_kind: kind } }`.
   `entity validate` and `entity new --all` both succeed, and `node.entity.ts` contains
   `import { nodeKindEnum } from './/node.enums';` followed by `import { nodeKindEnum } from './node.enums';`
   (reproduced). That is TS2300 and an ESM SyntaxError, so a valid YAML generates a file that does not compile. No gate
   covers a self-target. RFC §2.4 says the derived column takes the target's `pgEnum`, imported. For the entity's own
   enum, no import is needed. `.//` comes from `relativeModuleDir(dir, dir)` returning `./`, which `moduleRef` then
   joins with another `/`. **Fix:** in `wantImport` (or when `matchDerivedColumns` sets `enumImport`), skip an enum
   whose `ownerEntity` is this entity, since the file already imports it from `enumsImportSpecifier`. Join `moduleRef`'s
   path without the extra `/`. Add a self-match case to `src/__tests__/cli/inheritance-ddl.test.ts`.
2. **DECISION.** `docs/rfcs/RFC-0006-joined-table-inheritance.md:355` says a derived `match:` column is "read-only in
   the output". The output DTO does not have it: `templates/entity/new/backend/dto/output.ejs.t` prints only
   `belongsToFkFields` / `outputDtoFields`, and a derived column is neither. No slice owns the gap: S2's as-built note
   (`:1275-1276`) mentions only the create and update DTOs, §5 never mentions `match:` columns, and S5's entry does not
   list the work. S2 may not touch the output DTO (brief item 8). **Scenario:** after S5,
   `CommunicationParticipantOutputSchema` still lacks `communicationKind`, and no review catches it, because no slice
   claimed it. **Fix:** either give S5 the item ("a derived `match:` column is read-only in the output DTO") in its
   Touches and Closes, or drop "read-only in the output" from §2.4. Either way, add one line to S2's "Not done" bullet
   saying the column is absent from the output DTO too.
3. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1239` (and `:1351`): S2's entry still says "Closes: A2 (tables), A3,
   A4, A5". Its own Adds line (`:1236`, "A5's rejections"), the as-built "Not done" bullet (`:1315-1317`) and the PR body
   ("A5 (rejections). The insert fill is in S4") all say A5's third clause ("the matched column is filled by the insert,
   not by the caller") lands in S4. S4's Closes (`:1351`, "A6, A7, A11") does not list it. **Scenario:** S4 is accepted
   against its Closes list, and A5's fill clause is checked by nobody. **Fix:** change S2's Closes to `A5 (rejections)`
   and add "the rest of A5 (the insert fills the matched column)" to S4's Closes. S4's Touches already names "the
   scalar-subquery fill for `match:` columns".
4. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1131` says `inheritance-fixtures-agree.test.ts` "normalises
   `tenant_scoped` away". That describes the round-1 bug (#6), not the fix. The test now resolves `tenant_scoped` to
   its column under each location's own project tenancy column
   (`src/__tests__/fixtures/inheritance-fixtures-agree.test.ts:39-57`), so a copy that drops tenant scoping differs.
   **Scenario:** a later agent "simplifies" the test to match the RFC by deleting the key again, and a copy without
   `tenant_scoped` passes. **Fix:** say "it compares `tenant_scoped` as the column it resolves to under each location's
   own `tenancy.column`, so only the spelling may differ, never whether the entity is scoped".

### Nits

5. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1278` says the callback parameter is `tCols` "for every table and
   junction". `templates/relationship/new/entity.ejs.t:94` still emits `(table) => [ uniqueIndex(...).on(table.…) ]`.
   **Fix:** route the relationship template through `TABLE_CALLBACK_PARAM`, or narrow the sentence to entity and
   junction tables.
6. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1287` says the 63-byte check covers "every constraint and index".
   `assertDistinctConstraints` is called only from `entity-locals.js:2322`, so it covers names an entity table's
   extra-config callback writes. Junction and relationship tables are not checked, and neither are Drizzle's derived
   names for a single-column `.references()` FK or `pgEnum` type names. **Fix:** narrow the sentence to what is checked.
7. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1289-1291` overstates two things:
   - It says "the schema, the parsed model, the validator and the templates all read" `matchPairsOf` and
     `inheritanceCounterpartNames`. In fact the schema reads neither. The templates read only `matchPairsOf`, and their
     reverse walk (`matchReferrers`, `inheritance.mjs:128`) is separate. Only the validator reads
     `inheritanceCounterpartNames`.
   - It says "`lookup.definitions()` throws on a lookup that holds a block but no document". Neither constructor can
     build such a lookup: `createEntityLookup` always stores the doc, and `entityLookupFrom` synthesizes
     `{ entity: block }`. The docstring at `templates/_shared/entity-naming.mjs:66-67` says `definition()` is `null` for
     a blocks-only `entityLookupFrom`, which is no longer true.

   **Fix:** state the readers as they are, and fix the docstring.
8. `src/cli/shared/entity-render.ts:118` says "otherwise a newly added child leaves the base's table stale". The RFC
   (`:1259-1261`) and `validate-inheritance.ts:528-531` say a base's output does not depend on its children.
   **Fix:** say the base is re-rendered so a stale base becomes current, not because the child changes it.
9. `templates/_shared/inheritance.mjs:234-236` says a `match:` on "the child's carried kind / tenant" derives nothing
   and the FK uses that column. M2 refuses that case (`validate-inheritance.ts`, M2 via `implicitColumns`), so only the
   discriminator exception reaches this branch. **Fix:** drop the child half of the comment, or say it is defensive.
10. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1117` still calls `communication_note`'s rule "the NULL-together
    CHECK". C1 changed it to `<fk> IS NULL OR <derived> IS NOT NULL` (§2.4 `:368-374`), which is not NULL-together.
    The as-built Names bullet (`:1264-1265`) also omits `<table>_<relationship>_match_check`.
11. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1208` (S1 as-built) cites `src/__tests__/cli/inheritance-refusal.test.ts`.
    This PR renamed it to `inheritance-ddl.test.ts`, where the `natural_key:` byte-identity case is at `:324-361`.
12. `test/fixtures/entities/communication.yaml:3` (the baseline copy) says "Loaded by unit tests, never generated from".
    The baseline set is generated from. The comment was copied from the inheritance directory, and the agreement test
    ignores comments.

### Checked and fine

- **A3**, at `src/__tests__/cli/inheritance-ddl.test.ts:79-115` and the baseline `meetings/meeting.entity.ts` /
  `emails/email.entity.ts` / `communications/communication.entity.ts`:
  - the child's `id` is `uuid('id').primaryKey()`, with no default;
  - `kind` is `communicationKindEnum('kind').$type<'meeting'>().notNull().default('meeting')`, imported from the
    owner's `.enums` leaf, never redeclared;
  - the child's tenant column is `uuid('tenant_id').notNull()` and indexed;
  - `meetings_communication_kind_fk` and `meetings_communication_tenant_fk` are both `onDelete('cascade')`;
  - `meetings_kind_check` goes through the internal check builder (no `checks:` key, OQ-11);
  - the base has `communications_id_kind_uniq` and `communications_id_tenant_id_uniq`, and the natural key stays the
    tenant-prefixed unique.
- **A4** (`test/scaffold/tests/inheritance-ddl.test.ts:76-162`): a child under another kind, and under the base-only
  `message`, fails `23503` on `meetings_communication_kind_fk`. `UPDATE communications SET kind` with a child present
  fails on the same constraint. A hard `DELETE` removes the child. The suite also covers the tenant FK, the CHECK
  (`23514`) and the missing id (`23502`), each with a control. `test/scaffold/run-integration.ts:142` runs the whole
  `tests/` directory, so the file is in the CI job.
- **A5 rejections**:
  - `inheritance-ddl.test.ts:178-246` (scaffold): part kind `meeting` under an `email` communication fails
    `communication_parts_communication_match_fk`; a transcript part over an email-kind part fails its kind FK; a
    participant whose role is another kind's fails `communication_participants_role_match_fk`; the derived column is
    NOT NULL.
  - One composite FK and the target's `unique(id, kind)`: `src/__tests__/cli/inheritance-ddl.test.ts:117-137`.
  - The fill is recorded as S4's job (but see should-fix 3).
- **§2.4 / M2 / M3:**
  - M2's discriminator exception derives nothing (`:267-275`).
  - Two relationships share one derived column, NOT NULL when any FK is (`inheritance.mjs:264-266`; test `:205-215`).
  - The all-nullable CHECK is `fk IS NULL OR derived IS NOT NULL` per FK, with one conjunct per column
    (`entity-locals.js` beside `nullableDerived`; scaffold `:248-309`).
  - `on_delete` comes from the relationship, with `restrict` as the default.
  - `set_null` on a `match:` is refused (S1 M4).
- **Uniques:** `unique(id, <cols>)` is deduplicated by column set, and the base's `unique(id, tenant)` is in the same
  set (`inheritance.mjs:212-224`, test `:229-251`). Order is deterministic: `findYamlFiles` sorts, and
  `uniqueTargets` is sorted.
- **§2.1 enum leaf modules:**
  - `<entity>.enums.ts` imports only `drizzle-orm/pg-core` (`enums.ejs.t`; test `:107-109`).
  - The entity file imports and re-exports its enums, and only the owner re-exports, so `schema.ts` has no duplicate
    export.
  - The runtime-load gate (`:152-172`) imports every entity module first in its own process, which is the order that
    reproduces the TDZ. It runs in `just test-unit`.
- **Pre-flight (`entity-render.ts:113-134`, `:295-311`):** counterparts join `validated` before the `emits:` /
  `roles:` checks. A child whose base is rejected is rejected too, with nothing written (test `:253-265`). Re-rendering
  the base and the target is tested at `:277-295`. Cross-entity violations stay run-level (`:314-321`).
- **S1's refusal:** removed (`unemittedInheritanceKeys` / `notGeneratedYetMessage` are gone, and their tests are
  replaced by generation tests).
- **No child writes (ADR-046):**
  - One owner: `writesDisabledBy` (`src/derived/api/entity.ts:109-120`). `entity-locals.js` reads
    `apiSurface.useCases` for the use-case paths, and no other reader of `generate.writes` exists.
  - Tests: `writes-disabled-by.test.ts`; `inheritance-ddl.test.ts:111-114`.
- **DTOs:** the derived column is absent from create/update input, and no DTO template changed.
- **Must-not-touch:** nothing under `runtime/` and no repository, service, DTO, use-case, controller or module template
  changed. `ISSUE_680_EXPECTATION` (`test/run-test.ts`) is untouched.
- **Pre-existing baseline snapshots** changed only for the decided categories: `(t)` → `(tCols)`, the `.enums` leaf
  with re-export and the dropped `pgEnum` import, plus the new modules' lines in the three barrels/manifests.
- **Fixtures (§13.1):**
  - The baseline holds `communication`, `meeting`, `email`, `email_thread` and `meeting_transcript`, byte-identical to
    the inheritance directory.
  - The scaffold and smoke directories hold all 12 entities. The smoke spells `tenant_scoped: { column: tenant_id }`
    on the three tenant-scoped ones.
  - The agreement test compares all four locations.
- **Names:** every name uses `sqlTableName` with the required prefix (`projectTablePrefix`). Cross-entity names come
  through `projectEntityLookup` / `entityModuleNaming` (no `pluralize`).
- **Tarball:** `src/schema/inheritance.ts` and `src/derived/api/entity.ts` are in `package.json` `files`, and
  `templates/` is published whole.
- **Scope beyond the S2 Touches line**, each recorded in the as-built or phase R / R2 notes:
  - `src/schema/inheritance.ts` and `src/parser/*`;
  - `src/config/module-tree.ts` (`enumsFile`) and `templates/_shared/{entity-naming,table-callback,sql-predicate}.mjs`;
  - `templates/junction/new/*`;
  - `src/derived/api/*` and `tools/studio/src/inspector/surface-view.ts` (the "Writes off" chip);
  - the smoke harness regexes, and the render and junction goldens.
- **Public-repo check:** none of the host-name patterns from the lane rules appear in the diff.
