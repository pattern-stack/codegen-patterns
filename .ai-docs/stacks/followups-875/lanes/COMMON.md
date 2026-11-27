# #875 follow-ups — rules for every lane

You build or review **one issue** in **one worktree**, for the coordinator session `codegen-patterns-73` (hc terminal
`t1rf`). Read `CLAUDE.md` at the worktree root first; every rule there binds you (no backwards compat; specs are living
docs; a gate must be able to fail on its own subject; smoke tsc scoping; the naming rules).

- **This repository is public.** No host-application, company or customer names anywhere: code, comments, test names,
  fixtures, commit messages. Before every commit, run
  `git diff --cached | grep -inE "$PRIVATE_NAMES_RE"` (the private-names pattern the lead supplies; never written into this public repo).
- **No sub-agents.** Stay inside the issue's scope; if the fix needs to cross it, stop and report why.
- **Git:** commit on your branch. **Never push, never open a PR, never merge.**
- **Gates:** run the issue's gates after your last edit and paste their tails. No filtered error class, no directory
  carve-out, no loosened assertion. A gate you add must be able to fail on its subject: break the subject, watch it go
  red, restore it.
- **Fresh worktree:** `mise trust && just install` first.
- **Report** with `SendMessage` to `codegen-patterns-73`. If that name doesn't resolve, use `ListAgents` and find hc
  terminal `t1rf`. A builder reports commits, files, gate tails, what was unsure and what was left undone. A reviewer
  reports a verdict (`ACCEPT` / `ACCEPT_WITH_FIXES` / `REVISE`), then numbered findings with `path:line`, a failure
  scenario and severity, each verified against the branch.
