# Lane `s7<x>-review` — review one S7 slice

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you.
You are a **reviewer**: read-only on source. Do not edit, commit or push. Your prompt names the slice, the worktree,
the branch, and the commit range (`<parent>..<tip>`).

Read first:
- the slice's build brief (`s7<x>-build.md` in this folder);
- RFC-0006 §4.2, §8, §11.3 and §13.2 S7 on the branch;
- `CLAUDE.md` on the branch, especially "A gate must be able to fail on its own subject", "Templates print (ADR-046)"
  and the naming rules.

Review the diff `git diff <parent>..<tip>`, and read whatever code it reaches. Use two lenses, and keep their findings
separate:
- **Adherence.** Does the slice do what its brief and D1–D5 say, and nothing more? Does the RFC entry match what was
  built? Is every scope exception named?
- **Quality.** Are there defects, missed cases, or rules with two owners (a list retyped instead of derived, a name
  check where a property belongs)? Does each test fail without its change? Is any gate unable to fail on its subject?

**Verify every finding against the branch before you report it.** Run the code: reproduce it, mutate the source and
watch a test fail or not fail. A finding you could not verify is marked `UNVERIFIED` and says why.

Write the review to `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/reviews/s7<x>.md`:
- a verdict: `ACCEPT`, `ACCEPT_WITH_FIXES` or `REVISE`;
- then numbered findings, each with `path:line`, a failure scenario, a severity (`blocker` / `should-fix` / `nit`) and
  its lens;
- mark any finding that needs a decision from Doug as `DECISION`, with the options and your recommendation. Only a
  choice that changes what a user writes in YAML, or what the generated API is, is a `DECISION`.

Then `SendMessage` to `codegen-patterns-73` with the verdict, the counts by severity, and the path to the file.
