# Orchestrate: API-surface derivation, Phase A → S1

You are the **orchestrator** (lead) for the plan in `PLAN.md` (this folder). Read it in full — especially §1, §4,
§9, §14 — and the repo's `CLAUDE.md`, before doing anything. The plan and §14's execution protocol are your
contract. Doug approved it on 2026-11-13, with **`src/derived/api/`** as the module location (decided — do not
reopen).

## Scope of this run

**A0, then A1, then STOP at sign-off S1** (§14.5). Do not start A2. After S1 is approved you will be told to
continue (A2 → A4 → S2, and so on); keep this file's rules for the whole run.

## Where

- Worktree: `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-a0` — already checked out on branch
  `dugshub/api-surface-a0`, which sits on `dugshub/api-surface-plan` (the plan commit `55acacdb`) on `main` @
  `074cce00`. Run `mise trust && just install` first.
- `main` moved from the plan's basis `c1ceeefd` to `074cce00` (the 0.33.0 release). The lead checked: no change in
  `templates/`, `src/studio`, `tools/studio`, `src/emitters/relations`, `src/schema`. Re-verify that as part of P0.
- Stack: use `gh stack` (load the `gh-stack` skill). Phase A = the plan commit + A0 … A5, one stack. A0 and A1 are
  separate branches/PRs (`dugshub/api-surface-a0`, `dugshub/api-surface-a1`). The plan commit can ride in A0's PR.

## How

- You may start **build lanes** through Herdr (load the `herdr` skill): `hc run --bg --no-notify --name <lane>
  --cwd <worktree> claude --model opus --effort medium --permission-mode auto "<brief>"`. One lane per PR, a brief
  file per lane, scope exactly that PR. Lanes may not start agents, may not push, may not open PRs, may not merge.
  Or build small PRs (A0) yourself — your call.
- **You certify, lanes don't** (§14.1): re-run every exit check on the PR head yourself and paste *that* output into
  the PR body (§14.7).
- Run the mutation checks exactly as §14.2 writes them; revert each; confirm `git status --porcelain` is unchanged.
- Long gates (`just test-all`, `just test-integration`) run as named Herdr terminals via `herdr-watch`, not
  background Bash.
- Keep `PLAN.md` the post-implementation truth: anything built differently goes in the PR's "Differs from plan" and
  is corrected in PLAN.md / ADR-046 in the same PR (CLAUDE.md § Operating Principles).

## Hard rules

- §14.3 anti-cheat rules and §14.6 stop conditions are binding. A stop means: halt and report, don't push on.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table
  names or "dogfood" references into code, comments, commits, PR bodies, issues or CHANGELOG; say "a host
  application". Put this rule in every lane brief.
- **No merges, no auto-merge.** `gh stack submit` with auto *titles* is fine; never enable auto-merge; never run
  `gh pr merge` / `gh stack merge`. Doug merges.
- Do not file issues on the public tracker without Doug's approval (draft them in the S1 packet instead).
- Commit attribution lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01C62kxaDucsoCDjiCxrjYhB`; PR bodies end with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Reporting

Report to the lead with `SendMessage` to **`codegen-patterns-7f`** (hc terminal **`t1hz`**). If the name doesn't
resolve, find it with `ListAgents` (starts `codegen-patterns-`) and check against `hc get t1hz`.

- At each PR opened: one line — PR number, gates green/red.
- At **S1**: the packet §14.5 describes — publish the story page as an Artifact (load `artifact-design` first) showing
  the derived surface of the demo `contact` and `account` as tables with origin chips, `types.ts`, ADR-046 + the
  CLAUDE.md rule, the eight mutation checks with red output, the oddities list, the unit-time number — then report
  the link and stop.
- At any stop condition: what tripped, the evidence, your recommended answer.
