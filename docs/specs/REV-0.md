# REV-0 — retroactive review follow-ups under the Unit 4 chain (#688)

**Status:** Implemented
**Date:** 2026-09-19 · **Implemented:** 2026-09-19
**Issue:** #688
**Project:** #578
**PR base:** `dugshub/678-junction-regeneration` (#685). The findings are in PRs that sit *under* the Unit 4 chain.
Rewriting those branches would restack the whole chain, so the fixes land here, at the top.
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4

The findings come from the retroactive session-3 reviews posted on #621 (CAP-1), #605 (DRZ-2), #607 (GATE-2),
#600 (GATE-1) and #610 (REL-0). Line numbers in those reviews point at the older branches. Each finding was
located again on the chain tip before it was fixed.

## Charter invariants this PR touches

- **I9 honest gates.** Every smoke `tsc` gate, and the baseline typecheck, now fails when `tsc` exits non-zero, or
  with no status, and prints no `error TS` line. Before, such a run passed. The location-only scoping in
  `_consumer-errors.ts` is unchanged.
- **I7 no backwards compat.** A columns-only capability and a `config:` block for a capability with no schema are
  now errors. Neither gets a deprecation path.

## Findings → fix → where

| # | Source | Finding | Fix | Where |
|---|---|---|---|---|
| 1 | CAP-1 should-fix 1 | The integration assembly/sink gate picked the spine by position (`pattern ?? patterns[0]`). With `patterns: [Actor, Integrated]` + `surface:`, the repository got the Integrated surface but the entity got no assembly or sink, and the error message was misleading. | Use `composePatterns(declaredPatternNames(e), getPattern).spineName`. The skip reason now names the composed spine. | `src/cli/shared/adapter-emission-generator.ts` (assembly loop). Failing-first tests: `src/__tests__/cli/adapter-emission-generator.test.ts` › "picks the spine by composition…" / "names the composed spine…" |
| 2 | CAP-1 should-fix 2 | The collision vocabulary left out the FK-traversal `findBy<Fk>` methods and the spine's declared inherited methods, so a clash surfaced only at consumer `tsc` (TS2416). | Both are added as non-capability vocabularies at generation. The analyzer (`validatePatternComposition`) gets the spine vocabulary too; it has no FK context. | `templates/entity/new/clean-lite-ps/prompt-extension.js` (collision check), `src/patterns/validate-composition.ts`, `src/patterns/compose.ts` (doc). Tests: `prompt-extension.test.ts`, `validate-composition.test.ts` |
| 3 | CAP-1 nit | `CAP-1.md` fixture table order did not match the fixtures. | Table corrected to the fixtures on the chain tip, with a note on what CAP-2/CAP-3 added. | `docs/specs/CAP-1.md` |
| 4 | CAP-1 nit | A columns-only capability passed the registry but emitted nothing. | **Rejected.** Pattern `columns` are collision-checked, never emitted, so a capability needs a `mixin` or `forwarderMethods`. | `src/patterns/registry.ts` (`assertHasContribution`), `src/patterns/pattern-definition.ts` (doc). Test: `registry.test.ts` |
| 5 | CAP-1 nit | `hasConfig` emitted `<cap>Config` for a capability with no `configSchema`. | A `config:` block for a schema-less capability throws at generation. | `prompt-extension.js` (capability loop). Test: `prompt-extension.test.ts` |
| 6 | DRZ-2 should-fix 1 | Smoke gates read only parsed `error TS` lines, never `tsc`'s exit code, and `runSilent` mapped a null status to 0. | New `tscGateErrors({ code, output }, projectDir)`: `consumerErrors` plus a failure on a non-zero/null exit with no `error TS` line. Every smoke tsc call site uses it. `runSilent` keeps a `null` status. The baseline typecheck fails on a non-zero exit with no diagnostics. | `test/smoke/_consumer-errors.ts`; `run-smoke.ts`, `run-smoke-subsystems.ts` (×2), `run-smoke-junction.ts` (×2), `run-smoke-capability.ts`, `test/smoke-integration/run.ts`; `test/run-test.ts`. Tests: `src/__tests__/smoke/consumer-errors.test.ts` › "tscGateErrors — fails closed…" |
| 7 | DRZ-2 nit | `JOB-1.md` revision blockquote split a bullet list. | Blockquote moved below the list. | `docs/specs/JOB-1.md` |
| 8 | DRZ-2 nit | `codegen dev` ran `bunx drizzle-kit push`, which fetches `@latest` when the project has no kit. | `bunx --no-install drizzle-kit push`, with a warning that names the likely cause. | `src/cli/commands/dev.ts`, `.claude/skills/dev-companion/SKILL.md`, `docs/consumer/drizzle.md` |
| 9 | GATE-2 should-fix 1 | Stale `justfile` comment: `test-smoke-integration` "scoped to src/integrations/**". | Comment says whole project, location-only scoping, fail-closed exit. | `justfile` |
| 10 | GATE-2 should-fix 2 | Confirm CLAUDE.md "no gate … carves out a directory" on the chain tip. | **Already true, no change.** `test/tsconfig.baseline.json` includes all of `packages/api/src/modules/**`, the whole clean-lite-ps output. The baseline's other generated files, `runtime/subsystems/{events,jobs}/generated/`, are covered by `bun run typecheck` (`tsconfig.build.json` includes `runtime/**`). | — |
| 11 | GATE-1 nit | `test/run-test.ts:302` comment said NestJS resolves via `test/scaffold/`. | **Already fixed on the chain tip.** ARCH-0 rewrote the `typecheckBaseline` doc comment. | — |
| 12 | GATE-1 nit | Integration teardown `rm -rf`s repo-root `modules/`, `generated/`, `shared/` unguarded. | Each dir is removed only if `git ls-files` lists nothing under it. Otherwise the run fails and names the tracked files. | `test/scaffold/run-integration.ts` |
| 13 | REL-0 should-fix | No CHANGELOG entry for the second `TTable` type parameter. | Breaking entry under `[Unreleased]`. | `CHANGELOG.md` |
| 14 | REL-0 nits | ADR-005 and ADR-021 show the one-parameter / `PgTableWithColumns<any>` forms. | Dated revision notes. | `docs/adrs/ADR-005-*.md`, `docs/adrs/ADR-021-*.md` |

Also: `ADR-041` gets a dated revision note for findings 1, 2, 4 and 5. `CHANGELOG.md` records the consumer-visible
changes (finding 1 under Fixed; 2, 4, 5 and 8 under Changed).

## Review follow-up (#692 review, PASS_WITH_NOTES)

| Nit | Fix |
|---|---|
| 1. The repository and service inherited-method lists were flattened into one vocabulary, so a clash could name the wrong side. | Split into two vocabularies, `the spine 'X' (repository)` and `the spine 'X' (service)`, in both the generation check and the analyzer. Both sides stay in scope for a capability's `forwarderMethods`: the service emits the forwarder and the mixin must carry the method it forwards to, so a name on either side is a real collision — only the message changes. Test: `prompt-extension.test.ts` › "names the spine side a capability method collides with" (`upsertMany`, repository-only on `Integrated`). A capability method that is *not* declared in `forwarderMethods` (e.g. `Actor`'s `memberPredicate`) is invisible to codegen either way, as ADR-041 §4 already says. |
| 2. `run-integration.ts` called Bun `$` inside `finally`; a throw there would mask `exitCode` and skip `process.exit`. | `.nothrow()`, with the non-zero git exit handled explicitly: the directory is kept and the run fails. |
| 3. `bunx --no-install` is a consumer behaviour change; the review recommended pinning `drizzle-kit` in the scaffold's devDependencies plus a smoke assertion that `codegen dev up` can push on a fresh scaffold. | **Measured; the recommendation does not apply, so the skip/warning path is asserted instead.** See below. |

