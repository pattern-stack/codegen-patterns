# Handoff — 2026-09-17 — relations-v2 + semantic model project opened

**Active project:** `relations-v2-and-semantic-model` — tracker #578, board https://github.com/orgs/pattern-stack/projects/3
**Start here:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter: goal, invariants, decisions,
update protocol). State lives on #578 (body = current dashboard, comments = log), not in this file.

**Last action:** Planning closed. ADR-044 (relations are the core read contract) accepted; ADR-042 accepted; charter,
`PLAN.md`, `plan.yaml` on `main`; 13 tasks under 4 epics filed (#579–#595) + pattern-stack/query-surface#40.
**Next action:** `/design` → `/develop` on **#583 (DRZ-1)**, then **#584 (DRZ-2)**, then the mandatory checkpoint
(charter §6) before the REL / SEM / CAP tracks fan out.
**Obstacles:**
- Open question Q1 (charter §7) blocks FE-REL design only.
- Agent `isolation: "worktree"` was reported broken by a plugin telemetry hook (2026-06-07). Unverified since; until
  confirmed fixed, create worktrees manually (`git worktree add worktrees/<key> origin/main`) and verify with
  `git status` after spawning.

## Notes
- Older open issues not part of this project remain on the board-less backlog (#575, #576 — the latter is absorbed by
  #584; #520/#521 tarball-gate debt; #512 checkout bump overdue; #557 looks closable after 0.30.0).
- Previous handoff (2026-06-07, jobs worker-scaffold train) is superseded; see git history.
