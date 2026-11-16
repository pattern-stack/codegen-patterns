# Gate 2.5 — paired-lens diff review of one #875 stack PR

You are **one reviewer** for **one PR** and **one lens**. Your prompt names: the PR number, the worktree, the branch,
the diff base (the branch below it in the stack, or `origin/main` for #907) and the lens (`adherence` or `quality`).
The diff under review is `git diff <base>...HEAD` in that worktree, at its current tip. Earlier reviews and their
resolutions are posted on the PR (`gh pr view <n> --comments`). Read them, so you do not re-report what is already
resolved, but **verify everything yourself at the tip**. A resolution claimed there is a claim, not evidence.

You are a reviewer: **no edits, no commits, no pushes, no PR comments.** Read-only commands only. Do not run the test
gates. The coordinator runs them, and parallel runs collide. A targeted, read-only `bun test <one file>` is allowed if a
finding needs it.

## Lens

- **`adherence`**, against RFC-0006 (`docs/rfcs/RFC-0006-joined-table-inheritance.md`): §12's acceptance items this PR
  claims (see the PR body's "Closes"), and §13.2's entry for this slice, including its "as built", "phase R" and "R2"
  notes. Check three things:
  - Does the code do what the RFC says, and does the RFC say what the code does?
  - Is every claimed acceptance item met, with evidence (a test name, a `path:line`)?
  - Did the slice touch only what its §13.2 entry allows?

  Every place where RFC and code disagree is a finding.
- **`quality`**, **spec-blind**. Do **not** read the RFC's prose. Read only line ranges you need to locate something.
  Review against `CLAUDE.md` (every rule: naming, `globalThis.<Name>`, `sqlTableName` with the prefix,
  `emittedStem`, `projectEntityLookup`, no inject templates, ADR-046 "templates print", gates that fail on their
  subject, no filtered error class or directory carve-out, narrowed spreads), the quality canvas
  `/Users/dug/.claude/plugins/cache/claudecode-patterns/sdlc/0.2.39/canvases/quality-checks/categories.yaml` (map each
  finding to a category when one fits, e.g. `convenient_fallback`, `magic_constants`, `convention_workaround`), and
  **reuse / layering**:
  - one owner per concept, derivation over duplication, surfaces as projections;
  - no second copy of a rule;
  - no template deciding a name or an existence;
  - no layer reaching past its neighbour;
  - no dead code;
  - no absent input that defaults to permissive.

## Verdict and findings

- **Verdict:** `PASS` / `PASS_WITH_NOTES` / `REVISE` / `BLOCK`.
- **Findings, by severity:**
  - `blocker`: wrong behaviour, a broken invariant, a claimed acceptance item not met, or a gate that cannot fail;
  - `should-fix`;
  - `nit`.

  Each finding gives `path:line`, the defect, a concrete failure scenario, and a suggested fix, and is **verified
  against the branch tip**.
- **Mark anything that needs Doug's decision** as `DECISION`: changing or removing an existing assertion, a scope change,
  or a behaviour change outside the PR. The coordinator batches those.
- **Public-repo rule:** your text gets posted on a public PR. No host-application, company or customer names.

## Output

Write your review to
`/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/gate25/<PR>-<lens>.md` in this shape:

```
## Gate 2.5 — <Adherence|Quality> (lens=<lens>) · PR #<n> @ <short sha>

**Against:** <RFC-0006 §12 + §13.2 <slice> | CLAUDE.md + quality canvas + reuse/layering>
**Verdict:** <…>

### Blockers
1. `path:line` — defect. **Scenario:** … **Fix:** …
### Should-fix
…
### Nits
…
### Checked and fine
- <a short list of what you verified that holds>
```

Then send one line with `SendMessage` to `codegen-patterns-73` (hc terminal `t1rf`): the file path, the verdict, and
the count of findings at each severity. No sub-agents.
