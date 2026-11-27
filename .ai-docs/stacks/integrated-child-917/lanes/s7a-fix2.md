# Lane `s7a-fix2` — S7a round 2: one owner of a child's flat shape, a fuller fixture, `exclude_fields` on the flat shape

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you.
Then read the S7c review, `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/reviews/s7c.md`,
findings 1–3.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7a-integrated-schema`
- **Branch:** `dugshub/917-s7a-integrated-schema` (tip `0687f9ab`). S7b and S7c sit above it and will be rebased onto
  your result.

## Why

- S7c (`f02d9c3a`, on branch `dugshub/917-s7c-integrated-emitter`) added `flattenInheritedChild(def, definitions)` to
  `src/schema/inheritance.ts`.
- S7b is building the backend's own child flat field list.
- Two owners of one rule already disagree on a base `belongs_to`. The rule belongs at the bottom of the stack, where
  both can read it.

## What to do

1. **Move `flattenInheritedChild` here, as the one owner.**
   - Take its body from S7c's commit: `git show f02d9c3a -- src/schema/inheritance.ts`.
   - Put it in `src/schema/inheritance.ts` on this branch, **with the same name and signature**, so S7c's call site
     still compiles after its rebase.
   - From the **same walk**, expose which entity owns each flat field (and each relationship), for example
     `flatChildOwners(def, definitions)`. S7b then resolves a base enum or a base FK against the base.
   - One walk, two views. Never two walks.
   - Remove the `as never` casts the review names. Type the input contract properly.
   - Unit-test it on the fixture:
     - the flattened `mail_message` deep-equals what a flat declaration of the same columns parses to;
     - each field's owner is right;
     - a base `belongs_to` appears under the child, owned by the base;
     - a non-child comes back unchanged.
2. **A fuller fixture** (`test/fixtures/integrated-child/entities/`), so that later gates render every path:
   - add a small generic entity (for example `mailbox`), and a `belongs_to` from the base `inbox_item` to it;
   - give both children an `integration:` block that sets:
     - `emit_changes`;
     - the delete / tombstone behaviour the schema supports;
     - `sink.exclude_fields`, naming one **base** field.
   - Read `src/schema/entity-definition.schema.ts` for the exact keys. Copy shapes from existing integration fixtures.
   - Add the providers definition this fixture needs (`test/fixtures/integrated-child/definitions/providers/`): one
     generic provider serving **both** the mail and calendar surfaces, so that `calendar_event` is rendered too.
     - S7c added a mail-only `google.yaml` at that path. Use the same file name, so its rebase is an add/add conflict on
       one file, resolved to yours.
     - Keep the name generic. A provider name is not a host name, but follow the existing fixtures' convention.
   - The fixture must still validate clean (`entity validate --json`: exit 0, `valid: true`).
3. **`sink.exclude_fields` on a child is checked against the flat shape.**
   - Today `entity-definition.schema.ts:1480` checks it against the child's own fields, so a child that names a base
     field is refused.
   - For a child, the check moves to the cross-entity pass (`src/parser/validate-inheritance.ts`) and reads
     `flattenInheritedChild`. The single-file check skips children.
   - Tests:
     - a child that names a base field passes;
     - a name that is in neither entity fails, with the flat field list in the message.
   - Show the first test red on `0687f9ab`.
4. **RFC.** S7's §13.2 S7a entry:
   - describes the owner and the fuller fixture;
   - drops the stale claim that no integration-emit set holds the fixture (S7c's gate does);
   - says S7b and S7c consume `flattenInheritedChild`.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-baseline`. The baseline must stay byte-identical. Commit as
`fix(#917 S7a): one owner of a child's flat shape; fuller fixture; exclude_fields on the flat shape`. Do not push.
Report to `codegen-patterns-73`: the commit, the owner API (names and signatures) and the fixture changes, so the
coordinator can hand them to S7b and S7c.
