# Gate 2.5 decisions round — apply Doug's decisions (2026-11-15) on one #875 stack branch

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first. It binds you:
public repo, no sub-agents, never push, gates after the last edit.

Doug decided all 17 Gate 2.5 `DECISION` items, each as the coordinator recommended. Your prompt names your PR and your
branch. Do **only your branch's section** below.

Before you start, read:
- your PR's two Gate 2.5 reviews (`/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/gate25/<PR>-adherence.md`
  and `<PR>-quality.md`);
- your PR's fix table (`<PR>-fixes.md` in the same folder).

Each decision says what changes. **Each behaviour change gets a test that fails without it.** Show it red, then green.

**RFC ownership:**
- Only **S1** edits RFC-0006 §1–§12, including the new §11.3 table.
- Every other branch edits only **its own §13.2 slice entry** and its as-built notes.

Commit as `fix(#875 S<n>): Gate 2.5 decisions — D…` (the stack squash-merges).

## S1 — #907, `dugshub/875-s1-inherits-schema`
- **D1.** R6 fails closed. A child that declares a pattern (other than `Base`) or a capability with no `columnsRead` is an
  R6 error naming the pattern. Add `columnsRead` to `CapabilityPatternDefinition` and implement it where capabilities
  read columns. Reverse the as-built note. Tests.
- **RFC body**, in a new **§11.3 "Decided at Gate 2.5 (Doug, 2026-11-15)"**: one row per decision, D1–D17, giving the
  question, the decision, and the slice where it landed. Read the items in the review files. The short form:

  | # | Decision |
  |---|---|
  | D1 | R6 fails closed |
  | D2 | Drop the "read-only in the output" sentence in §2.4 |
  | D3 | Narrow the 63-byte claim; #921 owns explicit FK names |
  | D4 | Base-only-kind coverage on a soft-delete family |
  | D5 / D6 | Widen the no-name-derivation lint; derive the remaining helper-name sites; pre-existing hits on `main` get an issue and a named expectation |
  | D7 | Ratify S4's two scope exceptions |
  | D8 | OQ-14 confirmed |
  | D9 | Composing modules import home modules, all via `forwardRef` |
  | D10 | Ratify the changed natural-key assertion |
  | D11 | OQ-5 nests under the relation key |
  | D12 | Kind errors are domain errors only |
  | D13 | Restore the Studio origin assertions |
  | D14 | The client hides a child whose base is soft-deleted |
  | D15 | `globalThis.*` across the emitted frontend; the value rule over the whole tree |
  | D16 | Both kind invariants in the repository |
  | D17 | No change at S4 |

  Then:
  - apply **D2**: delete the §2.4 sentence;
  - apply **D8**: move OQ-14 from §11.2 to §11.1;
  - apply **D11**: edit the OQ-5 row in §11.1 to "the child is nested under its relation key";
  - cite **#921** where §2 talks about constraint-name length (D3).

Gates: `bun run typecheck`, `just test-unit`, `just test-baseline`.

## S2 — #908, `dugshub/875-s2-inherits-ddl`
- **D3.** Link **#921** in the 63-byte comment (`assertDistinctConstraints` / C5), in the
  `constraint-name-length` test header, and in S2's as-built note.
- **D2.** S2's "Not done" bullet about the output DTO now reads "decided: not emitted (D2, §11.3)".

Gates: `bun run typecheck`, `just test-unit`, `just test-baseline`.

## S3 — #909, `dugshub/875-s3-inherits-reads`
- **D4.** Add a **scaffold-only** soft-delete family, so a base-only kind is covered on the soft-delete path.
  - The family: a base `document` (tenant-scoped, `soft_delete`, `discriminator: kind` with `[memo, report]`) and one
    child `report`, so `memo` is base-only. Use generic fields.
  - Put it in `test/scaffold/entities/`, scaffold only. Do not add it to the baseline, smoke or inheritance fixture
    sets, so fixture agreement is unaffected.
  - Re-export it from `test/scaffold/schema.ts`.
  - Read cases in the inheritance read tests: `findAllKinds` returns a `memo` bare and a `report` nested; a
    soft-deleted `memo` is absent; a soft-deleted base hides its `report` at the root and at a hop.

