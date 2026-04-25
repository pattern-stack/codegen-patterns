# Issue #119 (F11) — Idempotent main.ts hook injection

## Problem

`codegen subsystem install jobs` injects a comment block into `src/main.ts` via `templates/subsystem/jobs/main-hook.ejs.t`. The template's `skip_if: "JobWorkerModule"` regex is unreliable — running the command again produces a duplicate comment block (repro'd in TEST-SESSION-1 Phase A).

Note: the original GitHub issue body attributed this to `init-scaffold.ts` / `project init --force`. That attribution is incorrect; the code path is the jobs subsystem scaffold.

## Files to change

1. `templates/subsystem/jobs/main-hook.ejs.t` — swap `skip_if` regex for a `<%= mainHookInjected %>` Hygen local.
2. `src/cli/shared/jobs-scaffold-locals.ts` — add `readFile` probe to input, compute `mainHookInjected` via a sentinel substring check, serialize it through the existing empty-string-is-falsy arg helper.
3. `src/cli/commands/subsystem.ts` — plumb a `readFile` implementation through to `resolveJobsScaffoldLocals` in `runJobsScaffold`.
4. `src/__tests__/cli/jobs-scaffold-locals.test.ts` — supply `readFile` in existing tests, add 3 new tests covering the true/false/serialize paths.

## Approach

Mirror the existing `workerExists` pattern — it already handles the "was this scaffolded before?" question for worker.ts with deterministic unit tests and no Hygen integration harness. `mainHookInjected` follows the same shape: a pure function of injected `readFile` + `fileExists` probes; empty-string maps to falsy in Hygen front-matter.

Sentinel constant: `'JOBS — Embedded worker mode (optional)'` (the literal first line of the injected comment). Unique enough that user-authored `main.ts` content cannot false-positive.

## Why not merge / why this approach

- A regex `skip_if` is what failed; upgrading the regex doesn't address the root problem (Hygen's regex matching isn't guaranteed here).
- Computing the skip flag in TypeScript gives us exact-string control and lets the fix be unit-tested without invoking Hygen.
- Consistent with `workerExists` — one mental model for "was this scaffolded before?"

## Test strategy

Pure unit tests in `src/__tests__/cli/jobs-scaffold-locals.test.ts`. No integration harness needed. Runs under `just test-unit` (~200ms).
