# Lane brief — A1: the API-surface derivation + its three gates

You are the **build lane for PR A1** of the API-surface plan. One PR's worth of work, nothing more.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-a1`, branch
  `dugshub/api-surface-a1` (already checked out; it sits on A0 = ADR-046 + the CLAUDE.md rule). Run
  `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1s4`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1s4`.

## Rules (binding)

- **No sub-agents** (no Agent tool, no `hc run` of other agents). **No commit, no push, no PR, no merge, no
  `gh stack`.** Leave your work uncommitted in the worktree; the lead reviews and commits.
- **Public repo — private-context rule.** Never put host-application names, paths, table names or "dogfood"
  references into code, comments, test names or fixtures. Say "a host application" if you must refer to one. Use
  only the repo's own fixture and demo names.
- **Phase A does not touch** `templates/**`, `package.json`, `test/baseline/**`, `test/junction/__snapshots__/**`,
  `test/relations-golden/**`, `test/frontend-golden/**`, `test/frontend-graph-golden/**`, `test/semantic-golden/**`,
  `test/integration-emit/**`, `test/run-test.ts`, `test/smoke/_consumer-errors.ts`. Mutation checks edit some of
  these temporarily; every one is reverted with `git checkout -- <file>` and `git status --porcelain` must be what
  it was before.
- **Never weaken anything existing:** no `.skip`/`.todo`/`.only`, no deleted or loosened `expect(`, no deleted test
  file, no `@ts-ignore` / `@ts-expect-error` / `as any` / `as unknown as` in `src/derived/**`, no `bun test
  --update-snapshots`, no `just baseline`.
- **Stop and report instead of inventing** when you hit a design question PLAN.md and ADR-046 do not answer: a new
  method kind, a provenance case with no `Origin` variant, a type string that seems needed, a generated method you
  cannot explain, a gate that cannot be made to fail on its subject. Send the evidence (`file:line`) and your
  proposed answer, then wait — the lead answers by typing into your terminal. Two failed attempts at the same gate is
  also a stop.
- If you notice generated code that validates but would not compile (an F7-class finding), record it in your report;
  do not fix it.

## Read first

1. `CLAUDE.md` (all of it; especially § Testing — the three #726 gate shapes and the silent-drop rule — and the new
   § Key Patterns › *Templates print (ADR-046)*).
2. `.ai-docs/stacks/api-surface-model/PLAN.md`: **§3 (inventory — every row marked "Yes" is yours to derive), §4
   (shape, location, input), §7 (the three gates, with exact failure messages), §13, §14.1–14.3 and §14.2's A1
   table.** §5/§6 are context only (Phase B / Studio — not this PR).
3. `docs/adrs/ADR-046-derived-once-templates-print.md`.
4. `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4 (charter invariants).

Every `path:line` in PLAN.md was taken at `e9fe6f5f`; `main` has not changed any of those files since (verified),
so the citations hold.

## Deliverables (exactly the A1 row of PLAN.md §9)

| File | What |
|---|---|
| `src/derived/api/types.ts` | §4.1's types. Types only, zero runtime imports, no type strings. |
| `src/derived/api/names.ts` | every name rule as a named export: at least `finderName`, `fkFinderName`, `relationMethodName`, `useCaseClassName`, `includesConstName`, the junction fan-out names, route paths. Each must reproduce **today's** output exactly — including today's oddities (§3.4: raw snake_case to-many names, `operationId` + `s`, the two camelCase rules). Byte-identity is Phase B's gate; the derivation must already agree. |
| `src/derived/api/entity.ts` | `deriveEntityApiSurface(input)` — one entity, pure. Narrow structural input type that accepts **both** raw YAML and zod-parsed definitions (§4.3 "one input hazard"). Inputs: the entity definition (post role-merge), the junction set, the resolved pattern composition (what `resolvePatternComposition` returns, `entity-locals.js:285-314` — pass it in, do not re-resolve), `wiredTargets`, and whatever config bits decide existence (`generate.writes`, …). |
| `src/__tests__/derived/_parity-compare.ts` + its own test | the pure comparator; set equality both ways; the exact messages of §7.1. |
| `src/__tests__/derived/api-surface-parity.test.ts` | Subject A (checked-in baseline, parsed with `ts-morph`) + Subject B (render matrix, rendered in-process like `src/__tests__/backend/eav-templates.test.ts`: `buildBackendLocals` + the prompt's extra locals + `ejs.render`). |
| `src/__tests__/derived/api-surface-golden.test.ts` + `test/api-surface-golden/snapshot/<name>.json` | §7.2. One JSON per baseline fixture entity (9) and per matrix case. Regenerate only with an env var (`UPDATE_API_SURFACE_GOLDEN=1`, mirror `src/__tests__/emitters/relations/golden-manifest.test.ts`). |
| `src/__tests__/derived/raw-parsed.test.ts` (name yours) | `derive(raw) ≡ derive(parsed)` for every fixture and matrix case. |
| `src/__tests__/templates/no-name-derivation-in-templates.test.ts` + `no-name-derivation.allowlist.ts` | §7.3. Entries `{ file, pattern, count, issue }`, asserted **present and exact**. Pattern ids: `inline-camel-case` (pinned by M7/M8), and your choice of stable ids for the other three. Issue: `#679` for junction/relationship pipelines, `ADR-046 Phase B` for the entity backend, `unfiled (drafted at S1)` for `broadcast/new/bridge-listener.ejs.t`. |

Matrix cases (Subject B; B1 reuses them, so define them once in a module the tests import, e.g.
`src/__tests__/derived/_render-matrix.ts`; fixture YAML may live under `test/api-surface-golden/matrix/`): EAV, EAV
value table, one capability, two capabilities, `api: false`, `api.includes`, `generate.writes: false`, self-FK,
role, the `queries:` × `belongs_to` precedence collision (with an ordered query, §3.4), junction fan-out.

Hygen-safety (B2 will import `entity.ts`/`names.ts` from `entity-locals.js`): `types.ts`, `names.ts`, `entity.ts`
may import only modules already listed in `package.json` `files` — and never from `src/emitters|parser|cli|
analyzer|studio`. Names that already have one owner (`src/config/file-naming.ts`, `templates/_shared/entity-naming.mjs`
for plural / module naming) are *called*, not re-implemented — never `pluralize()` in `src/derived`.

## Exit — run all of this on your final tree, after your last edit

```sh
ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }
```

1. `just typecheck` → exit 0. `just test-unit` → exit 0, ` 0 fail`, and `N pass` above the base count (record N).
2. `just test-baseline` → exit 0, last line `✅ All tests passed!`, contains `Typecheck passed (only the named #680
   expectation`; then `git status --porcelain test/baseline` empty. `just test-junction` → exit 0.
3. Every row of PLAN.md §14.2's **A1** table (the greps, `ls test/api-surface-golden/snapshot | wc -l`, `time U
   derived/`).
4. **M1–M8 exactly as §14.2 writes them** — same perl/printf, same command, expect exit 1 and the exact text. Revert
   each, confirm `git status --porcelain` unchanged. Messages are part of the spec: if your text differs from the
   table, your code is wrong, not the table.
5. §14.3 detections over your diff (`git diff` against `dugshub/api-surface-a0`): nothing printed.
6. R8: if `time U derived/` is over ~3 s, say so with the number; do not move it to a recipe yourself (that would
   touch the justfile — the lead decides).

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files created; each exit step with its result (command → exit code → the deciding line); M1–M8 each with the
red line you saw; the unit-time number; **anything built differently from PLAN.md §4/§7** with the reason (the lead
corrects PLAN.md); any oddity or F7-class finding beyond §3.4. Then stop and wait.