Gates: `bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-integration`.

## S4 — #910, `dugshub/875-s4-inherits-writes`
- **D16.** Both kind invariants live in the repository, the one owner of the pair write. `KindRequiresChildError` moves
  into the base repository's `create` / `upsertByNaturalKey`, next to `KindImmutableError`. The service calls through
  and keeps no copy. Test a direct repository call.
- **D7.** Amend S4's §13.2 "Must not touch" line to name the two ratified exceptions (`deriveColumns` in the
  Integrated / Metadata repositories; S3's `<Child>Flat` alias fix), pointing at the as-built bullets.
- **D9 / D10.** Record both as ratified in S4's as-built note (§11.3 has the decision).
- **D4.** Write cases on S3's `document` family: create and upsert a base-only `memo`; soft-delete it.
- **D17.** No change.
- **Also fix:** `just test-junction` is red at this tip. The `junction emission snapshot — opportunity_contact`
  `contact.service.ts` case fails after S4's service-template changes. Find out why. If the new bytes are right, re-bless
  that snapshot and explain it. If they are wrong, fix the template.

Gates: `bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-junction`, `just test-integration`.

## S5 — #911, `dugshub/875-s5-inherits-http`
- **D12.** `KindRequiresChildError`, `KindImmutableError` and `KindMismatchError` are **domain errors only**:
  - delete the controller's unreachable `kindError` mapping and its stub test;
  - the real-route test asserts the zod issue that refuses the request;
  - `createPath` names the child's derived **service method**, read from the derived surface, not an HTTP route;
  - RFC S5 as-built updated.
- **D13.** Restore the Studio `origin.text` assertions (`'← inherits'`) with the current chip text.
- **D5 / D6.** Widen the no-name-derivation lint
  (`src/__tests__/templates/no-name-derivation-in-templates.test.ts`) to also catch `.charAt(0).toLowerCase()` and
  `.toUpperCase().replace(`. Derive every remaining hit in **#875's** templates through `src/derived/api/names.ts`, so
  none is left (no allowlist entry). For a hit that **already exists on `origin/main`**, do not fix it. List it (file,
  line, pattern) in your report: the coordinator files an issue, and it becomes a named expectation. The allowlist
  never grows.
- **D4.** HTTP case on S3's `document` family: `POST /documents` with `kind: memo` creates it; `kind: report` is
  refused by the DTO.

Gates: `bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-integration`, `just test-studio`.

## S6 — #912, `dugshub/875-s6-inherits-frontend`
- **D14.** When the base has `soft_delete`, emit `.where(({ base }) => isNull(base.deletedAt))` in `<plural>WithBase(q)`
  and in the child-to-base root hop.
  - Gate it: frontend smoke usage plus the text checks.
  - Correct the RFC §3.4 / §8 / S6 note to the new behaviour.
- **D15.** Emit `globalThis.Map` / `globalThis.URL` (every lib global in value position) in the store and collections
  emitters. Turn the `values` hygiene rule on for the **whole** emitted frontend tree, with no opt-in and no directory
  scope. Re-bless the frontend goldens.
- **Also check:** the `src/__tests__` test "the CLI and a direct hygen run both refuse an invalid config > hygen entity
  new (prompt run directly) exits non-zero naming the key" failed once in a parallel `test-all`. Run it alone 5 times. If
  it ever fails alone, find the cause and fix it. If it never does, say so.

Gates: `bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-smoke-frontend`, `just test-studio`.

## Report

`SendMessage` to `codegen-patterns-73` (hc terminal `t1rf`): a decision → commit / test table, the gate tails, and
(S5) the list of pre-existing lint hits.
