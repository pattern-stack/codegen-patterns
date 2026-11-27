# Lane `s7c-fix` — apply the S7c review on the new S7a

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you.
The review is at `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/reviews/s7c.md`. Read it
in full.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7c-integrated-emitter`
- **Branch:** `dugshub/917-s7c-integrated-emitter` (tip `f02d9c3a`, on the old S7a `53471b30`).

## 1. Rebase onto the new S7a

Run `git rebase --onto 6ec08b26 53471b30`. The new S7a contains:
- `0687f9ab`: R6 / R11 / identity columns;
- `6ec08b26`: the one owner of a child's flat shape, plus a fuller fixture.

Expected conflicts:
- `src/schema/inheritance.ts`. `flattenInheritedChild` now lives in S7a, with the same name and signature, as a
  projection of `flatChildShape`. **Drop your copy and keep S7a's.**
- `test/fixtures/integrated-child/definitions/providers/google.yaml` is an add/add conflict. **Take S7a's** (surfaces
  `calendar` and `mail`).
- The RFC's S7 §13.2 entries. Keep both.

## 2. Findings

- **Finding 1 (owner).** Done by S7a: you consume `flattenInheritedChild` from there.
  - Remove the `as never` casts at `adapter-emission-generator.ts:977`.
  - Add `inherits?` and `discriminator?` to `EmitAdaptersEntity`, so it satisfies `FlatChildInput`.
  - Finding 1.3 (the `490-sink-knobs-contract` lock) is S7b's. Leave it.
- **Finding 2 (fixture coverage).** S7a's fixture now has:
  - a `mailbox` entity, and `inbox_item` `belongs_to mailbox` (`mailbox_id`, nullable);
  - both children with `integration.providers.google`, and sink `{ delete: tombstone | soft, exclude_fields: [title],
    emit_changes: true }`;
  - a provider serving calendar and mail.

  Update your flat twin, `test/fixtures/integrated-child-flat/`, to match field for field:
  - add `calendar_event` and `mailbox`;
  - add the `mailbox` `belongs_to` on each flat child;
  - add the same integration blocks.

  Flat fields:
  - `mail_message`: `tenant_id`, `title`, `subject`, `sent_at`;
  - `calendar_event`: `tenant_id`, `title`, `starts_at`, `ends_at`.

  The gate must now render **both** children, and cover a base `belongs_to` and `emit_changes`. Show the review's two
  mutations each turn the gate red:
  - drop the base-relationship merge from the flatten;
  - an `inherits:` branch on the `emitChanges` line (`adapter-emission-generator.ts:1167`).

  Restore both, and paste the red output.
- **The raw set after the flatten** (`opts.entities` still in scope after `:977`). Make the flattened set the only one in
  scope for the rest of `emitAdapters`: rebind it, or narrow the scope. A later edit must not be able to read the raw
  set by accident.
- **Finding 3 (`exclude_fields`).** Done by S7a: a child is checked against its flat shape.
- **Nits.**
  - Delete the dead `surfaced` alias at `family-blind.test.ts:33-34`, and its stale comment.
  - The RFC `:1998` bullet was fixed by S7a. Check your S7c entry agrees with it.
- **Snapshot.** Re-bless `family-blind.test.ts.snap` with the repo's flag, and explain the diff: new calendar files, the
  `mailbox` columns and the `emit_changes` output.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-integration-emit`, `just test-baseline`. Commit as
`fix(#917 S7c): review — …`. Do not push. Report to `codegen-patterns-73` as a table, one row per finding:
`# → fixed in <sha> | done in S7a | declined: why`. Include the gate tails and the new tip sha.
