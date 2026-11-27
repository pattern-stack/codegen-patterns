# Lane brief — release 0.34.0: version bump and CHANGELOG

You are a **build lane for one PR**: the 0.34.0 release, owner-requested on 2026-11-15. The PR has the same shape as
#873 (the 0.33.0 release): **`CHANGELOG.md` and `package.json` only**.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-release-0-34-0`, branch
  `dugshub/release-0.34.0`, on `origin/main` @ `243e277c`. Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage`; if that doesn't
  resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`).

## The task

1. `just bump minor` → `package.json` 0.33.0 → 0.34.0. Check that `git diff --stat` shows only `package.json` (if
   the recipe touches anything else, stop and report).
2. Write the `## [0.34.0]` section of `CHANGELOG.md`, dated **2026-11-15**, covering **every** PR merged since
   0.33.0. List them with `git log --oneline 074cce00..origin/main` (25 commits). Read each one with
   `gh pr view <n>` (body and files) and, where a claim is about behaviour, with the code at `origin/main`.
3. **Follow 0.33.0's own section as the style model.** Read it, and #873's diff (`gh pr diff 873`), first. In
   particular:
   - a one-paragraph lead;
   - an explicit line saying whether the release is **Breaking**, and why or why not;
   - **numbered "Upgrading from 0.33.0" steps**, only where a consumer must act;
   - then the grouped entries, each naming its PR or issue numbers.
   - If #873 moved an `[Unreleased]` section into the release, do the same with whatever `[Unreleased]` holds now.
     Don't drop anything that's there.

## What must be covered (the owner's list; verify each, add anything else the log shows)

- **ADR-046 Phase A**:
  - the derived API surface (`src/derived/api/`);
  - `codegen project surface`;
  - Studio's API tab and edge view.
- **ADR-046 Phase B**:
  - every entity-backend template prints from the derivation;
  - one finder-name rule (#711);
  - generated output is byte-identical.
- **Studio**:
  - STUDIO-3, the tree canvas (spine parents, secondary lines);
  - STUDIO-4: trees wrap into rows; one-card trees dock under the card that references them; the inspector can be
    hidden; the fit keeps the legend off the cards;
  - #778.
  - **STUDIO-4 is PR #900. Check whether it's merged** (`gh pr view 900 --json state`). If it isn't, leave it out
    and say so in your report.
- **#875, joined-table inheritance:**
  - `inherits:`, `discriminator:`, `match:`, `natural_key:`, `choices_of:`;
  - DDL, reads, writes, HTTP;
  - the frontend `WithBase`.
  - Describe what a consumer writes and what they get. Verify each key name in the schema
    (`src/schema/entity-definition.schema.ts`).
- **#918: invalid YAML is now a run-level rejection.** This is a **behaviour change**:
  - Give it an upgrade note: what used to happen, what happens now, and what a consumer with an invalid file sees and
    does.
  - Verify the exact command behaviour in code and tests.
- **#926 and D15: emitted backend and frontend code names lib globals as `globalThis.*`.**
  - These are **byte changes to generated files**, not breaking. Say so explicitly: a regenerate rewrites those
    files, and nothing a consumer wrote needs to change.
  - Verify against the PRs (find D15's PR in the log).
- **#924, #919, #923**: read each one and describe it accurately.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave the two files changed and uncommitted; the lead
  certifies and commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names or
  "dogfood" references in the CHANGELOG; say "a host application". Some PR bodies or issues may mention a host model.
  Don't copy those words. Use generic examples.
- **Every claim verified.** No claim from memory or from a PR title alone.
  - If a PR body and the code disagree, the code wins. Say so in your report.
  - Don't invent version numbers, dates or commands.
- Scope: `CHANGELOG.md` and `package.json` only.
- **Stop and report** on anything you can't verify or that this brief doesn't answer.

## Exit

1. `git diff --stat` → exactly `CHANGELOG.md` and `package.json`; `jq -r .version package.json` → `0.34.0`.
2. Private-name scan of the new section: grep it case-insensitively for `dogfood` and for any entity or table name
   you saw in a PR that isn't a generic test fixture → no hits.
3. Don't run `test-all` or `publish-ci`; the lead does.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short:
- The list of PRs covered (number → one line).
- **A claim → evidence table** for the Breaking line, every upgrade step, and the #918 / #926 / D15 statements:
  `file:line` or the PR.
- Anything left out, and why.
- Anything where a PR body and the code disagreed.

Then stop and wait.
