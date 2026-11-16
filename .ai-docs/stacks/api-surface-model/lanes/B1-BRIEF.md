# Lane brief — B1: byte goldens over the render matrix (Phase B's safety net)

You are the **build lane for PR B1**, the first PR of Phase B. One PR's worth of work, nothing more.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-b1`, branch
  `dugshub/api-surface-b1` (checked out; it sits on A4 for now — the lead rebases it onto A5 when A5 lands; B1 adds
  only new files, so nothing will conflict). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## Why B1 exists

Phase B makes the backend templates print from the derivation, and its whole claim is "no behaviour change": every
step must leave generated output **byte-identical**. `just test-baseline` proves that only for what the baseline
fixtures exercise, and the plan found (finding F2) that the baseline has **no** EAV, no capability forwarder, no
composed base, no `api: false`, no `api.includes` wiring and no `generate.writes: false`. B1 snapshots the bytes of
those shapes **today, before any template is touched**, so B2–B4 cannot change them unseen.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** Never put host-application names, paths, table names or "dogfood"
  references into code, comments, test names or fixtures. Use only the repo's own fixture names.
- **Touch no existing file.** Frozen: `templates/**`, `src/derived/**`, `src/__tests__/derived/**` (reuse
  `_render-matrix.ts` and `_render.ts` as they are — if they need a change, stop and report), `test/api-surface-golden/**`,
  `test/baseline/**`, every other golden and snapshot, `package.json`, `test/run-test.ts`,
  `test/smoke/_consumer-errors.ts`, `src/__tests__/templates/no-name-derivation*`.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no `--update-snapshots`, no `just baseline`.
- **Stop and report instead of inventing.** In particular: if any output is not deterministic (timestamps, absolute
  paths, ordering that varies run to run), stop and report it — do not scrub it in the golden without saying so.

## Read first

1. `CLAUDE.md` § Testing (the three #726 gate shapes) and § Key Patterns › *Templates print (ADR-046)*.
2. `.ai-docs/stacks/api-surface-model/PLAN.md` **§2 (F2), §5, §7.1 (Subject B), §9 row B1, §14.2's B1 table, §14.3**.
3. `src/__tests__/derived/_render-matrix.ts` (the 11 cases) and `_render.ts` (how they are rendered in-process:
   `buildBackendLocals` + the prompt's extra locals + `ejs.render`), and how `api-surface-parity.test.ts` uses them.
4. `src/__tests__/emitters/relations/golden-manifest.test.ts` — the golden/update pattern to mirror.

## Deliverables (PLAN §9 row B1)

| File | What |
|---|---|
| `test/render-golden/<case>/…` | for every matrix case, every file the backend templates render for every entity of that case, byte for byte, at its project-relative path (so a missing file is visible as a missing file). |
| `src/__tests__/backend/render-golden.test.ts` | renders each case through the same in-process path the parity test uses, compares to the snapshot **byte for byte, both directions** (a file rendered but not snapshotted fails; a snapshot with no rendered file fails), and names the case and file in the failure. Regenerates only with `UPDATE_RENDER_GOLDEN=1`. It must also fail if a case renders zero files. |

## Exit — run all of this on your final tree, after your last edit

`ROOT=$(git rev-parse --show-toplevel); U() { bun test "$ROOT/src/__tests__/$1"; }`

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`.
2. `just test-baseline` → 0, `✅ All tests passed!`; `git status --porcelain test/baseline` empty.
3. `git diff --stat dugshub/api-surface-a4 -- templates src/derived src/__tests__/derived test/api-surface-golden test/baseline package.json` → empty (only new files).
4. `U backend/render-golden.test.ts` → exit 0, ` 0 fail`. Run it **twice** and confirm the second run is also green
   (determinism).
5. Each F2 gap is byte-covered — each prints ≥ 1 file:
   `grep -rl findByIdWithFields test/render-golden`, `grep -rl upsertCurrentValues test/render-golden`,
   `grep -rl 'Capability forwarders' test/render-golden`, `grep -rl ComposedBase test/render-golden`,
   `grep -rl '_API_INCLUDES.list' test/render-golden`.
6. The `api: false` case has no `*.controller.ts` for the disabled entity; the `generate.writes: false` case has no
   `create-*.use-case.ts` for that entity (`ls` / `find` the case dir).
7. **Mutation (§14.2 B1):** `perl -pi -e 's/async findByIdWithFields/async findByIdWithFieldz/' templates/entity/new/backend/service.ejs.t`
   → `U backend/render-golden.test.ts` exit 1, the failure naming the EAV case and file. Revert with
   `git checkout -- templates/entity/new/backend/service.ejs.t`; `git status --porcelain` back to what it was.
   Also one of your own: delete one snapshot file → the test fails naming it; restore.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files (how many snapshot files per case); each exit step → exit code → the deciding line; both mutations'
red lines; anything that wasn't deterministic; anything built differently from PLAN §9/§14.2 B1. Then stop and wait.
