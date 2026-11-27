# Lane brief — A2: the whole-set pass + `codegen project surface`

You are the **build lane for PR A2** of the API-surface plan. One PR's worth of work, nothing more.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-a2`, branch
  `dugshub/api-surface-a2` (checked out; it sits on A1 = `820e87b6`). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1s4`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1s4`.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** Never put host-application names, paths, table names or "dogfood"
  references into code, comments, test names or fixtures. Use only the repo's own fixture and demo names.
- **Frozen (Doug signed S1 off on 2026-11-14 at `820e87b6`):** `src/__tests__/derived/api-surface-parity.test.ts`,
  `src/__tests__/derived/_parity-compare.ts`, `src/__tests__/templates/no-name-derivation-in-templates.test.ts` —
  no change at all, not even a comment. `src/__tests__/templates/no-name-derivation.allowlist.ts` may only lose
  lines. `src/derived/api/types.ts` is the signed-off shape: if A2 seems to need a change to it (a new field, a new
  kind, a new `Origin` variant), **stop and report** — do not make it.
- **Phase A does not touch** `templates/**`, `package.json`, `test/baseline/**`, `test/junction/__snapshots__/**`,
  `test/relations-golden/**`, `test/frontend-golden/**`, `test/frontend-graph-golden/**`, `test/semantic-golden/**`,
  `test/integration-emit/**`, `test/run-test.ts`, `test/smoke/_consumer-errors.ts`, `src/studio/**`, `tools/**`.
- **The golden** (`test/api-surface-golden/`) is *extended* in A2 with `relations` and `warnings`. The existing
  per-entity content in it must not change. If you believe an existing entity's derived surface must change, stop
  and report with the reason.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no deleted or loosened `expect(`, no deleted test
  file, no `@ts-ignore` / `@ts-expect-error` / `as any` / `as unknown as` in `src/derived/**`, no
  `--update-snapshots`, no `just baseline`.
- **Stop and report instead of inventing** on any design question PLAN.md / ADR-046 do not answer. Send the evidence
  and your proposed answer, then wait (the lead types the answer into your terminal). Two failed attempts at the same
  gate is also a stop.

## Read first

1. `CLAUDE.md` — especially § Testing (#726's three gate shapes, the silent-drop rule) and § Key Patterns ›
   *Templates print (ADR-046)*; § Frontend Relation Graph for the precedent of reusing REL-1's builder.
2. `.ai-docs/stacks/api-surface-model/PLAN.md`: **§4.3 (the whole-set half), §4.1 (`RelationApiSurface`,
   `ProjectApiSurface`), §6.1 (the verb's output shape), §7.2, §12 Q4/Q5, §14.2's A2 table, §14.4 (F7)**, and
   §14.3. A1's "as built" notes are in §4.3, §7.1–7.3.
3. `src/derived/api/{types,names,entity}.ts` and `src/__tests__/derived/_inputs.ts` — what A1 built.
4. `.ai-docs/stacks/api-surface-model/f7-preflight/` — the four F7 variants (V0–V3) and their real `tsc` errors.

## Deliverables (PLAN §9 row A2)

| File | What |
|---|---|
| `src/derived/api/project.ts` | `deriveProjectApiSurface(ctx)`: `deriveEntityApiSurface` for every entity with `wiredTargets` = all ("what `entity new --all` emits", Q4); then **REL-1's own** `buildRelationGraph` and `buildIncludeAllowlists` through `loadRelationsEmitContext` — no second walk of the YAML (charter I1; `src/emitters/frontend/graph-model.ts` is the precedent); resolve every `delegatesTo` against the target's surface; pair declarations into `RelationApiSurface`s (`A.belongs_to(B, fk)` ↔ `B.has_many/has_one(A, foreign_key: fk)`, or an explicit `inverse:`), with `inverseOf`, `generates` indexed from origins, `includeKeys`; attach `http.includes`; list junction and `relationship:` definitions under `unmodelled` with a reason naming #679. CLI-only: it may import the emitters; it is **not** added to `package.json` `files`. |
| The F7 warning | A `relation_many` whose `delegatesTo` is missing on the target, or is not an `fk_finder`, becomes a warning with the exact text in §14.2's A2 table (V1: ``account.relationships.contacts: `AccountService.contacts` calls `ContactRepository.findByAccountId`, which contact does not emit``; V2/V3: ``…, which is a `queries:` finder, not an FK finder``). A warning, not an error: the command still exits 0. |
| `codegen project surface [--entity <name>] [--json]` | in `src/cli/commands/project.ts`, beside `project graph` (copy its shape: how it finds the project, how `--json` prints). `--json` prints `{ command, entities, surface: ProjectApiSurface }`; without it, a readable table per entity. Register it wherever `ProjectGraphCommand` is registered. |
| `src/__tests__/derived/has-many-delegate.test.ts` | four in-memory cases matching `f7-preflight/run-f7.ts` V0–V3 — exact warning texts. |
| Project-level tests + golden | tests for pairing / `inverseOf` / `generates` / `unmodelled` / `includes`; the golden extended with `relations` and `warnings` (baseline set and matrix cases; new keys or new files — existing per-entity content unchanged). |

**One more case may join the F7 warning.** The lead is checking now, by running it, whether an entity with
`eav_value_table: true` and a pattern other than `Metadata` generates a service that calls a repository method
only the Metadata repository supplies (`findByEntityIdAndType`). If it is real, the lead will send you the exact
case and the warning text to add beside F7. Build the F7 pass so a second delegate check slots in next to it.

## Exit — run all of this on your final tree, after your last edit

`ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }`

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`, `N pass` ≥ 4540 (A1's count).
2. `just test-baseline` → 0, `✅ All tests passed!`, `Typecheck passed (only the named #680 expectation`;
   `git status --porcelain test/baseline` empty. `just test-junction` → 0.
3. Every row of PLAN §14.2's **A2** table, exactly as written (`just studio-demo` first; the `S()` helper). If the
   verb cannot take `--cwd` because its siblings find the project another way, follow the siblings and report the
   command you used — do not bend the CLI to the table.
4. F7 on the CLI: V1's two YAMLs in a scratch dir **outside the repo**, `project surface --json` → exit 0,
   `.surface.warnings | length` → `1`.
5. Frozen checks, all empty / `0`:
   `git diff --stat 820e87b6 -- src/__tests__/derived/api-surface-parity.test.ts src/__tests__/derived/_parity-compare.ts src/__tests__/templates/no-name-derivation-in-templates.test.ts src/derived/api/types.ts`,
   `git diff --numstat 820e87b6 -- src/__tests__/templates/no-name-derivation.allowlist.ts | cut -f1`,
   `git diff --stat 820e87b6 -- templates package.json test/baseline test/junction/__snapshots__ src/studio tools`.
6. §14.3's detections over `git diff 820e87b6` — none prints anything. The mutation-string one is now
   `git diff 820e87b6 -- test/baseline test/fixtures runtime templates src/derived | grep -nE '^\+.*(findSpurious|findByIdz|existz|findByX|:key)'`.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; every A2 table row with its actual output; anything
built differently from PLAN §4.3 / §6.1 / §14.2 and why (the lead corrects PLAN.md); anything found beyond §3.4.
Then stop and wait.
