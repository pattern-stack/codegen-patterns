# Handoff — 2026-10-04 (evening) — dogfood fixes + SEM-4 merged; hoops-data build underway

**Branch:** `main` @ `6befc42f`. Clean; no worktrees, no open PRs from this session.
**Last action:** merged SEM-4 (#694, PR #768) + #734 (PR #769) as gh stack #770. The semantic emitter now imports
`@pattern-stack/query-surface@0.3.1`, the mirror is gone, and `{ref}` measures resolve. Epic #581 is closed. Earlier
today: the dogfood fixes #759 (#750), #760 (#751), #761 (#746), #762 (#745), #763 (#744), #764 (#736 + #613).
**These are all unreleased since 0.31.0.**
**Next action:**
- **Doug, in hoops-data:** model the app slice by slice with Herdr agent `build` (pane `w1:p4`, brief
  `~/Projects/dug/hoops-data/.ai-docs/projects/hoops/KICKOFF.md`).
- **Codegen side, when Doug says go:** step 3 of the valuation order
  (`hoops-data/.ai-docs/projects/hoops/briefs/valuation-pitch.response.md`): `stddev_pop` / `stddev_samp` / `var_pop`
  / `var_samp` in query-surface, then codegen's `agg` enum.

**Obstacles:**
- Codegen bugs the app will hit: **#767** (the generated `GET /<plural>/search` returns 400, because `:id` is
  registered first), **#766** (Studio can't create an entity), **#740** (junction payload fields are always nullable).
  Also #758, #742, #739.
- Waiting on Doug: #752 (FE-REL graph hooks for `sync: api`), #679 (junction/relationship convergence), and whether
  to cut **0.31.1** for today's fixes.
- #578's dashboard body is stale (dated 2026-09-18).

## Notes
- **hoops-data** (local repo, no remote) uses the vendored runtime from this checkout. Pull codegen fixes in with
  `cg project update --force && cg entity new --all --force`. Its cockpit
  https://claude.ai/artifact/9y8KFZp2GcDDXdxyyoamTc (v10+) is the project's handoff.
- **Running:** Studio is in Herdr tab `studio` (`w1:p6`, `just studio ~/Projects/dug/hoops-data`, UI :5179), and the
  dev stack is up (`cg dev up`: Postgres :5433, Redis :6380, app :3000).
- **Two sessions commit in hoops-data:** `hoops-data-89` and `build`. Stage only your own hunks there.
- **Briefs and reports from today:** `hoops-data/.ai-docs/projects/hoops/briefs/` (`fixes-2`, `sem4`, `valuation-pitch`).
  The fixes2 report's follow-ups 3–7 are listed unfiled in PLAN §8.
- Pattern that worked: agents open independent PRs, and the lead restacks them with `gh stack init` for one atomic
  `gh stack merge`. Turn off auto-merge first, or PRs land one by one (#759, #761 and #762 did).
