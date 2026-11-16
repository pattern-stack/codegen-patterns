# Lane brief — B3: controller, search controller, module and index flags print from the derivation

You are the **build lane for PR B3** of Phase B. One PR's worth of work.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-b3`, branch
  `dugshub/api-surface-b3` (checked out; it sits on B2, where `repository.ejs.t` already prints from
  `apiSurface` and `entity-locals.js` returns `apiSurface` and `queryTypes`). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## The one rule Phase B lives by

**Generated output does not change. Not one byte.** B3 moves who decides the HTTP surface (routes, whether a
controller exists, the include-allowlist wiring) and the module/index flags into `src/derived/api/`.
`test/baseline/**`, `test/junction/__snapshots__/**`, `test/render-golden/**` (B1) and `test/api-surface-golden/**`
are frozen. **Any byte diff in any of them is a stop**, explained or not: report it with the diff and wait. Never
regenerate a snapshot.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** No host-application names, paths, table names or "dogfood" references.
- **Frozen (from B1):** the four snapshot trees; `src/__tests__/derived/**`;
  `src/__tests__/templates/no-name-derivation-in-templates.test.ts`; `test/run-test.ts`;
  `test/smoke/_consumer-errors.ts`; **`tools/studio/**` and `src/studio/**`** (the owner is working on Studio from
  `main` — do not touch them). The lint allowlist only loses lines or lowers counts.
- `src/derived/api/**` may change only if the golden and parity stay green, and you name the change. `types.ts` is
  the signed-off shape: a needed change to it is a stop.
- The only test deletion allowed: the **rest** of `src/__tests__/emitters/relations/route-name-parity.test.ts` (B2
  already deleted its finder half) — the whole file goes once nothing is left to compare. No other `expect(` removed or
  loosened; no `.skip`/`.todo`/`.only`; no `@ts-ignore` / `@ts-expect-error` / `as any` / `as unknown as`.
- **Stop and report instead of inventing.** Two failed attempts at the same gate is also a stop.

## Read first

1. `CLAUDE.md` — § Testing (silent-drop rule), § Template System, § Key Patterns › *Templates print (ADR-046)*.
2. `.ai-docs/stacks/api-surface-model/PLAN.md` — **§3.1–§3.2 (the `api` enabled, typed-include and includes-const
   duplicates), §5 (the controller, search-controller, module, index rows; "locals deleted"), §9 row B3, §14.2's
   B3 table, §14.3, §14.6, §14.7 item 6.** Also B2's "as built" notes once they appear.
3. `src/derived/api/{types,names,entity}.ts`; `templates/entity/new/backend/{entity-locals.js,controller.ejs.t,
   search-controller.ejs.t,module.ejs.t,index.ejs.t}`; `src/emitters/relations/{build-includes,emit-includes}.ts`;
   `src/schema/entity-definition.schema.ts` (`apiEnabled`, ~:1583); `route-name-parity.test.ts`.

## Deliverables (PLAN §9 row B3)

1. **`controller.ejs.t`** — `skip_if` on `apiSurface.http.enabled`; every route fact (verb, path, handler,
   `operationId`, include wiring) read from `apiSurface.http.routes`; the Swagger text and bodies stay.
2. **`search-controller.ejs.t`** — `skip_if` and the route from the derivation's `search` route.
3. **`module.ejs.t`, `index.ejs.t`** — the flags they branch on (`apiEnabled`, `hasSearchQuery`, `generateWrites`,
   `eavEnabled`, …) read from `apiSurface`. The provider *list* is slice 3 — leave it.
4. **One reader each**, all under `src/derived/api/`: `apiEnabled`, `declaresOwnRelation` (has a typed include),
   `includesConstName`. Delete the other copies (`entity-locals.js`, `entity-definition.schema.ts`,
   `build-includes.ts`, `emit-includes.ts`) and repoint their callers. The schema's copy relies on zod's default and
   throws on raw YAML (§4.3) — the derivation's accepts both.
5. **Allowlist:** deletions only, for any count B3 lowers.
6. **Silent-drop list:** for every local you stop producing or reading, `grep` `templates/**`, `src/__tests__/**`
   and `prompt.js` for every reader; say for each whether it was converted or deleted.

## Exit — run all of this on your final tree, after your last edit

`ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }`

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`.
2. `just test-baseline` → 0, `✅ All tests passed!`, the #680 line; `git status --porcelain test/` empty.
   `just test-junction` → 0.
3. `U backend/render-golden.test.ts` → 45 pass / 0 fail; `U derived/` and `U templates/` → 0 fail.
4. Every row of PLAN §14.2's **B3** table, exactly (frozen diff from `dugshub/api-surface-b1`; the `apiEnabled` and
   `apiIncludeRoutes|apiIncludesConst` greps; the three `export function` lines all under `src/derived/api/`; no
   `_API_INCLUDES` in `entity-locals.js`; `route-name-parity.test.ts` gone).
5. **The B3 mutation exactly as §14.2 writes it** (the `find_by_id` route path `/:id` → `/:key` in
   `src/derived/api/entity.ts`, one line): `bun test/run-test.ts generate && bun test/run-test.ts compare` → exit 1
   with `❌ Content differs: packages/api/src/modules/contacts/contact.controller.ts`. Revert, re-run
   `just test-baseline`, confirm `git status --porcelain`.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutation's red lines; the silent-drop list; any
change to `src/derived/**`; anything built differently from PLAN §5 / §9 B3. Then stop and wait.
