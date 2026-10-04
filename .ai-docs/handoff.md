# Handoff — 2026-10-04 — 0.31.0 shipped; hoops-data dogfood is ready for day 0

**Branch:** `main` @ `651ac6e8`. No worktrees, and no open PRs from this session.
**Last action:** released **@pattern-stack/codegen 0.31.0** to npm (2026-10-04 18:35 UTC; verified with curl against the
registry). It carries all of #578 plus the dogfood's three compile-blocker fixes: #732 (multi-word junction stems, plus
the has_many helper), #753 (two `belongs_to` onto one target; **breaking**: members are now keyed by relationship name),
#755 (`string_array` → `text[]`), and #756 (Studio light theme).
**Next action:** day 0 of the **hoops-data** app, hands-on (Doug). Open the cockpit
https://claude.ai/artifact/9y8KFZp2GcDDXdxyyoamTc, then follow `~/Projects/dug/hoops-data/.ai-docs/projects/hoops/PLAN.md`
§5.5 "Day-0 bootstrap". Install `@pattern-stack/codegen@0.31.0` (or vendor the runtime from this checkout), and model
the reference entities in Studio.
**Obstacles:**
- Docker isn't running locally. Postgres, `cg dev up`, Studio's DB push and `test-integration` all need it.
- Open findings the app will meet: #733 (Electric shapes have no tenant filter) and #704 (global → junction include
  leaks). Neither bites while the app is single-tenant (decided). Also #734 (the generated AggregateModel lacks catalog
  measures; workaround `measuresFromRegistry`), and #736, #737, #739–#749.

## Notes
- **The dogfood lives in `~/Projects/dug/hoops-data/`:** the plan, seven research reports, the five Herdr agent
  briefs and reports, indexed with their final outcomes in `.ai-docs/projects/hoops/briefs/README.md`, the story page https://claude.ai/artifact/3DALXjEvdMt1kkS5fsAJMu,
  and the rankings and projection reference scripts (`oracle/draft_kit.py`, `oracle/projections.py`, `oracle/knobs.toml`).
- **Agents:** Herdr agents in `--permission-mode auto` are refused `gh pr merge` ("Merge Without Review"). The lead
  session merges after Doug approves.
- **Local environment:**
  - Run `just install` after any long gap.
  - Gitignored leftovers from the June `clean` pipeline (`packages/api/src/{application,…}`) and a stale `bun.lock` broke
    local gates. They were moved aside, so the local gates are green.
  - On macOS, `TMPDIR` must be resolved (`/var` → `/private/var`) for the studio tests (#750).
  - A fresh worktree needs `mise trust` before `just install`.
- **Consumers still pinned to old versions:** sdlc-patterns (0.26.1), swe-brain, and aloevera-ts (0.28.3).
- **#679** (junction/relationship convergence) is still the main design item. The hoops-data roster and player-team
  stints are its worked example.
