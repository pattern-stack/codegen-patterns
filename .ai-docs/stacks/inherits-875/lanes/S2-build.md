# Lane `inh-s2-build` — #875 slice S2: DDL — shared key, composite FKs, the child's kind CHECK

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s2-inherits-ddl`
- **Branch:** `dugshub/875-s2-inherits-ddl`, stacked on `dugshub/875-s1-inherits-schema`. **Diff base:
  `dugshub/875-s1-inherits-schema`** (use it in place of `main` everywhere COMMON.md says `main`).
- **Your scope:** RFC-0006 §13.2 **S2**, revision 3. Read §2 (all of it), §1.2's rules, §7 and §13.1 closely. S1 built
  the keys and rules: read `src/schema/inheritance.ts`, `src/parser/validate-inheritance.ts` and the "S1 as built"
  block in the RFC before you start, and reuse what S1 derived (e.g. `resolveChildTenancy`, `inheritsOf`) rather
  than re-deriving it.

## What to build

1. **Lift S1's generation refusal** for `inherits:`, `discriminator:`, `match:` and `choices_of:` (and update S1's
   refusal tests to what is now true: they generate). As built, the refusal is **run-level** (`runRejections` in
   `src/cli/shared/entity-render.ts`; `unemittedInheritanceKeys` / `notGeneratedYetMessage` live in
   `src/parser/validate-inheritance.ts`). Cross-entity rule violations stay run-level rejections — only the
   "not implemented until S2" part goes. The new keys are already on `ParsedEntity` (`inherits`, `discriminator`,
   `naturalKey`, `ParsedField.choicesOf`, `ParsedRelationship.match`): read them from there, not from raw YAML.
2. **Child table** (`templates/entity/new/backend/entity.ejs.t` + `entity-locals.js`): `id` is `uuid('id').primaryKey()`
   with no default; `kind` is the **base's** `pgEnum` (imported, never redeclared) `.$type<'<as>'>().notNull()
   .default('<as>')`; the tenant column is derived from the base (name from the base, **NOT NULL**, indexed); two
   composite FKs `(id, kind) → base(id, kind)` and `(id, tenant) → base(id, tenant)`, both `onDelete('cascade')`;
   the kind CHECK `<child>_kind_check` through an **internal** check builder (no YAML `checks:` key — OQ-11).
3. **Base table:** `unique(id, <discriminator>)`; `unique(id, <tenant column>)` when tenant-scoped. A `natural_key`
   entry is emitted as the unique index it already is (tenant-prefixed on a tenant-scoped entity, as today).
4. **`match:` on a `belongs_to`** (§2.4): a derived local column with the target column's SQL type (an enum imports
   the owner's `pgEnum`), NOT NULL unless the FK is `nullable`; **one composite FK** in place of the single-column
   `.references()`, with the relationship's `on_delete`; and `unique(id, <target cols>)` **on the target**,
   deduplicated by column set (a base's `(id, kind)` is shared). M3: two relationships matching one local column
   share the one derived column. **M2's discriminator exception** (`communication_part`): the matched column is the
   declared discriminator, so no derived column is added — the FK uses the declared `kind`.
5. **`choices_of:`** emits no `pgEnum` of its own; the column uses the owner's enum type (import it).
6. **Cross-entity rendering** — a new `templates/_shared/inheritance.mjs` that reads a family (base ↔ children) and a
   target's `match:` referrers through `projectEntityLookup` (NAME-0; never `pluralize`). The target/base entity
   file is rendered by its **own** template from the referrers' YAML (the rule `templates/_shared/junction-fan-out.mjs`
   follows). In `src/cli/shared/entity-render.ts`, rendering a child or a `match:` referrer alone also re-renders its
   base / target, as `junction new` re-renders a junction's parents. Constraint and enum names follow the existing
   rules (`entity-locals.js` naming, `sqlTableName` with the prefix as a required argument).
7. **No writes for a child yet:** until S4 a child gets no create/update/delete use cases or routes (reuse the
   existing `generate.writes: false` path per entity; do not add a parallel mechanism). The base keeps its writes.
8. **DTOs:** only one change allowed — a derived `match:` column is absent from create/update input.
9. **Fixtures** (RFC §13.1): `test/fixtures/entities/` (baseline) gets `communication`, `meeting`, `email` — plus
   `email_thread` if `email`'s FK needs it, since copies must stay field-identical; `test/scaffold/entities/` gets
   the whole family (follow the `*-scaffold.yaml` convention there). Add **one unit test** that parses the
   inheritance fixture dir, the baseline dir and the scaffold dir and fails when an entity present in more than one
   differs. Find which fixture set `just test-smoke` generates and make sure the family is covered there too (A2);
   if smoke has its own set, add the family to it.
10. **Integration test** `test/scaffold/tests/inheritance-ddl.test.ts`, raw SQL against the real schema, modelled on
    the existing tests there (`_skip-guard.ts`, `helpers.ts`, `setup.ts`):
    - a `meetings` row under a `communications` row of kind `email` fails with `23503` (A4);
    - `UPDATE communications SET kind = …` on a row that has a child fails (A4);
    - a hard `DELETE` of the base removes the child (A4);
    - a child row whose tenant differs from its base's fails (tenant FK);
    - a `transcript_communication_part` (part kind `meeting`) under an `email` communication fails `23503` (A5);
    - a `communication_participant` whose role is a role of another kind fails (A5).
    A5's "the matched column is filled by the insert" is the repository's insert — that is **S4**; do not build it
    here, and say in the RFC that it lands in S4.
11. **Prove the gate can fail on its subject (A15, first half):** remove the kind FK from the template, regenerate,
    run `inheritance-ddl.test.ts`, watch the A4 case go red, restore. Paste both runs' tails.

## Must not touch

`runtime/`; the repository and service templates' read and write bodies; DTO templates except item 8.

## Gates (after your last edit; paste tails)

- `bun run typecheck`, `just test-unit`
- `just test-baseline` — the snapshot diff is **new modules and barrel/manifest lines only**; the #680 expectation
  (`ISSUE_680_EXPECTATION`) is untouched. List every changed pre-existing snapshot file in your report and say why.
- `just test-smoke`
- `just test-integration` (Docker; per-checkout ports derive automatically)

## Report

Per COMMON.md. Include the emitted `communication.entity.ts`, `meeting.entity.ts`, `communication-part.entity.ts`
and `communication-participant.entity.ts` from the scaffold run verbatim, so the coordinator can show them to Doug
at CP1.
