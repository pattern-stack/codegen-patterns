# Lane `s7b-fix` — apply the S7b review, and the `test-studio` failure

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you.

The review is at `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/reviews/s7b.md`. Read it
in full.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7b-integrated-repository`
- **Branch:** `dugshub/917-s7b-integrated-repository` (tip `8a3135d6`).
- S7c sits above you, at `2fbb8184` on `dugshub/917-s7c-integrated-emitter`. The coordinator re-cascades it after
  you finish.

**Re-verify each finding before you fix it.** If one is wrong at the tip, record it as "declined: <why>", with the
evidence.

## Fix

1. **`test-studio` is red on the stack.**
   - The cause: `tools/studio/src/inspector/surface-kinds.ts:73` (TS2741). S7b added the surface kind
     `integration_through_base`, but did not add its row to Studio's kind table.
   - Add the row, plus any other Studio vocabulary table keyed on surface kinds, so the kind has a label and a section.
   - Gate: `just test-studio` green. Your brief never listed this gate, so add it to your runs.
2. **Finding 1 (should-fix): the fixture's sink can never write.**
   - Give the base `inbox_item` an **optional** (nullable) field, for example `preview`. Exclude that field instead of
     `title` in both children's `sink.exclude_fields`.
   - Update every copy: `test/fixtures/integrated-child/`, the baseline copy, the scaffold copy, and the drift test.
     Also add `mailbox` to the drift test (nit 11).
   - In the Docker tests, drop `withTitle`, and assert the exclude contract instead: a sync update leaves the excluded
     field unchanged.
   - The follow-up decision (should `exclude_fields` refuse a NOT NULL column with no default) is filed as **#930**.
     Do not build it.
3. **Finding 2 (events): a decision is pending with Doug.** Do **not** change behaviour. Fix the RFC sentence (`:2055`)
   so it says what is built:
   - the sink calls the repository, so no service lifecycle event fires for any entity;
   - with `emit_changes: true`, the orchestrator publishes `<entity>_created` / `_edited` / `_deleted` under the child's
     name only, and no base-named event;
   - add "pending Doug (S7-D6)".
4. **Finding 3 (ADR-046).** The template must not pick bodies by literal method name (`repository.ejs.t:905-942`), and
   the persist hook's existence must not ride on the `softDeleteByExternalId` branch.
   - Each forwarded read and the hook come from the derived surface, as flags or kinds the template loops over.
   - Show that a dropped hook is now caught: mutate, watch the test go red, restore.
5. **Finding 4: two owners of "is this the identity pair".** `adoptedExternalIdKeyIndex` calls S7a's
   `isIntegratedNaturalKey`, or `naturalKeyIndexOf` plus it, and never re-implements it.
6. **Nits 5–12.**
   - Fix the cheap ones. The RFC names **#779** for the mailbox resolver (nit 5).
   - For each one you don't fix, say why in one line.
   - Nit 12 (the batch `integrationUpsert` on a child): refuse it on a child, with a test, or mark it out of S7 in the
     RFC. Choose the one with less surface.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-junction`, `just test-integration-emit`,
`just test-studio`, `just test-integration`. Run them on a clean tree. Remove any repo-root `junctions/` left by a
scaffold run (that is #932).

Commit as `fix(#917 S7b): review — …`. Do not push. Report to `codegen-patterns-73` as a table, one row per finding:
`# → fixed in <sha> | declined: why | pending decision`. Include the gate tails and the new tip sha. Also list the
fixture changes S7c's flat twin must copy.
