# Lane brief — B4: the service and declarative-query use cases print; the entity backend derives no names

You are the **build lane for PR B4**, the last PR of Phase B. One PR's worth of work.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-b4`, branch
  `dugshub/api-surface-b4` (checked out; it sits on B3 — the repository, controller, search controller, module and
  index already print from `apiSurface`). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## The one rule Phase B lives by

**Generated output does not change. Not one byte.** `test/baseline/**`, `test/junction/__snapshots__/**`,
`test/render-golden/**` and `test/api-surface-golden/**` are frozen. **Any byte diff in any of them is a stop**,
explained or not: report it with the diff and wait. Never regenerate a snapshot. The oddities PLAN §3.4 records
(raw snake_case to-many and fan-out names, #697; `operationId` + `s`; …) stay exactly as they are — B4 moves who
decides them, it does not fix them.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** No host-application names, paths, table names or "dogfood" references.
- **Frozen (from B1):** the four snapshot trees; `src/__tests__/derived/**`;
  `src/__tests__/templates/no-name-derivation-in-templates.test.ts`; `test/run-test.ts`;
  `test/smoke/_consumer-errors.ts`; **`tools/studio/**` and `src/studio/**`**. The lint allowlist only loses lines or
  lowers counts — no added line.
- `src/derived/api/**` may change only if the golden and parity stay green, and you name the change. `types.ts` is
  the signed-off shape: a needed change to it is a stop.
- **No `expect(` line removed or rewritten** (no `.skip`/`.todo`/`.only`, no type escapes). Two locals,
  `apiEnabled` and `includes`, are still asserted by `write-templates.test.ts:278/280/303` and
  `build-includes.test.ts:443`. Whether those assertions may be repointed at `apiSurface` (so the locals can be
  deleted) is with the owner now; **until I tell you otherwise, keep those two locals as one-line projections of the
  derivation and leave those tests alone.**
- **Stop and report instead of inventing.** Two failed attempts at the same gate is also a stop.

## Read first

1. `CLAUDE.md` — § Testing (silent-drop rule), § Template System (JUNC-0: a junction's fan-out is rendered by the
   parents' own service + module templates, `templates/_shared/junction-fan-out.mjs`), § Key Patterns › *Templates
   print (ADR-046)*.
2. `.ai-docs/stacks/api-surface-model/PLAN.md` — **§3.1 (service rows: query forwarders, capability forwarders,
   to-one/to-many relation methods, junction fan-out, EAV), §3.4, §5 (the `service.ejs.t` and
   `declarative-queries.ejs.t` rows; "locals deleted"), §8 (the CLAUDE.md rule), §9 row B4, §14.2's B4 table,
   §14.3, §14.6, §14.7 item 6**, and the B2/B3 "as built" notes.
3. `docs/adrs/ADR-046-derived-once-templates-print.md` (you add its revision note).
4. `src/derived/api/{names,entity}.ts`; `templates/entity/new/backend/{entity-locals.js,service.ejs.t,
   use-cases/declarative-queries.ejs.t,repository.ejs.t}`; `templates/entity/new/prompt.js`;
   `templates/_shared/junction-fan-out.mjs`; `src/__tests__/templates/no-name-derivation.allowlist.ts`.

## Deliverables (PLAN §9 row B4)

1. **`service.ejs.t` prints**: one loop over `apiSurface.service.methods`; names, param names and the callee
   (`delegatesTo.method`) printed, never built — read forwarders, query forwarders, capability forwarders, to-one and
   to-many relation methods, junction fan-out, EAV. No inline camel-casing, no string-built `findBy`, no
   `capabilityForwarders` / `processedQueries` reads.
2. **`use-cases/declarative-queries.ejs.t` prints** from `apiSurface.useCases` of kind `query` — no
   `useCaseClassName` / `methodName` reads.
3. **Fan-out names from `names.ts`**: `junction-fan-out.mjs` stops building the fan-out method / id-param names
   (lower its allowlist counts accordingly; its #679 entries may remain for what is left).
4. **The entity backend's allowlist is empty**: no entry for `templates/entity/new/backend/**` or
   `templates/entity/new/prompt.js` — replace `entity-locals.js`'s and `prompt.js`'s local case helpers and inline
   camel-casing with the shared primitives (`src/config/file-naming.ts` / `src/derived/api/names.ts`).
5. **Locals deleted as their last reader converts** (§5's list): `processedQueries[].methodName` /
   `.useCaseClassName`, `declarativeQueryClasses`, `capabilityForwarders`, `serviceInheritedMethods`,
   `repositoryInheritedMethods`, the fan-out `*Method` / `*IdParam` keys — except where a template still needs the
   text for byte identity. Known case: the "// Inherited from <Base>:" comments print the pattern's declared lines
   verbatim, which the derivation cannot reproduce; B2 kept the repository's reading the pattern's lines (with the
   owner), so treat the service's the same way and report it.
6. **Docs to post-implementation truth**: CLAUDE.md § *Templates print (ADR-046)* — the entity backend is fully
   migrated, so remove the "not yet migrated" clause for it while keeping the rule that the allowlist names what is
   left elsewhere and only shrinks (`grep -c 'not yet migrated' CLAUDE.md` → `0`); ADR-046 gains a dated
   `**Revision …**` note recording what implementation changed (read PLAN's "as built" notes and Differs sections);
   STUDIO-2's status is not "Design" (check). Leave `PLAN.md` to the lead — list the differences in your report.
7. **Silent-drop list:** for every local you stop producing or reading, `grep` `templates/**`, `src/__tests__/**` and
   `prompt.js` for every reader; say for each whether it was converted or deleted.

## Exit — run all of this on your final tree, after your last edit

`ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }`

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`.
2. `just test-baseline` → 0, `✅ All tests passed!`, the #680 line; `git status --porcelain test/` empty.
   `just test-junction` → 0, snapshots unchanged.
3. `U backend/render-golden.test.ts` → 45 / 0; `U derived/` and `U templates/` → 0 fail.
4. Every row of PLAN §14.2's **B4** table, exactly (frozen diff from `dugshub/api-surface-b1`; the `service.ejs.t`
   and `declarative-queries.ejs.t` greps → `0`; no `templates/entity/new/(backend/|prompt.js)` in the allowlist;
   allowlist `--numstat` added `0`; `not yet migrated` → `0`; ADR revision note present).
5. **The B4 mutation exactly as §14.2 writes it**: append `X` to the name `relationMethodName()` returns
   (`src/derived/api/names.ts`, one line) → `bun test/run-test.ts generate && bun test/run-test.ts compare` → exit 1
   with `❌ Content differs: packages/api/src/modules/contacts/contact.service.ts`. Revert, re-run
   `just test-baseline`, confirm `git status --porcelain`.
6. `just test-post-publish` → 0 (the tarball smoke).

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutation's red lines; the silent-drop list; per
template, scriptlet-logic lines before → after (for the S4 packet); any change to `src/derived/**`; anything built
differently from PLAN §5 / §9 B4. Then stop and wait.
