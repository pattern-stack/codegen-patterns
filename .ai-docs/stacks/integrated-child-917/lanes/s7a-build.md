# Lane `s7a-build` — S7a: the schema accepts `pattern: Integrated` on a child

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds
you, including Doug's D1–D5. Then read RFC-0006 §4.2, §8, §11.3 and §13.2 (the S1 and S7 entries), and issue #917
(`gh issue view 917`).

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7a-integrated-schema`
- **Branch:** `dugshub/917-s7a-integrated-schema`, off `origin/main` (`243e277c`). It is the bottom of the S7 stack.

S7a is **validation and the fixture only**. It does not change emission, the repository, the runtime or the
integration emitter. Those are S7b and S7c. If something can only be shown by emitting, leave it to them and say so.

## What changes

1. **The §8 refusals on a child** (`src/schema/inheritance.ts`, around the `// ---- §8` block):
   - stop refusing `pattern: Integrated`, `surface:`, `integration:` and `detection:` on a child;
   - keep `eav_value_table: true` refused;
   - keep R9 as it is.
2. **D2: Integrated on a base.**
   - A base (an entity with `discriminator:` and children) that declares `pattern: Integrated`, `surface:`,
     `integration:` or `detection:` is refused, with a message that names the open issue, **#927**.
   - Check today's behaviour first. If a base can declare these today, that is a behaviour change, so name it.
3. **D1: what the base must declare.** A child that declares `pattern: Integrated` is an error unless its base:
   - declares `external_id_tracking` explicitly in `behaviors:` (a base implying it through a pattern does not count,
     because D2 refuses Integrated on a base anyway); and
   - has a `natural_key: true` `unique_indexes` entry whose fields are exactly `[provider, external_id]`.
   Each missing piece is its own error, naming both entities and the key to add. These are cross-entity rules, so they
   belong in `src/parser/validate-inheritance.ts`, next to R4, R6 and R7.
4. **R5 on a child.**
   - A child that **declares** `external_id_tracking` (explicitly, in `behaviors:`) stays an R5 error.
   - A child whose only source of it is **implied** by `pattern: Integrated` is not an R5 error, because the base
     supplies the columns.
   - `lifecycleBehaviorsDeclared` (`src/schema/tenancy.ts`) is the one reader. Change it, or its R5 call site, so that
     the two cases are told apart. Do not add a second list.
   - Whatever S7b needs in order to **not** emit those columns on the child table, state it in your report. Do not
     build it.
5. **R6 and Integrated.**
   - `IntegratedPattern` (`src/patterns/library/integrated.pattern.ts`) gets a `columnsRead`. Its columns are
     `external_id_tracking`'s fields, read from the behaviour definition (`src/behaviors/external-id-tracking.ts`),
     never retyped.
   - R6 must accept Integrated on a child even though the base owns those columns, because S7b forwards the reads to
     the base. Accept exactly those columns, and only when D1's base requirements hold. Any other base column a
     pattern reads stays an R6 error.
   - Find the cleanest owner for "this pattern's columns are read through the base". Prefer a property on the pattern
     definition over a name check in R6. Say what you chose and why.
6. **R11, widened.**
   - On a base, a `natural_key: true` entry may name the two `external_id_tracking` columns `provider` and
     `external_id`, which are nullable, when the base declares the behaviour.
   - Every other nullable natural-key column stays an R11 error.
   - R11's "at most one natural key" stands, so a base with an Integrated child cannot have a second natural key. Make
     sure that error names both entries and says why.
   - The runtime NULL guard on `upsertByNaturalKey` is **S7b's**, not yours.
7. **Fixture.** Add a small generic family: one base, two Integrated children and one base-only kind, for the later
   slices to emit and sync. Generic names only, for example:
   - a base `inbox_item`: `tenant_scoped: true`, `soft_delete`, `timestamps`, `external_id_tracking`,
     `discriminator: kind` with `[mail_message, calendar_event, note]`, and natural key `[provider, external_id]`;
   - children `mail_message` and `calendar_event`, each `pattern: Integrated`, with a `surface:` that matches the
     mail / calendar interaction surfaces the integration layer already knows. Read `docs/rfcs/RFC-0001*`,
     `RFC-0003*` and the existing integration fixtures, and copy their surface / provider shape;
   - `note` as the base-only kind.
   Put it where validation tests can load it, and **not** in any set that emits today (baseline, smoke, scaffold,
   integration-emit), because emitting it is S7b's and S7c's job. Say where you put it and how S7b should wire it in.
8. **RFC.**
   - In §13.2, S7 now has an S7a "as built" entry: what changed, the tests, and what S7b inherits.
   - In §8, the refusal bullet now refuses `pattern: Integrated` on a **base** (D2) instead of on a child.
   - Edit only §8's bullet and S7's §13.2 entry; leave §1–§12 otherwise alone. §11.3 already has D1–D17; add an
     **S7 decisions** sub-table under §11.3 listing D1–D5 above, as decided by Doug on 2026-11-15.

## Tests (each shown red on `origin/main`, then green)

- A child with `pattern: Integrated` (and with `surface:`, `integration:` and `detection:`) on a base that meets D1:
  no issues.
- Each D1 failure: a base without `external_id_tracking`; a base without the natural key; a base whose natural key is
  on other columns. Each is one error naming both entities.
- D2: Integrated, `surface:`, `integration:` or `detection:` on a base is refused.
- R5: an explicit `external_id_tracking` on a child is still refused; one implied by Integrated is not.
- R6: an Integrated child passes only under D1. Another pattern that reads a base column still fails.
- R11: `[provider, external_id]` passes on a base that declares the behaviour. The same nullable columns fail on a base
  that does not. Any other nullable column fails. A second natural key fails.
- The fixture family validates clean through `codegen entity validate --json` (exit 0, `valid: true`) on a temp copy.

Any existing test that asserted the old refusal is an **assertion change**. Name each one in your report.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-baseline`. The baseline must be byte-identical, because S7a emits
nothing new. Commit as `feat(#917 S7a): …`. Do not push. Report to `codegen-patterns-73`: commits, files, tests (red,
then green), the assertion changes, what S7b inherits, and anything unsure. **If you
hit a choice that D1–D5 do not settle and that changes what a user writes in YAML, stop and report it as a NEW
decision; do not pick one.**
