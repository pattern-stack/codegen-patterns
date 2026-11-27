# #875 `inherits:` build — rules for every lane

You are one lane of a six-slice stacked build of issue #875 (joined-table inheritance). A coordinator session
(`codegen-patterns-73`, hc terminal `t1rf`) owns the plan, the git stack and acceptance. You build or review **one
slice** in **one worktree**.

## Read first, in this order

1. `CLAUDE.md` at the worktree root — every rule there binds you (no backwards compat; specs are living docs; gates
   must be able to fail on their own subject; smoke tsc scoping; naming rules — `emittedStem`, `sqlTableName`,
   `projectEntityLookup`, never `pluralize(target)`).
2. `docs/rfcs/RFC-0006-joined-table-inheritance.md` — the design. §11 holds the decided answers (revision 3; OQ-11
   is decided: the part-kind rule is `choices_of:` + `match:` on the discriminator, and there is **no user-facing
   `checks:` key** in this build). §13 is the build plan; your slice's entry there is your scope.
3. `gh issue view 875` — the acceptance list. The issue body still lists `checks:` under A1; the RFC (revision 3)
   wins. Do not edit the issue.
4. `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4 — the charter invariants (I1–I9) bind any change
   touching relations, repositories/services, tenant scoping or the frontend emitter's relations.

## Hard rules

- **This repository is public.** No host-application, company or customer names anywhere — code, comments, test
  names, fixtures, commit messages, the RFC. Say "a host application" / "the first consumer". Before every commit
  run `git diff --cached | grep -inE "$PRIVATE_NAMES_RE"` and it must print nothing.
  (the pattern of private host-application names; the lead supplies it, and it is never written into this public repo)
- **No sub-agents.** Do the work yourself in this terminal.
- **Stay inside your slice.** Each slice in RFC §13.2 says what it touches and what it must not touch. If you need to
  cross that line, stop and report why instead of crossing it.
- **Git:** commit on your branch, in logical commits. **Never push, never open a PR, never rebase another branch,
  never merge.** The coordinator owns that.
- **Gates:** run every gate your slice lists, after your last edit, and paste the tail of each output in your report.
  No filtered error class, no directory carve-out, no loosened assertion. A gate you add must be able to fail on its
  own subject — show that once (break the subject, watch it go red, restore).
- **The RFC is living documentation.** When the build shows the RFC is wrong or underspecified, fix the RFC in your
  slice and say so in your report. If the fix would change a **§11.1 decision**, do not change it: stop and report.
- **Fresh worktree setup:** `mise trust && just install` before anything else. Docker gates derive their own
  per-checkout ports/projects (`just db-env`); never set a fixed global name.
- **Context:** if your context passes 70%, finish the step you are on, write a handoff to
  `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/handoffs/<your lane name>.md` and say so in
  a report; the coordinator will refresh you.

## Reporting

Report with the `SendMessage` tool to `codegen-patterns-73`. If that name does not resolve, run `ListAgents`, find the
session whose hc terminal is `t1rf` (names start with `codegen-patterns-`), and send there. Never type into another
terminal.

A **builder's** final report: commits (`git log --oneline main..HEAD`), files changed (`git diff --stat main...HEAD`
— or against the slice's base branch if told), each gate with its last lines, what you changed in the RFC, anything
you were unsure about, and anything left undone. Say plainly if a gate is red.

A **reviewer's** final report: verdict `ACCEPT` / `ACCEPT_WITH_FIXES` / `REVISE`, then numbered findings, each with
`path:line`, the defect, a concrete failure scenario, and severity (`blocker` / `should-fix` / `nit`). Verify every
claim against the branch code; do not report what you have not checked. Reviewers do not edit files.
