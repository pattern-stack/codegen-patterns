# S7 (#917) — rules for every lane

Context: RFC-0006 (`docs/rfcs/RFC-0006-joined-table-inheritance.md`, §4.2, §8, §11.3, §13.2 S7) and issue #917. The
rule S7 exists for: **a provider sync has no opinion on an entity's family hierarchy.**

Doug's decisions for S7 (2026-11-15), binding on every slice:
- **D1.** The base declares `external_id_tracking` explicitly, plus `natural_key: true` on a `unique_indexes` entry
  `[provider, external_id]`. A child that declares `pattern: Integrated` never adds a column to the base. A base that
  lacks either is an error naming both entities.
- **D2.** `pattern: Integrated` on a **base** stays refused in S7; it is #927.
- **D3.** Two Integrated children of one base are allowed. They share the base's `(tenant, provider, external_id)` key,
  and the same external id arriving under another kind is `KindMismatchError`, not an overwrite.
- **D4.** The tombstone is the same as today: with `soft_delete` on the base it soft-deletes the base row; without it,
  it nulls `provider` / `external_id` on the base row, so the pair is detached and the child row stays.
- **D5.** Moot. R9 (no `eav: true` in a family) stays, so no child reaches the Integrated EAV dual-write.
- **Consequences** the coordinator fixed under D1:
  - **One constraint, one owner.** The natural-key entry adopts `external_id_tracking`'s unique constraint. There is no
    second index on the same columns.
  - **R11** accepts exactly the two nullable behaviour columns `provider` and `external_id`.
    `upsertByNaturalKey` throws a named error on a NULL natural-key value, so "a NULL never conflicts" cannot insert a
    duplicate.
  - **R11's "at most one"** holds. A base with an Integrated child cannot also declare a natural key on other columns.

**Do not touch `package.json` or `CHANGELOG.md`**: a release lane owns them.

You build or review **one slice** in **one worktree**, for the coordinator session `codegen-patterns-73` (hc terminal
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
