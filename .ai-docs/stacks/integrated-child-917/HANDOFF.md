# S7 (#917) handoff: `pattern: Integrated` on a joined-table child

Written 2026-11-16, at CP2, by coordinator session `codegen-patterns-73`. S7 is paused here because the session is
closing. **Nothing in S7 is merged.** This file is the entry point for the next session. It names no host application.

## The rule S7 exists for

**A provider sync has no opinion on an entity's family hierarchy.** The same integration YAML targets a plain entity or
a joined-table child (RFC-0006 `inherits:`). Both generate, compile and sync, and the integration layer (sink,
`changeSources`, read primitive, module assembly) is byte-identical for the two.

Read first:
- `docs/rfcs/RFC-0006-joined-table-inheritance.md`: §4.2, §8, §11.3 (with its S7 decisions table), and §13.2 S7 (the
  S7a / S7b / S7c as-built entries are on the branches);
- issue #917, including its latest comment.

## State

| Slice | PR (draft) | Branch | Tip | Worktree (`/Users/dug/Projects/worktrees/codegen-patterns/…`) |
|---|---|---|---|---|
| S7a: schema, rules, fixture, the flat-shape owner | #935 | `dugshub/917-s7a-integrated-schema` | `6ec08b26` | `dugshub-917-s7a-integrated-schema` |
| S7b: the repository writes and reads through the base | #936 | `dugshub/917-s7b-integrated-repository` | `08535e1d` | `dugshub-917-s7b-integrated-repository` |
| S7c: the integration layer is family-blind | #937 | `dugshub/917-s7c-integrated-emitter` | `b274993b` | `dugshub-917-s7c-integrated-emitter` |
| S7d: integration tier | — | not started | — | — |

- **GitHub stack:** #938 (`gh stack link 935 936 937`). Local `gh stack` tracking was **not** initialised: each branch
  is checked out in its own worktree, which `gh stack` cannot switch between. Before a `gh stack rebase` / `submit` /
  `merge`, re-adopt the stack (`gh stack init <s7a> <s7b> <s7c> [<s7d>]`) from a checkout that can switch branches.
  Alternatively, rebase by hand with `git rebase --onto`, as this session did.
