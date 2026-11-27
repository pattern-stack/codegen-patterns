# Lane `inh-s1-build` — #875 slice S1: schema and validation

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s1-inherits-schema`
- **Branch:** `dugshub/875-s1-inherits-schema`, based on `main` (`074cce00`). Diff base: `main`.
- **Your scope:** RFC-0006 §13.2 **S1**, as amended by revision 3 (OQ-11).

## What to build

1. **Keys** in `src/schema/entity-definition.schema.ts` (and regenerate `src/schema/entity-definition.schema.json`
   with the repo's own generator, `src/schema/generate-json-schema.ts` — find how it is run, do not hand-edit):
   - top-level `inherits:` — `<entity>` or `{ base: <entity>, as?: <kind> }`;
   - top-level `discriminator: <field>`;
   - `match:` on a relationship — `{ <local column>: <target column> }`, or a list of names as shorthand for
     same-name pairs (§2.4);
   - `natural_key: true` on a `unique_indexes` entry;
   - field option `choices_of: <entity>.<field>` on `type: enum`.
   - **No `checks:` key.** OQ-11 removed it from this build.
2. **Rules R1–R11 and M1–M5**, each failing with a message that names the entities (and fields) involved:
   - single-file rules in the Zod schema / its refinements where they belong;
   - cross-entity rules in a new `src/parser/validate-inheritance.ts`, exported from `src/parser/index.ts`, called in
     the `entity new` pre-flight next to `validateSemanticModel` (`src/cli/commands/entity.ts`) and anywhere else the
     semantic validation runs over the whole set (`src/index.ts:107` — check whether `validate-entities` / `analyze`
     should report them too, and make them consistent).
   - **Revision-3 rules to get exactly right:** R1 accepts `choices_of:` as well as literal `choices:` (the
     discriminator's choice list then comes from the referenced field). M2 has one exception: the matched local
     column may be the entity's own `discriminator:` field **when its enum is the target column's** (via
     `choices_of:`). `choices_of:` must name an existing entity's existing `type: enum` field with literal `choices:`
     (no chains).
   - R5 (lifecycle behaviors on the base only) and R10 (a `tenant_scoped` base declares its tenant column NOT NULL)
     live with tenancy: `src/schema/tenancy.ts` derives a **child's** tenancy from its base (column name,
     `tenantScoped`, strict enforcement), so later slices read it from one place.
   - R9 (`eav: true` / `pattern: Junction` refused in a family) and §8's v1 refusals on a child (`pattern: Integrated`,
     `surface:`, `integration:`, `detection:`, a non-uuid or composite key, multi-level) are errors with messages.
3. **Generation refusal:** `entity new` (single and `--all`) refuses any entity set that uses `inherits:`,
   `discriminator:`, `match:` or `choices_of:` with a clear "not implemented until S2 of #875" error, so nothing
   half-built is emitted. `natural_key:` alone may be accepted and ignored by the emitters for now **only** if that
   leaves `just test-baseline` byte-identical; otherwise refuse it too. Say which you chose.
4. **Fixtures:** `test/fixtures/inheritance/entities/` — the whole family of RFC §13.1, with the revision-3 shapes
   (§2.4 case 1, §7). Generic fields only. Loaded by unit tests through the real loader; never generated from.
   Add negative fixtures (or inline YAML in tests) for each rule.
5. **Tests** under `src/__tests__/schema/` and `src/__tests__/parser/`: the family validates clean; **each** of R1–R11
   and M1–M5 (plus the M2 discriminator exception, both the allowed and the refused case) has a failing case that
   asserts the message names the entities involved.
6. **Commit the RFC.** `docs/rfcs/RFC-0006-joined-table-inheritance.md` is already in the worktree, untracked. Commit
   it first, on its own (`docs(rfc): RFC-0006 joined-table inheritance (#875)`), then build on top.

## Must not touch

`templates/`, `runtime/`, `src/emitters/`. The generator accepts and validates the keys and emits nothing new.

## Gates (after your last edit; paste tails)

- `bun run typecheck`
- `just test-unit`
- `just test-baseline` — must be **byte-identical** (no snapshot change at all).

## Report

To `codegen-patterns-73` per COMMON.md. Include the full list of rule → test name, so the reviewer and coordinator
can check A1 line by line.
