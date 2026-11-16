# Lane brief — B2: `repository.ejs.t` prints from the derivation (closes #711)

You are the **build lane for PR B2**, the first template-conversion PR of Phase B. One PR's worth of work.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-b2`, branch
  `dugshub/api-surface-b2` (checked out; it sits on B1 = `f0b639ec`, which is on `main` @ `c8da953a` — Phase A is
  merged). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## The one rule Phase B lives by

**Generated output does not change. Not one byte.** B2 moves *who decides* the repository's method names and
existence — from inline EJS to `src/derived/api/` — and nothing else. `test/baseline/**`,
`test/junction/__snapshots__/**`, `test/render-golden/**` (B1's 439 files) and `test/api-surface-golden/**` are the
proof, and they are frozen. **Any byte diff in any of them is a stop**, explained or not (PLAN §14.6): report it
with the diff and wait. Never regenerate a snapshot (`just baseline`, `--update-snapshots`,
`UPDATE_RENDER_GOLDEN=1`, `UPDATE_API_SURFACE_GOLDEN=1` are all forbidden).

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** No host-application names, paths, table names or "dogfood" references.
- **Frozen (from B1):** the four snapshot trees above; `src/__tests__/derived/**`;
  `src/__tests__/templates/no-name-derivation-in-templates.test.ts`; `test/run-test.ts`;
  `test/smoke/_consumer-errors.ts`; `tools/studio/**` (the owner is demoing Studio from `main` — do not touch it).
  The lint allowlist (`no-name-derivation.allowlist.ts`) may only **lose** lines or lower counts; no added line.
- **The derivation** (`src/derived/api/**`) may change in Phase B only if the golden and parity stay green and the
  change is named in your report. `types.ts` is the signed-off shape: a needed change to it is a stop.
- The only test deletions allowed: the **finder half** of `src/__tests__/emitters/relations/route-name-parity.test.ts`
  (B3 deletes the rest), and `src/schema/query-routes.ts`'s own test if one exists. No other `expect(` may be
  removed or loosened; no `.skip`/`.todo`/`.only`; no `@ts-ignore` / `@ts-expect-error` / `as any` / `as unknown as`.
- **Stop and report instead of inventing** on any design question PLAN §4.3–§5 / ADR-046 do not answer. Two failed
  attempts at the same gate is also a stop.

## Read first

1. `CLAUDE.md` — § Testing (the silent-drop rule: "when you narrow a spread, enumerate the consumers"), § Template
   System, § Key Patterns › *Templates print (ADR-046)*.
2. `.ai-docs/stacks/api-surface-model/PLAN.md` — **§3.1–§3.2 (what is decided where today), §4.3 (`queryTypes`),
   §4.4 (how hygen reaches the derivation), §5 (the `repository.ejs.t` row; "locals deleted"; the silent-drop
   rule), §9 row B2, §14.2's B2 table, §14.3, §14.6, §14.7 item 6**, and §4.3's "as built (A2)" note on
   `resolvePatternComposition`.
3. `docs/adrs/ADR-046-derived-once-templates-print.md`.
4. `src/derived/api/{types,names,entity}.ts`; `templates/entity/new/backend/{entity-locals.js,repository.ejs.t}`;
   `templates/entity/new/prompt.js`; `src/schema/query-routes.ts` and its callers;
   `templates/relationship/new/prompt.js:~303`; `src/emitters/relations/build-includes.ts`.

## Deliverables (PLAN §9 row B2)

1. `entity-locals.js` imports `deriveEntityApiSurface` from `src/derived/api/entity.js` (the `.js`-specifier way it
   already reaches `file-naming.ts`) and returns one new local, `apiSurface`, built from what `buildBackendLocals`
   already holds (definition, junction set, resolved pattern composition, wired targets, entity lookup).
2. **`repository.ejs.t` prints.** One loop over the emitted `apiSurface.repository.methods`, a branch on `m.kind`
   choosing the body; names and param names from the derivation; TS types from a `queryTypes` local keyed by the
   derived method name (§4.3). Delete the inline FK-finder name set, the shadowing set, `_skipFkMethod`,
   `_skipClpDq`, the `processedQueries` loop's naming and the inherited-methods comment derivation. Method bodies,
   type text, decorators and imports stay in the template.
3. **`deriveQueryMethodName` deleted** from `entity-locals.js`, `src/schema/query-routes.ts` (**file deleted**; its
   callers read `finderName` from `src/derived/api/names.ts`) and `templates/relationship/new/prompt.js`.
   `build-includes.ts` reads `names.ts` where PLAN §9 says it does. Closes #711.
4. **`resolvePatternComposition` moves into `src/`** (a module already in `files`, or one you add to `files`), and
   `src/derived/api/project.ts`'s restated ~15-line copy is deleted (A2's note). `entity-locals.js` keeps calling it.
   `src/__tests__/derived/_inputs.ts` (frozen) imports it from `entity-locals.js` — if keeping that import working
   needs anything beyond `entity-locals.js` continuing to export the function, stop and report.
5. **`package.json` `files`** gains `src/derived/api/{types,names,entity}.ts` and whatever they newly import — never
   `project.ts`. `src/__tests__/templates/template-src-imports.test.ts` and `files-manifest-coverage.test.ts` must pass.
6. **Allowlist:** delete the `repository.ejs.t` entries and the `relationship/new/prompt.js` string-built-finder
   entry; lower `entity-locals.js`'s counts to what remains. Deletions only.
7. **Silent-drop list:** for every local you stop producing or reading, `grep` `templates/**`, `src/__tests__/**` and
   `prompt.js` (which reads `backendLocals.*`) for every reader, and say for each whether it was converted or deleted.

## Exit — run all of this on your final tree, after your last edit

`ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }`

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`; `N pass` ≥ B1's 4622 minus only the enumerated deletions.
2. `just test-baseline` → 0, `✅ All tests passed!`, `Typecheck passed (only the named #680 expectation`;
   `git status --porcelain test/` empty. `just test-junction` → 0.
3. `U backend/render-golden.test.ts` → 45 pass / 0 fail; `U derived/` → 0 fail; `U templates/` → 0 fail.
4. Every row of PLAN §14.2's **B2** table (frozen diff from `dugshub/api-surface-b1`; the greps; `query-routes.ts`
   gone; no `function deriveQueryMethodName`; allowlist deletions only and no `repository.ejs.t` entry).
5. **The B2 mutation exactly as §14.2 writes it** (`findBy` → `findByX` in `finderName()`): `git diff --stat` shows
   only `names.ts`; `bun test/run-test.ts generate && bun test/run-test.ts compare` → exit 1 with
   `❌ Content differs: packages/api/src/modules/contacts/contact.repository.ts` and `…/deals/deal.repository.ts`.
   Revert, then re-run `just test-baseline` so the generated tree is clean, and confirm `git status --porcelain`.
6. `just test-post-publish` → 0 (the tarball smoke — hygen now imports `src/derived` from the installed package).
   If it needs Docker or network you lack, say so; don't skip it silently.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutation's red lines; the silent-drop list; any
change to `src/derived/**` and why; anything built differently from PLAN §5 / §9 B2. Then stop and wait.
