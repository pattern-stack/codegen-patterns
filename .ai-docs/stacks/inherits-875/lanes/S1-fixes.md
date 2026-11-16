# S1 review fixes — lane `inh-s1-build`

The Opus review of `dugshub/875-s1-inherits-schema` @ `b06868af` returned **ACCEPT_WITH_FIXES**. Fix the items
below on the same branch, as new commits (no history rewrite). COMMON.md still binds you. Every finding was verified
against your branch by the reviewer; re-verify each before you fix it.

1. **The S2 refusal does not stop the shared generated files** (`src/cli/shared/entity-render.ts:249-292`). Under the
   default `--continue-on-error`, the cross-entity post-steps still run over the whole directory. With the fixture
   family in a project, `entity new entities/email_thread.yaml --force` exits 0, `schema.ts` re-exports 8 modules
   that were never emitted, `relations.ts` emits `meetings: tableScope(schema.meetings, UNSCOPED)`, and `--all` emits
   `meeting-transcript.entity.ts` importing a missing `../meetings/meeting.entity`.
   **Fix:** an entity in the directory that uses an unemitted key is a `runRejections` entry (the #666 posture —
   an input to the barrels and the manifest), so the run stops. Rewrite the "a plain entity in the same directory
   still generates" test to assert the run stops, and make sure it would have caught this (show it red against the
   old behaviour). Correct the RFC's "S1 as built" sentence.
2. **M2's discriminator exception compares strings** (`validate-inheritance.ts:456-477`). It refuses two valid
   shapes with unapplyable advice: (a) a discriminator `choices_of: communication.kind` matched against a lookup
   column that is also `choices_of: communication.kind`; (b) `communication.kind` (literal) matched against a lookup
   column `choices_of: communication.kind`. **Fix:** compare `sqlTypeKey(def, local) === sqlTypeKey(t, targetCol)`
   (the helper at `:106`). Test both shapes as allowed.
3. **A child's derived columns are invisible to M2** (`implicitColumns`, `:72-82`, used at `:439`). The base
   discriminator's name (`kind`) and the base's tenant column are columns on the child. Today `meeting` with
   `match: { tenant_id: tenant_id }` and `transcript_communication_part` with `match: { kind: kind }` pass, and S2
   would derive a second column. **Fix:** add the family-derived columns to a child's implicit set; test both.
4. **R6 misses Activity's derived column, and compares arbitrary strings** (`:298-326`). `meeting` with
   `Activity: { subject: owner, occurredAt: starts_at }`, where the base owns `owner_id`, passes. **Fix:** replace the
   string-leaf walk with a per-pattern statement of the columns a pattern reads (today only Activity carries
   column-bearing config: `subjectColumn`, `subject` → `<subject>_id`, `occurredAt` default `occurred_at`). Put that
   statement next to the pattern's own config definition if one exists, so it has one owner. Test the scenario.
5. **R8 compares declared modes, not resolved ones** (`:344`). Pass the resolved global `frontend.sync.mode` in the
   validator's options (as `tenancyColumn` is passed) and compare **resolved** modes, so a base `sync: electric` with
   undeclared children under a global `electric` is fine. Update the RFC's R8 "as built" note.
6. **Read `ParsedEntity`, not raw definitions** (findings 6 and 8). Role FK columns (`<role>_<target>_id`) are
   invisible to M2/R4 because the validator reads definitions; S3's `build-graph` reads `ParsedEntity`, so the new
   keys must reach `ParsedEntity` anyway. **Fix:** carry `inherits` / `discriminator` / `match` / `natural_key` /
   `choices_of` onto `ParsedEntity` and point `validateInheritance` at it. That also removes the duplicate directory
   load (`entity-render.ts:195` and `:249`, and the second load inside the swallow-all `catch {}` at
   `src/index.ts:117-125` — no swallow-all catch survives). Test the role-column scenario
   (`roles: { attendee: { target: person, cardinality: one } }` + `match: { attendee_person_id: kind }` is refused).
7. **R4 does not see `match:`-derived columns** (`:249-264`). A child deriving `thread_topic` via `match:` while the
   base declares `thread_topic` passes. Fix and test.
8. **R11 vs S7** (`src/schema/inheritance.ts:211-225`). Leave the rule; add a line to the RFC (§4.2 / S7) that S7
   must accept behavior columns (`provider`, `external_id`) in a natural key.
9. **Nits:** `ENTITY_NAME_PATTERN` sits between imports (`entity-definition.schema.ts:5-6`) and its regex is
   repeated as literals for `inherits.as` and `discriminator` — one definition. M2's message suggests `choices_of:`
   even for a uuid target column (`:447-449`) — suggest it only for an enum target.

Skip: splitting the zod/v4 commit; a JSON-freshness gate (out of scope, pre-existing).

Gates after your last edit: `bun run typecheck`, `just test-unit`, `just test-baseline` (byte-identical). Report per
COMMON.md with a finding → commit/test table.