- **Base:** the stack sits on `243e277c`. `main` has since moved to `b82f37db` (#928 release 0.34.0, #929 a Studio fix).
  Rebase onto `main` before CP3. S7 ships in a release after 0.34.0.
- **Gates on the S7c tip** (`b274993b`, coordinator run after the last edit): `just test-all` exits 0;
  `just test-integration` 335 pass / 2 skip / 0 fail; the tree is clean.
- **Reviews:** each slice had one Opus xhigh review (adherence and quality lenses). Each review is posted on its PR,
  followed by a fix table. Local copies are in `reviews/s7a.md`, `s7b.md` and `s7c.md`. These are slice reviews,
  **not** the Gate 2.5 paired-lens reviews, which are still to come.
- **Lane briefs** that built it are in `lanes/`:
  - `COMMON.md`, the rules every S7 lane reads;
  - `s7a-build.md`, `s7b-build.md`, `s7c-build.md`;
  - the fix briefs and `review.md`.
  Reuse their shape for S7d.

## Decisions (all Doug's)

| # | Decision | Date |
|---|---|---|
| D1 | The base declares `external_id_tracking` explicitly, plus `natural_key: true` on exactly `[provider, external_id]`. A child declaring Integrated never adds a column to the base. A short base is an error naming both entities. | 2026-11-15 |
| D2 | `pattern: Integrated` (and `surface:` / `integration:` / `detection:`) on a **base** is refused in S7. **#927** owns it. | 2026-11-15 |
| D3 | Two Integrated children per base are allowed. They share the base's `(tenant, provider, external_id)` key; the same id under another kind is `KindMismatchError`. | 2026-11-15 |
| D4 | The tombstone is as today: soft-delete the base row with `soft_delete`, else null `provider` / `external_id` on it. Always scoped to the child's kind. | 2026-11-15 |
| D5 | Moot. R9 (no `eav: true` in a family) stays, so no child reaches the Integrated EAV path. | 2026-11-15 |
| D1 consequences (no veto) | One constraint: the natural key adopts the behaviour's unique, with NULLs distinct. R11 accepts exactly the nullable identity pair, and `upsertByNaturalKey` refuses a NULL key value (`NaturalKeyNullError`). There is at most one natural key. | 2026-11-15 |
| **S7-D6** | **(A)** A child's sync is indistinguishable from a plain entity's. The sink calls the repository, so no service lifecycle event fires for any entity. With `emit_changes`, `<child>_created` / `_edited` / `_deleted` are published under the child's name only, with no base-named event. | 2026-11-16 |
| #930 | **(A)** `integration.sink.exclude_fields` naming a NOT NULL column with no default is refused at validation. **Not built yet.** | 2026-11-16 |

**Record S7-D6 in RFC §11.3's S7 table.** It is not there yet: S7b's RFC entry still says "pending Doug (S7-D6)".

## What is built (short; the PR bodies have the detail)

- **S7a.**
  - The §8 child refusals are lifted, and D2 refuses the same keys on a base.
  - New rules: D1 in `validate-inheritance.ts`; R5 implied versus declared; R6 with `readsThroughBase` on the pattern
    definition; R11 accepting the pair only on a tracking base. The identity pair is
    `BehaviorDefinition.identityColumns`.
  - **`flatChildShape(def, definitions)`** (`src/schema/inheritance.ts`) is the one owner of a child's flat shape, with
    the owner of each field and relationship. `flattenInheritedChild` and `flatChildOwners` are projections of it.
  - `exclude_fields` on a child is checked against the flat shape.
  - The fixture is `test/fixtures/integrated-child/`: base `inbox_item` (kinds `mail_message`, `calendar_event` and a
    base-only `note`; an optional `preview` that the sinks exclude), plus `mailbox`, plus the provider `google`
    serving mail and calendar.
- **S7b.**
  - No identity columns on the child table. One adopted constraint on the base, plus the NULL guard.
  - The child extends `IntegratedEntityRepository` and overrides only the protected persist hook `writeIntegrationRow`,
    which calls the pair `upsertByNaturalKey`.
  - Reads and the tombstone are forwarded to the base as derived kinds `integration_find` / `_find_many` /
    `_find_projected` / `_tombstone`, with the flag `repository.persistHook`. Each is an inner join under the child's
    scope, so a cross-kind tombstone touches nothing.
  - The fixture is copied into the baseline and scaffold sets, with a drift test.
  - Docker tests: `test/scaffold/tests/integrated-child.test.ts`.
- **S7c.**
  - `test/integration-emit/family-blind.test.ts` renders each child's integration layer twice: from the flat twin
    `test/fixtures/integrated-child-flat/`, and from the family. It requires byte-identical trees.
  - `emitAdapters` flattens once, through `flatChildShape`.

## Next steps, in order

1. **Record S7-D6 in RFC §11.3**, and drop the "pending Doug (S7-D6)" note in S7b's §13.2 entry. Commit it on S7b and
   cascade S7c, or put it in S7d if that is simpler (the stack squash-lands).
2. **S7d: the integration tier** (new branch on S7c, `dugshub/917-s7d-integration-tier`).
   - Add the family to `test-smoke-integration` (`test/smoke-integration/run.ts`). The family's integration layer is
     then compiled against the generated backend. **No gate compiles it today:** the baseline runner calls hygen, not
     the CLI, so it never reads the provider definition.
   - Add a Docker test that syncs provider objects into the family **through the generated sink**, end to end:
     - create, then update (the excluded `preview` is left alone);
     - the tombstone, on a `soft_delete` base and on a non-`soft_delete` base;
     - a kind mismatch;
     - orphan repair;
     - `emit_changes` publishing under the child's name only (D6);
     - a cross-kind tombstone that does nothing.
     S7b's scaffold tests call the repository directly; S7d's go through the sink.
   - Do not exercise `mailboxExternalId`: its FK resolver is #779.
   - Fill in #917's "Done when" against the result, and write S7d's RFC as-built entry. Update §8, and §4.2's S7 note to
     "as built".
   - One Opus xhigh review, then fixes.
3. **Rebase the stack onto `main`**, and run `just test-all` and `just test-integration` on the tip.
4. **Gate 2.5:** paired-lens reviews (adherence and quality) on all four PRs. Post them, fix, cascade, re-gate.
5. **CP3: stop for Doug.** He merges (`gh stack merge --yes --squash` after re-adopting the stack; only the tip must be
   green).
6. **Follow-ups decided but not built**, each its own small PR off `main`, with no auto-merge:
   - **#930:** refuse a NOT NULL, no-default column in `exclude_fields`, for every entity. Test it both ways: required
     with no default is refused; optional or defaulted is accepted.
   - **Rename the #875 inheritance test fixtures** to unrelated generic names. Doug asked for this on 2026-11-16 because
     they mirror a real application's model. In scope: the family in `test/fixtures/inheritance/entities/`
     (`communication`, `communication_note`, `communication_part`, `communication_participant`,
     `communication_participant_role`, `email`, `email_communication_part`, `email_thread`, `meeting`,
     `meeting_transcript`, `message_communication_part`, `party`, `transcript_communication_part`) and every copy and
     golden derived from it:
     - `test/fixtures/entities/`;
     - `test/smoke/fixtures/`, `test/smoke/fixtures-frontend/{entities,consumer}`, `test/scaffold/entities/`;
     - `test/baseline/**`, `test/api-surface-golden/**`, the frontend goldens;
     - the tests that name them;
     - the RFC-0006 examples.
     Regenerate the goldens with each test's update flag. The fixture-agreement test must stay green. **Ask Doug** about
     the boundary before starting: the library pattern `src/patterns/library/communication.pattern.ts`, the pre-#875
     fixtures that also use these words (`test/render-golden/matrix-one-capability` `meetings`, and
     `packages/codegen-transcript`), and S7's own `inbox_item` / `mail_message` / `calendar_event` (named after
     codegen's own `mail` / `calendar` surfaces).
7. **Open issues from S7's reviews** (not decided, predate S7): #931 (the second tombstone in a tenant fails on the
   NULLS NOT DISTINCT identity unique) and #932 (a golden reads repo-root `junctions/`).

## Gotchas this session hit

- **Gates.** A lane's brief must list `just test-studio` whenever it adds a derived surface kind. S7b missed it, and
  only the coordinator's `test-all` caught it.
- **`junctions/` leftovers.** A `--no-teardown` scaffold run leaves repo-root `junctions/`, which turns `test-unit`
  red (#932). Delete it before gating.
- **Parallel runs.** The old temp-dir race between parallel `test-all` runs is fixed on `main` (#923). The S7 base
  includes the fix.
- **Rebases.** When a review fix moves a rule down the stack, rebase the upper slices by hand
  (`git rebase --onto <new parent> <old parent>`). RFC §13.2 conflicts are always "keep both entries, in slice
  order".
- **Public repo.** Before every commit, push, PR and comment, grep for host-application names. This session's posts
  each had zero hits.
- **Doug's standing rules:** never merge or push without his word; no auto-merge on stack PRs; ask decisions in the
  terminal or through `codegen-patterns-7f`.
