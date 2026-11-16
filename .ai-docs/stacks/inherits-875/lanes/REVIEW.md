# Review lane — #875 slice review (one per slice)

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.
You are a **reviewer**: you do not edit files, commit or run anything that writes to the worktree's tracked files.
Running gates and read-only commands is fine.

Your prompt names the slice, the worktree, the branch and the diff base. Review `git diff <base>...HEAD` in that
worktree.

## What to check, in this order

1. **Scope.** Against RFC-0006 §13.2 for the slice (revision 3; OQ-11 decided — no user-facing `checks:` key): did
   it build everything listed, touch only what it may touch, and close the acceptance items the slice claims? Go
   through each claimed acceptance item (`gh issue view 875`, but the RFC's §12 wording wins) and say met / partly /
   not met, with the evidence (a test name, a file:line).
2. **Correctness.** Bugs, wrong rule semantics, an edge the RFC names but the code misses, a message that does not
   name the entities, tenant / scope / soft-delete leaks, transaction boundaries, SQL that is not one statement where
   the RFC says it must be.
3. **Gates that can fail on their subject** (CLAUDE.md "A gate must be able to fail on its own subject"). For each new
   test or gate: would it go red if the feature were removed? Check (a) it parses and runs, (b) it resolves through
   the same configuration as the code under test, (c) an absent input does not default to permissive. Where cheap,
   prove it: break the subject in a scratch copy (`git stash` is NOT allowed — use `git worktree add` in the
   scratchpad or reason from the code), never in the reviewed worktree.
4. **Repo rules.** CLAUDE.md naming rules (`emittedStem`, `sqlTableName` with a required prefix, `projectEntityLookup`,
   `globalThis.<Name>` in emitted TS), no backwards-compat shims, complete-file `@generated` output, no inject
   templates, no filtered error class or directory carve-out in any gate, a narrowed spread that drops a key.
5. **Reuse and layering.** One owner per concept: is there a second definition of something that already exists
   (a second tenancy derivation, a second entity lookup, a hand-rolled plural)? Does a template re-derive what
   `entity-locals.js` should provide?
6. **The RFC.** Does the slice leave the RFC true? Name every place it now disagrees with the code.
7. **Public-repo leak.** `git diff <base>...HEAD | grep -inE "$PRIVATE_NAMES_RE"`.

Re-run the slice's gates yourself if the builder's report is older than its last commit, and say which ones you ran.

## Report

`SendMessage` to `codegen-patterns-73`: verdict `ACCEPT` / `ACCEPT_WITH_FIXES` / `REVISE`, then numbered findings
(`path:line`, defect, failure scenario, severity `blocker` / `should-fix` / `nit`), then the acceptance table, then
the gates you ran with their tails. Be terse; every finding must be verified against the branch.
