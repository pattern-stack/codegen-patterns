# Report: gaps batch 1 — built, reviewed, ready to merge

**Status (2026-11-07):** all 8 PRs are built, reviewed (Gate 2.5 PASS_WITH_NOTES, every should-fix applied) and green
on CI (`test-all` + `test-integration`). They are merge-chained into one stack. Waiting on the owner to merge, then
release 0.32.0 (#818).

- Plan: `.ai-docs/plans/gaps-batch1.yaml` (Gate 0 approved, all 12 recommendations), copy at
  `.ai-docs/stacks/gaps-batch1/plan.yaml`.
- Specs: `.ai-docs/stacks/gaps-batch1/*.md`, each on its PR's branch, updated to as-built.
- Epics: #783, #793, #794.

## Merge order (bottom-up; each PR's base is the one above it)

| # | PR | Issue | Base | Notes |
|---|---|---|---|---|
| 1 | #826 | #511 field `unique: true` emits a unique index | `main` | breaking (`!`): new DDL |
| 2 | #834 | #784 `unique_indexes`: `where`, `nulls_not_distinct`, 1-field | #826 | breaking: tenant uniques become `UNIQUE NULLS NOT DISTINCT` (PG 15+); D1 approved: a field `unique: true` on a tenant-scoped entity gets NND too |
| 3 | #835 | #796 datetime + behaviour columns → timestamptz, `timezone: false` opts out | #834 | breaking: migrate under `SET TIME ZONE 'UTC'`; `push` users set DB default TZ to UTC first |
| 4 | #824 | #814 package-mode `TypedEventBus` import | #835 | |
| 5 | #822 | #811 `api: false` barrel | #824 | |
| 6 | #825 | #813 reserved entity names | #822 | one review suggestion skipped on purpose (would flag correct code); spec says why |
| 7 | #827 | #815 `entity new --all` single pass | #825 | |
| 8 | #823 | #742 include paths accept snake_case | #827 | top of stack; its CI covers the whole batch |

The stack is built with plain merges, not rebases. No force-push was used. Squash-merging bottom-up gives a clean
`main`. If something lands on `main` first, merge `main` into #826 and cascade the merge upward.

## Then: release 0.32.0 (#818, owner's)

Minor bump. CHANGELOG = each PR's "Changelog:" block + the fixes already on `main` since 0.31.0: #744 (06dc0b54),
#745, #746, #750, #751, #736/#613, #694, #734.

## Follow-ups filed (next batch candidates)

- Under #783: #819 non-unique `indexes:` (needs:design), #820 `tenant: false` (gate:human), #821 unique finder must be
  backed by a constraint, #829 `external_id_tracking` NND may reject a second POST (unconfirmed), #830 emits payload
  uses `dto.<key>` in delete/update, #831 `temporal_validity` emits no columns, #832 junction/relationship fields
  ignore `index:`/`unique:`, #833 entity names `page`/`post`/`patch`/`query`/`body`/`param` collide with controller
  imports.
- Under #794: #828 unique violation (23505) returns 500 instead of 409.

## Housekeeping done

- Agent worktrees and their temp branches removed. Feature branches live on origin only.
- Closed #64, #356, #355 as already done.
