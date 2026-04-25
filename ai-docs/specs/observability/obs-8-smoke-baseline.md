# OBS-8: Smoke + baseline test update covering observability — Spec

**Issue:** #210 (OBS-8)
**Status:** Draft
**Last Updated:** 2026-04-24
**Depends on:** OBS-5 (merged), OBS-7 (merged)

## Overview

Close epic #195 by extending the smoke harness (`test/smoke/run-smoke.ts`) to install the observability subsystem end-to-end via `codegen subsystem install observability`, typecheck the resulting project, verify the install artifacts, and regenerate `test/baseline/` snapshots if any template-driven output deltas exist. Observability is a subsystem (not an entity), so no entity fixture changes.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `test/smoke/run-smoke.ts` | modify | Insert step 5.5: `codegen subsystem install observability` + artifact assertions |
| `test/baseline/**` | regenerate via `just baseline` | Capture any deltas (likely zero — port extensions don't touch template output) |

No new files. No CI workflow changes — `.github/workflows/ci.yml` already runs `just test-all`.

## Resolved open questions (decisions)

- **OQ-1 (add `observability/` to `OUTPUT_PATHS`?)**: **NO.** OUTPUT_PATHS captures template-emitted code; observability runtime is shipped as-is (copied verbatim by `copyRuntime`), already version-controlled. Adding would be redundant.
- **OQ-2 (extra artifact assertions beyond typecheck?)**: **YES** — include them. Low cost, high signal. Assert `codegen.config.yaml` contains `observability:` block and `app.module.ts` contains the `ObservabilityModule.forRoot` TODO hint.
- **OQ-3 (smoke runs without siblings installed?)**: **Keep minimal** — observability must typecheck standalone against empty-injection paths, per OBS-5's `@Optional()` contract. If typecheck fails, fix the cause in observability runtime, don't paper over by pre-installing siblings in the smoke.

## Implementation steps

### 1. Extend `run-smoke.ts`

Insert after step 5 (`entity new --all`) and before step 6 (`tsc`):

```typescript
// 5.5. Install the observability subsystem (combiner — ADR-025).
// No backend flag, no schema; copies runtime/subsystems/observability via
// copyRuntime, injects `observability:` into codegen.config.yaml, and
// appends a TODO hint to src/app.module.ts directing the human to wire
// ObservabilityModule.forRoot() AFTER Events/Jobs/Bridge/Sync.
//
// No siblings installed in this smoke — observability must typecheck
// standalone because its @Optional() sibling injections degrade to empty
// results when ports are absent (per OBS-5 contract).
run(`bun ${CLI_PATH} subsystem install observability`, tmpDir);

// Verify install artifacts appeared.
const configYaml = fs.readFileSync(path.join(tmpDir, 'codegen.config.yaml'), 'utf8');
if (!configYaml.includes('observability:')) {
  throw new Error('observability: block missing from codegen.config.yaml after install');
}
const appModule = fs.readFileSync(path.join(tmpDir, 'src/app.module.ts'), 'utf8');
if (!appModule.includes('ObservabilityModule.forRoot')) {
  throw new Error('ObservabilityModule TODO hint missing from app.module.ts after install');
}
```

(Adjust paths — `src/app.module.ts` vs wherever the scratch init lands it — per what the existing smoke uses for its other installs.)

### 2. Regenerate baselines

Run `just baseline`. Commit whichever snapshot files changed. Expected: **zero deltas** — OBS-2/3/4/5/6/7 didn't change any template emission, only runtime code + hand-authored CLI + new templates. If diffs appear, inspect them before committing.

### 3. Verify locally

- `just test-smoke` — passes (~60-120s)
- `just test-baseline` — green (no diffs)
- `just test-all` — green (unit + baseline + smoke)

### 4. CI

No workflow change. `.github/workflows/ci.yml` already runs `just test-all` on every PR + main.

## Acceptance criteria

- [ ] Smoke runs `subsystem install observability` and typechecks
- [ ] Smoke asserts `observability:` in `codegen.config.yaml` post-install
- [ ] Smoke asserts `ObservabilityModule.forRoot` hint in `app.module.ts` post-install
- [ ] Baselines regenerated (expected zero diffs; commit any that appear)
- [ ] `just test-all` passes locally and in CI
- [ ] No Drizzle extensions exercised (phase 1 only)

## References

- Plan: `.claude/specs/epic-195-plan.md` §OBS-8
- Smoke harness: `test/smoke/run-smoke.ts`
- Baseline runner: `test/run-test.ts`
- CI: `.github/workflows/ci.yml`
- OBS-7 scaffold: `runObservabilityScaffold` in `src/cli/commands/subsystem.ts`
- OBS-5 contract: `@Optional()` sibling injections in `observability.service.ts`
