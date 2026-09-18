# GEN-0 — one module-tree rule (#649); the emit-once `worker.ts` carries no config (#652)

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issues:** #649 (first commit), #652
**Project:** #578
**Depends on:** CFG-1 (#643 — `<generated>/app-config.ts`, `--appConfigImport`), PATH-1 (#645 — `paths.modules_dir`)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility)

## Charter invariants this PR touches

- **I1 declare once.** #649: the clean-lite-ps module tree `<modules_dir>[/<context>]/<plural>` is spelled three
  times and pinned by a test. #652: the worker's backend/extension clause is built twice
  (`subsystem-barrel-generator.ts` jobs composer, `jobs-scaffold-locals.ts` › `resolveWorkerForRootOpts`).
- **I2 generated means regenerated.** #652: the emit-once `worker.ts` bakes `jobs.backend` /
  `jobs.extensions.*`; a config edit reaches the API (`<generated>/subsystems.ts`) and never the worker.
- **I7 no shims.** Existing `worker.ts` files are not rewritten; the change is a one-time manual edit, printed by
  `subsystem install jobs` and recorded in the CHANGELOG.

## #649 — one shipped module-tree module

### Today

| Spelling | Computes |
|---|---|
| `templates/_shared/entity-naming.mjs` › `entityModuleNaming` | `plural`, `moduleGroupDir`, `moduleDir`, `entityFile` (the emission) |
| `src/cli/shared/barrel-generator.ts` › `entityFilePaths` | `<dir>/<plural>.module.ts`, `<dir>/<name>.entity.ts` (the barrels) |
| `src/cli/shared/assembly-emission-generator.ts` › `resolveEntityModuleImports` | `<dir>/<name>.repository.ts`, `<dir>/<plural>.module.ts` (assemblies, sinks) |

`src/` cannot import `templates/`, so `src/__tests__/config/module-tree-spellings.test.ts` pins the three.

### Decision

`src/config/module-tree.ts` (shipped: added to `files`, imports only `pluralize`, a runtime dependency) exports
`entityModuleNaming(entityBlock, modulesDir)`, returning what the three callers read and no more:

```ts
{ plural, moduleDir, entityFile /* no extension */, moduleFile, repositoryFile }
```

- `entity-naming.mjs` re-exports it (`'../../src/config/module-tree.js'`, the `entities-dir.js` precedent — `.ts`
  resolved by bun under `bunx --bun hygen`, and from the tarball). The prompts keep importing it from
  `entity-naming.mjs`; the name and argument order are unchanged, so no prompt call site moves.
- `entityFilePaths` (clean-lite-ps branch) returns `moduleFile` / `schemaFile = entityFile + '.ts'` from it.
- `resolveEntityModuleImports` resolves `repositoryFile` / `moduleFile` under `modulesAbs` from it.
- The junction prompt's clean-lite-ps output paths (`resolveOutputPaths`) read it too (Found 5).
- The clean-lite-ps prompt extension's own output-path map (`clpOutputPaths`) reads `moduleDir` / `entityFile` /
  `moduleFile` / `repositoryFile` instead of re-joining `moduleGroupDir` + plural. `moduleGroupDir` then had no
  reader and is not exported.
- The spelling is the emission's (string join, `modulesDir` as resolved by `projectLayout`); the barrel's former
  `path.posix.join` only ever fed `path.posix.relative`, which normalises identically.
- The pin test is deleted: one definition, nothing left to pin. `module-tree.test.ts` states the rule directly
  (flat, `context:`-nested, declared-irregular plural, under a non-default `modules_dir`).

Output is byte-identical for every fixture (baseline, junction snapshots, every smoke).

## #652 — `jobWorkerOptions` in `<generated>/app-config.ts`

### Today

`worker.ejs.t` (`unless_exists: true`) renders `JobWorkerModule.forRoot(<%- workerForRootOpts %>)`, a literal
serialised at install time from `jobs.backend` + `jobs.extensions.{drizzle,bullmq}` (base64 across the hygen argv
because yargs shreds `{ … : … }`). CFG-1 routed `jobs.pools` around it (`domainModulePools: jobPools`).

### Decision

- **One builder.** `jobWorkerBackendOptions(jobsBlock)` (`src/cli/shared/job-worker-options.ts`, with
  `drizzleJobsExtensions` moved beside it — both generators import it, and `subsystem-barrel-generator.ts` already
  imports `app-config-generator.ts`) returns the worker's backend/extension options as a value:
  `{}` | `{ domainModuleExtensions: { drizzle: {…camelCase} } }` | `{ backend: 'bullmq', domainModuleExtensions?: { bullmq: {…} } }`.
  The embedded composer serialises it (`jsonToTs`) between `mode: 'embedded'` and `domainModulePools`; the
  app-config generator serialises it between `mode: 'standalone'` and `domainModulePools` / `allPools: true`.
  `resolveWorkerForRootOpts`, `encodeWorkerForRootOpts`, the `workerForRootOpts` local / `--workerForRootOpts` arg
  and `prompt.js`'s base64 decode are deleted.
- **The regenerated export.** `<generated>/app-config.ts` gains

  ```ts
  export const jobWorkerOptions = {
    "mode": "standalone",
    …backend/extension options…,
    "domainModulePools": jobPools,
    "allPools": true
  } as const;
  ```

  always (like `jobPools`, it is emitted whether or not jobs is installed — the file has no imports, so an unused
  export costs nothing). `allPools: true` stays: the standalone worker is the sole worker and must drain the
  reserved `events_*` lanes.
- **The emit-once file.** `worker.ts` imports `jobWorkerOptions` from `<generated>/app-config` and calls
  `JobWorkerModule.forRoot(jobWorkerOptions)`. It contains no config value.
- **Existing consumers.** `subsystem install jobs` (both runtime modes, including both "already installed" early
  exits — the re-run an upgrading consumer makes; `--json` carries it as `staleWorker`) reads an existing `worker.ts`; when it does not contain
  `JobWorkerModule.forRoot(jobWorkerOptions)` it prints the two-line replacement (`staleWorkerNotice`,
  `jobs-scaffold-locals.ts`) (the import and the
  call). A string check, not a codemod: the old call is a single literal the consumer may have edited. CHANGELOG
  records the one-time edit.

### Gate

The junction smoke's custom layout (both runtime modes) installs jobs with no extension, **then** sets
`jobs.extensions.drizzle: { listen_notify: true, poll_interval_ms: 4321 }` and regenerates (`entity new --all`):

- `verify-boot.ts --expect-listen-notify` boots `AppModule` and asserts the resolved `JOBS_LISTEN_NOTIFY` is `true`
  (the composer's `JobsDomainModule.forRoot` in `<generated>/subsystems.ts` carries the new value);
- `verify-worker.ts` imports `<backend_src>/worker.ts` (bootstrap is `import.meta.main`-gated), reads the
  `JobWorkerModule` dynamic module's `JOB_WORKER_MODULE_OPTIONS` value and asserts `mode: 'standalone'`,
  `allPools: true`, `domainModuleExtensions.drizzle` = `{ listenNotify: true, pollIntervalMs: 4321 }` and the
  configured `domainModulePools` — the value the worker process would boot with, not a grep.

Before the fix, the worker leg fails — run on the #649 commit with this PR's test files:
`[worker-verify] FAIL: domainModuleExtensions.drizzle: expected {"listenNotify":true,"pollIntervalMs":4321}, got {"pollIntervalMs":1000}`
(the install-time `jobs:` block sets `poll_interval_ms: 1000`, which the old worker baked).

## Out of scope

- The `JobsDomainModule.forRoot` options (`quoteBullmqDomainOpts`) — a different options shape (`extensions`,
  `multiTenant`, `backend` always present); it already reads the same `drizzleJobsExtensions`.

## Found

1. **The value really changes.** The `jobs:` block `subsystem install jobs` writes already sets
   `extensions.drizzle.poll_interval_ms: 1000`, so the gate is a 1000 → 4321 edit (plus `listen_notify` added), not
   an unset → set one.
2. **An upgrading consumer's re-run never reached the scaffold.** Package-mode `subsystem install jobs` on a project
   that already lists `jobs` exits early ("already in subsystems.install") before the jobs scaffold runs. The
   stale-worker notice is printed on that path too.
3. **The worker's options are read, not booted.** Booting `WorkerAppModule` would start the pool workers against the
   stub database. `verify-worker.ts` reads the `JobWorkerModule` dynamic module's `JOB_WORKER_MODULE_OPTIONS`
   provider value from `WorkerAppModule`'s `imports` metadata — the value the orchestrator is injected with.
4. **`jobs.backend: memory` never reaches `JobWorkerModule`** (pre-existing; the consolidated clause kept it
   byte-identical). The worker options carry `backend` only for `bullmq`, and `JobWorkerModule` defaults its inner
   `JobsDomainModule` to `drizzle`. Filed: **#656**.
5. **#649's census missed a fourth spelling** (review). `templates/junction/new/prompt.js` › `resolveOutputPaths`
   built the junction's clean-lite-ps `entity` / `repository` / `module` paths by hand although the file already
   imported `entityModuleNaming`. It now reads them from the rule (junction snapshots byte-identical).
6. **Both "already installed" exits** (review). The vendored-mode early exit ("already installed at … (pass --force to
   reinstall)") returned without the stale-worker notice its package-mode twin printed. Both print it now, and both
   carry it in the `--json` payload as `staleWorker`. The check matches the call as a code line: the current
   template's doc comment names `JobWorkerModule.forRoot(jobWorkerOptions)` too.
7. **Posix paths only.** `entityModuleNaming` joins with `/`, and `resolveEntityModuleImports` feeds it an absolute
   `modulesAbs`. That holds only on posix, which the repo already assumes everywhere else.

## Gates

Run after the last edit.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass |
| `just test-all` | pass: 3487 unit tests, 0 fail; baseline unchanged; every smoke (base, subsystems both modes, relationship, junction ×4 incl. `--layout custom` both modes with the new GEN-0 legs, cross-domain ×2, capability both modes); junction snapshots 10 pass; integration-emit 56 pass; smoke-integration |
| `just test-integration` | pass (76 tests, 2 skip, 0 fail) |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** errors (#602) |
| `just test-post-publish` | pass: tarball contract + consumer workflow from the tarball (`src/config/module-tree.ts` resolves from the installed package) |
| GEN-0 gate, pre-fix | fails as intended on the #649 commit: `domainModuleExtensions.drizzle: expected {"listenNotify":true,"pollIntervalMs":4321}, got {"pollIntervalMs":1000}` |

