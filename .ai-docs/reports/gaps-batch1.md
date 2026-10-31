# Report: gaps-batch1, Gate 0 plan ready

**Status:** the plan is ready for Gate 0 and has **not** been approved. Nothing is committed, pushed, synced to the tracker or built. Both files sit uncommitted on `dugshub/gaps-batch1-plan` (base `a8629dfc`).

**Plan:** `.ai-docs/plans/gaps-batch1.yaml` (571 lines). The `sdlc:planner` agent wrote it (Opus, xhigh). The plan links to the existing issues instead of creating new ones. The release is the only new issue.

**#744:** the fix `06dc0b54` (PR #763) is on `main` but hasn't been released. npm and `package.json` are both still at 0.31.0. Nine fixes have landed since the 0.31.0 bump: #750, #745, #746, #751, #736/#613, #744, SEM-4 #694 and #734.

## Stacks and order

Merge and restack order is A → B → C → #742 → release. When baseline snapshots conflict, regenerate them rather than merging by hand (#796 and #813 both rewrite most of `test/baseline/**`). The critical path is #511 → #784 → release.

| # | Item | Stack | Size | Gate | What it retires in the host (from the ranking) |
|---|---|---|---|---|---|
| 1 | **#511**: field `unique: true` emits a real (per-tenant) unique | A | S | auto | The rest of the post-gen step's single-field unique rewrite (nk1) |
| 2 | **#784**: `unique_indexes` gets `where`, `nulls_not_distinct` and 1-field entries (needs #511) | A | M | **human** | nk1 on 33 entities, nnd (4 natural keys), 4 partial uniques in the lowering step (04). With #511 this retires all of nk1 |
| 3 | **#796**: `datetime` plus the timestamps/soft-delete columns become timestamptz, opt out with `timezone: false` | A | M | **human** | Lowering step 02 (93 fields on 48 entities) and the `TZ=UTC` guard. The host needs one forward `ALTER … TYPE timestamptz` migration |
| 4 | **#814**: package-mode use cases import the token from the package and `TypedEventBus` from the consumer's generated bus | B | M | auto | Post-gen pkg-1 (the import rewrite in every `emits:` entity's write use cases) |
| 5 | **#811**: the `api: false` barrel only exports the controller when it was emitted | B | S | auto | Post-gen 18a (29 export lines) |
| 6 | **#813**: reserved entity names (collision-safe template locals and `Record`, plus a reserved-name validation error) | C | M | auto | Forced entity renames (a `record` entity, the `item` plural) |
| 7 | **#815**: `entity new --all` finishes in a single pass (the `has_many` existence check uses the generation set) | C | M | auto | The second `entity new --all` pass in the host's gen recipe |
| 8 | **#742**: include paths accept snake_case via camelCase normalisation; a miss lists the keys and says "did you mean" | independent | S | auto | 1 include-path rewrite in the lowering step |
| 9 | **Release 0.32.0** (Doug's), minor. Ships batch 1 plus all 9 unreleased fixes, #744 included | release | — | human | The 8 dropped `queries.search` in the lowering step (via #744). It also unblocks the host's bump PR |

With batch 1 shipped, the host's post-gen step retires everything except i8, which waits on #795. That leaves the lowering step with only the schema gaps.

## Open questions for Doug at Gate 0

The plan YAML has a recommendation for each one.

1. **#784 `where:`:** raw SQL, with snake_case column names rewritten to `${t.col}` and no keyword validation in batch 1.
2. **#784 names:** require `name:` whenever `where:` is set, because default names collide and Postgres truncates identifiers at 63 characters.
3. **#784 tenant default:** tenant-prefixed entries without `where` default to NULLS NOT DISTINCT, with an opt-out. The cost:
   - the DDL of existing tenant uniques changes;
   - it needs PostgreSQL 15+;
   - a partial entry still can't dedupe rows whose tenant is null;
   - ADR-042 gets a revision note.
4. **#784 Q3/Q4:** `tenant: false` and non-unique `indexes:` stay out of batch 1 and become follow-ups under #783.
5. **#511:** `queries: [{unique: true}]` stays a finder hint. A follow-up adds a check that each unique finder has a constraint behind it.
6. **#796 scope:**
   - Junction and relationship timestamps are in.
   - #771 is out (those are `date` columns, which belong with #776).
   - The test risk is that a naive TZ round-trip test may already pass on the base commit. The test has to use a non-UTC DB session plus `defaultNow()`, and be shown failing on the base commit.
7. **#813:** a reserved name is an error, not a warning. The exact list is settled at spec time.
8. **#742:** accept both spellings.
9. **Release level:** minor (0.32.0), because the DDL changes and `^0.31.0` would pull a 0.x patch automatically.
10. **Syncing:** don't run `/sync-issues` as written. It would duplicate the existing issues and overwrite their bodies on a re-sync. Go to `/design` on the existing issues instead, and file the release issue by hand.
11. **Plan location:** sdlc agents look for `.ai-docs/stacks/*/plan.yaml`. If they need to find the plan, copy it to `.ai-docs/stacks/gaps-batch1/plan.yaml`.
12. **Tracker cleanup:** close #64 and #356 as already done. #355 probably can be closed too.

## Not done (per brief)

- `gate:human` is **not** set on the tracker. #796 and #784 already carry it on GitHub; the plan sets it in the YAML only, because no tracker writes happen before Gate 0.
- No code, no push, no PR, no tags. The plan was public-repo-checked: no host names, paths or IPs.

Idle. Waiting on Gate 0.
