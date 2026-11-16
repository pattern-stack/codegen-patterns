# Lane `s7a-fix` — apply the S7a review

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7a-integrated-schema`
- **Branch:** `dugshub/917-s7a-integrated-schema` (tip `53471b30`).
- **Input:** `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/reviews/s7a.md`. Read it in
  full.

Fix the following. **Re-verify each finding before you fix it.** If one is wrong at the tip, record
"declined: <why>" with the evidence.

- **Should-fix 1 (R6 noise when D1 fails).** Drop the `baseGaps.length > 0` gate, so a failed D1 yields only the D1
  errors. Then:
  - invert `integrated-child.test.ts:129-136`;
  - update the comment, the `pattern-definition.ts:127` doc and the RFC's R6 bullet.
- **Should-fix 2 (R11 exemption too wide).** Exempt only a base that declares `external_id_tracking`, and only when the
  natural-key entry's fields are exactly the behaviour's identity pair.
  - A non-family entity, a child, or a key on `external_id` alone stays an R11 error, as on `main`.
  - Add the reviewer's standalone case as a test: red on the current tip, green after.
  - Update the "another nullable column" test.
- **Should-fix 3 (the pair is retyped).** Give the behaviour definition (`src/behaviors/external-id-tracking.ts`, the
  `BehaviorDefinition` type) a declared **identity columns** property, `['provider', 'external_id']`.
  - `INTEGRATED_NATURAL_KEY` reads it; nothing retypes the names.
  - A test fails if the property names a field the behaviour does not declare.
  - **Do not edit `templates/entity/new/backend/entity-locals.js`.** Its retyped pair (`:2293` / `:2302`) is in the file
    S7b is rewriting for "one constraint". The coordinator hands that call site to S7b.
- **Nit 4.** Test D1's "exactly" half: a superset key such as `[provider, external_id, title]` is a D1 error.
- **Nit 5.** The read-through exemption applies only to the pattern that declares `readsThroughBase`.
  - Test: Integrated plus `Activity { occurredAt: provider }` on a child is an R6 error for Activity.
- **Nit 6.** Fix the R11 "at most one" message so that it names Integrated children only for a base that has them.
- **Nit 7.** RFC §1.2 (R5, R11) and §4.2's "Integrated on a child stays refused in this build" are stale. Update them to
  the as-built rules. This is the one place you edit RFC text outside S7's §13.2 entry: CLAUDE.md's living-docs rule
  wins, and the coordinator approves it.
- **Nit 8.** In S7a's "S7b inherits" note, name the `entity-locals.js:1132` "Declare it once" guard that `entity new`
  hits on the fixture.

Commit as `fix(#917 S7a): review — …`.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-baseline`. The baseline must stay byte-identical. Report to
`codegen-patterns-73` as a table, one row per finding: `# / severity → fixed in <sha> | declined: why`. Include the gate
tails.
