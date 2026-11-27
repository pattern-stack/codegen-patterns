# Lane brief — B5: delete the locals the derivation replaced; repoint their tests at `apiSurface`

You are the **build lane for PR B5**, the last PR of Phase B (owner-approved 2026-11-14, "option B"). One PR's work.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-b5`, branch
  `dugshub/api-surface-b5` (checked out; it sits on B4 — every backend template prints from `apiSurface`; the old
  locals survive only as one-line projections of the derivation because unit tests still assert them). Run
  `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## The task

PLAN §5 lists the locals to delete "as their last reader converts". B2–B4 converted every template reader, but kept
the locals as projections because tests assert them. The owner chose: **delete the locals, and repoint each test
assertion at `locals.apiSurface` — the same value, the same strictness.**

The locals (from B4's report — verify each with `grep` over `templates/**`, `src/__tests__/**`, `prompt.js`):

| Local | Test readers (repoint) | Template readers (convert first, if any remain) |
|---|---|---|
| `capabilityForwarders` | `prompt-extension.test.ts:767`, `:828` | — |
| `declarativeQueryClasses` | `prompt-extension.test.ts:276–344` | — (`module.ejs.t`'s `declarativeQueryClasses` is an emitted TS identifier, not the local) |
| `processedQueries[].methodName` / `.useCaseClassName` | `prompt-extension.test.ts:237–264`, `:292`; `search-query-templates.test.ts:254–255` | — |
| the fan-out `*Method` / `*IdParam` keys | `junction-fan-out.test.ts:82–99` | — |
| `apiEnabled` | `write-templates.test.ts:278`, `:280`, `:303` | — |
| `includes` | `build-includes.test.ts:443` | `use-cases/find-by-id.ejs.t`, `use-cases/list.ejs.t` — convert to `apiSurface.repository.typedInclude` |

**Stays:** `repositoryInheritedMethods` / `serviceInheritedMethods` — the inherited comments still read them, pinned by
the named expectation `inherited-comment-expectation.test.ts` (#893). Do not touch that test. Anything else a template
still needs for *type text or bodies* (`queryTypes`, `relationTypes`, `belongsTo`'s FK column property, …) stays.

## The one rule Phase B lives by

**Generated output does not change. Not one byte.** `test/baseline/**`, `test/junction/__snapshots__/**`,
`test/render-golden/**` and `test/api-surface-golden/**` are frozen; any byte diff in them is a stop. Never regenerate
a snapshot.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.**
- **The approved exception, and its limits:** an `expect(` line may change **only** to read the same value from
  `locals.apiSurface` (e.g. `expect(locals.apiEnabled).toBe(false)` → `expect(locals.apiSurface.http.enabled).toBe(false)`),
  with the **same matcher and the same expected value**. No assertion is deleted, loosened, `.skip`ped or moved to a
  weaker matcher. If a test cannot be repointed without changing what it asserts, stop and report it.
- Frozen: the four snapshot trees; `src/__tests__/derived/**`; the lint test; `inherited-comment-expectation.test.ts`;
  `test/run-test.ts`; `test/smoke/_consumer-errors.ts`; `tools/studio/**`; `src/studio/**`; `src/derived/api/types.ts`.
  The lint allowlist only loses lines.
- **Stop and report instead of inventing.** Two failed attempts at the same gate is also a stop.

## Exit — run all of this on your final tree, after your last edit

`ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }`

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`; the test **total** equals B4's (repointing adds and removes
   no test).
2. `just test-baseline` → 0, `✅ All tests passed!`; `git status --porcelain test/` empty. `just test-junction` → 0.
3. `U backend/render-golden.test.ts` → 45 / 0; `U derived/` and `U templates/` → 0 fail.
4. For every local above: `grep -rn '<local>' templates src` → no producer and no reader (except, for `processedQueries`,
   any internal use that is not the deleted `.methodName` / `.useCaseClassName` — say what remains and why).
5. **The repoint table** (for the PR body): every changed `expect(` line, old → new, file:line — each with the same
   matcher and expected value. `git diff dugshub/api-surface-b4 -- src/__tests__ test | grep -c '^-.*expect('` must equal
   the number of rows, and each removed line must have its repointed twin.
6. **Mutation:** change one derived name in `src/derived/api/names.ts` (e.g. `useCaseClassName`'s query branch) → a
   repointed test goes red (proving the tests now read the derivation). Revert, re-run `just test-baseline`, confirm
   `git status --porcelain`.
7. `just test-post-publish` → 0 (templates changed).

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the repoint table; the mutation's red line; the
silent-drop list (every local deleted, its readers converted); anything you could not do. Then stop and wait.
