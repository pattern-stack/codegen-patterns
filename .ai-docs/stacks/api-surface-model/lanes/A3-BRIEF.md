# Lane brief — A3: Studio server `GET /api/surface`

You are the **build lane for PR A3** of the API-surface plan. One PR's worth of work, nothing more.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-a3`, branch
  `dugshub/api-surface-a3` (checked out; it sits on A2, which added `codegen project surface --json`). Run
  `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1s4`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1s4`.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** Never put host-application names, paths, table names or "dogfood"
  references into code, comments, test names, fixtures or the spec. Use only the repo's own demo names.
- **Frozen:** `src/derived/**` (the derivation and its shape were signed off at S1 — if the server needs it to
  change, **stop and report**), `src/__tests__/derived/**`, `src/__tests__/templates/no-name-derivation*`,
  `test/api-surface-golden/**`, `templates/**`, `package.json`, `test/baseline/**`, `tools/**` (the UI is A4).
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no deleted or loosened assertion (in
  `src/__tests__`, `test/` or `tools/studio/src/__tests__`), no deleted test file, no `@ts-ignore` /
  `@ts-expect-error` / `as any` / `as unknown as` in `src/studio`.
- **Stop and report instead of inventing** on any design question PLAN.md / ADR-046 / STUDIO-0 do not answer.
  Two failed attempts at the same gate is also a stop.

## Read first

1. `CLAUDE.md` § Studio — its three server rules (only `cli-runner.ts` spawns; `parseCliJson` returns `null` on a
   failed exit; every client path checked) and § Testing.
2. `docs/specs/STUDIO-0.md` (§2 was corrected in A0: the graph route shells the CLI).
3. `.ai-docs/stacks/api-surface-model/PLAN.md` **§6.1, §6.2, §14.2's A2 and A3 tables, Appendix B** (the STUDIO-2
   outline).
4. `src/studio/server/graph.ts` (`getGraph` — the exact pattern to copy), `src/studio/server/index.ts:473`,
   `src/studio/shared/api.ts`, `test/studio/run-studio-e2e.ts`.

## Deliverables (PLAN §9 row A3)

| File | What |
|---|---|
| `src/studio/server/surface.ts` | `getSurface(projectDir)`: `runCliJson(['project','surface'], { cwd })`, as `getGraph` does. A missing payload is a `CliFailureError`, never `{}`. No `spawn(` in this file. |
| `src/studio/server/index.ts` | `GET /api/surface`, registered beside `/api/graph`, its own route, so a surface failure cannot blank the canvas. |
| `src/studio/shared/api.ts` | types only: `export type { ProjectApiSurface, EntityApiSurface, RelationApiSurface, Origin, YamlRef } from '../../derived/api/types.js'` and `export interface SurfaceResponse { surface: ProjectApiSurface }` (§6.2). No runtime import. |
| `test/studio/run-studio-e2e.ts` | a new `GET /api/surface` stage that asserts, **by exact value over HTTP**, every row of PLAN §14.2's A2 table (contact's emitted repository methods; `findByAccountId`'s origin and shadow; `findByEmail`; the five routes; the `contact.relationships.account` relation's `inverseOf` and `generates`; `account.service.contacts`'s kind and delegate; `warnings` and `unmodelled` both empty); **and**, after the demo relationship is written (the existing stage 9), a second call whose `unmodelled` contains `{ name: 'contact_opportunity', kind: 'relationship' }`. |
| `docs/specs/STUDIO-2.md` | the spec, from PLAN Appendix B's outline. Status *In progress*. Sections 4–6 (API tab, edge view, vocabulary table) describe the design; A4/A5 correct them to what is built. |

## Exit — run all of this on your final tree, after your last edit

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`, `N pass` ≥ A2's count.
2. `just test-studio` → 0; its stage list includes the new `GET /api/surface` stage; every new assertion printed
   as passing.
3. `grep -nE '^import ' src/studio/shared/api.ts | grep -v 'import type'` → no output.
4. `grep -n "spawn(" src/studio/server/surface.ts` → no output.
5. `git diff --stat dugshub/api-surface-a2 -- templates package.json test/baseline src/derived src/__tests__/derived test/api-surface-golden tools` → empty.
6. **Prove the stage can fail on its subject:** change one expected value in the new stage (e.g. expect
   `findByAccountId`'s origin to be `queries.0`), run `just test-studio`, see it fail naming that assertion, revert,
   `git status --porcelain` back to what it was. Report the red line.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutation's red line; anything built differently
from PLAN §6 and why. Then stop and wait.
