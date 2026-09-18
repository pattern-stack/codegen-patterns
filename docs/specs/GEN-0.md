# GEN-0 — one module-tree rule (#649); the emit-once `worker.ts` carries no config (#652)

**Status:** Draft
**Date:** 2026-09-18
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

- **One builder.** `jobWorkerBackendOptions(jobsBlock)` (in `subsystem-barrel-generator.ts`, next to
  `drizzleJobsExtensions`) returns the worker's backend/extension options as a value:
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
- **Existing consumers.** `subsystem install jobs` (both runtime modes) reads an existing `worker.ts`; when it does
  not contain `JobWorkerModule.forRoot(jobWorkerOptions)` it prints the two-line replacement (the import and the
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

Before the fix, the worker leg fails (`worker.ts` was rendered at install, without the extension).

## Out of scope

- The `JobsDomainModule.forRoot` options (`quoteBullmqDomainOpts`) — a different options shape (`extensions`,
  `multiTenant`, `backend` always present); it already reads the same `drizzleJobsExtensions`.

## Found

_(filled during implementation)_

## Gates

_(filled after the last edit)_