### Nit 3 — why there is no scaffold pin

Measured by running `project init --yes` into an empty project:

- **`project init` writes no `package.json` and edits none** (except a *frontend* one, via `mergeFrontendDeps`). Backend
  peer deps are the consumer's own `bun add`, per `docs/CONSUMER-SETUP.md`. There is no scaffold devDependencies list
  to add an exact `drizzle-kit` pin to.
- **`project init` emits no `drizzle.config.ts`.** `codegen dev up` pushes only when that file exists, so on a fresh
  scaffold it attempts **no push at all** — with or without a kit installed. drizzle-kit becomes relevant only once the
  consumer authors the config, which is exactly where `docs/consumer/drizzle.md` tells them to
  `bun add -D drizzle-kit@1.0.0-rc.4` (exact, matching the ORM line).

Adding a pin would therefore mean `project init` taking ownership of the consumer's `package.json`, which is a
different decision from this review nit, and it would still not make `dev up` push (no config file).

What is asserted instead, in `src/__tests__/cli/dev-drizzle-push.test.ts` against two small exported helpers
(`drizzlePushPlan` / `drizzlePushWarning` in `dev.ts`): a fresh scaffold plans **no** push; with a config file the
command is exactly `bunx --no-install drizzle-kit push --config <file>` and names no `@latest`; a `.js` config is
accepted; and the warning names drizzle-kit as the likely cause while keeping the underlying stderr. A real push needs
Docker and a live Postgres, so it stays out of `test-all` (which is Docker-free).

## Found while implementing

- `test/smoke-integration/run.ts` read `tsc.out + tsc.err`, but its `runSilent` returns no `err` field; stderr is
  already folded into `out`. So the gate appended the string `"undefined"` to the output. The mistake was harmless,
  and nothing typechecked it: `tsconfig.build.json` excludes `test/`. Fixed in place with finding 6.

- `codegen dev up`'s push branch computed a `DATABASE_URL` string and never used it: unlike the app start beside it,
  the push runs with the ambient environment only, though the documented `drizzle.config.ts` reads that variable.
  The dead line is gone and the gap is filed as **#693**; fixing it needs `runCmd` to take an `env`, which is a
  behaviour change beyond this PR.

## Out of scope

- The second-drizzle install from the surface packages' `@pattern-stack/codegen` peer range (DRZ-2 review item 2).
  It was filed separately by that review.
- The `isInside` string-prefix compare on macOS symlinked tmpdirs (GATE-2 minor). CI runs on Linux, and the review
  asked for no action.
