# CFG-0 — `codegen.config.yaml` is validated at runtime, once, for every reader

**Status:** Design
**Date:** 2026-09-18
**Issue:** #640
**Project:** #578
**Depends on:** CLI-0 (#641, `paths.entities_dir` deleted)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility)

## Why

`codegen.config.yaml` is never validated. The CLI (`src/cli/shared/context.ts` › `loadConfigFromPath`) casts
`yaml.parse` output to `CodegenConfig`; `PathsConfigSchema` is used only for its type, and is `.passthrough()`. The
hygen prompts run in a `bunx --bun hygen` subprocess and read the same file raw through **five more loaders**:
`src/config/config-loader.mjs` (→ `paths.mjs`, `locations.mjs`, `naming-config.mjs`), `runtime-mode.mjs`
› `loadRuntimeMode`, `templates/_shared/entity-naming.mjs` › `projectEntityLookup`, `templates/entity/new/prompt.js`
(twice: `behaviors.strategy`, `patterns`) and `templates/junction/new/prompt.js`. Two further TS loaders
(`src/config/config-loader.ts`, `src/utils/config-loader.ts`) validate a few blocks with Zod but are imported by
nothing.

So a misspelled or removed key is silently ignored and the default applies. `paths.entities_dir: defs` (deleted in
CLI-0) reads entities from `entities/` with no message; so does the typo `paths.entitis`. And the schema that claims to
be the single source of truth for `paths.*` does not declare three keys `paths.mjs` reads.

## Charter invariants this PR touches

- **I1 declare once.** One schema (`CodegenConfigSchema`) declares every key; one loader
  (`src/config/project-config.ts`) parses it; every reader — CLI, `.mjs` helpers, prompts — gets the parsed object.
- **I7 no backwards compatibility.** An unknown or removed key is an error naming the key and the file. No alias, no
  warning mode, no `--no-validate`. Keys nothing reads are deleted from their writers and readers, not declared.
- **I9 gates are honest.** Gate 2 is a grep over the source, not a list maintained by hand.
- **I11 scope.** Generator plumbing only. Generated output is unchanged except where a deleted key was written into a
  consumer's `codegen.config.yaml` (the `auth:` injector, `project scan --write`).

## Design

### One schema, closed

`src/schema/codegen-config.schema.ts` gains `CodegenConfigSchema`, a `.strict()` object whose keys are the top-level
blocks below. Every block whose keys can be enumerated is `.strict()`; `.passthrough()` is gone from the file. The
only open maps are the ones that model a map by design:

- `jobs.pools` — keyed by pool name (the five framework pools plus user pools); each **value** is `.strict()`.
- `frontend.parsers` — keyed by Electric column type (unchanged).

`locations` is closed: its keys are the location names the generator reads (the default table in `locations.mjs`,
minus the entries nothing reads — see the census). `subsystems.install` is an enum of the known subsystem names.

### One parse, one loader

`src/config/project-config.ts` (new, ships in `files`, imports only `node:*`, `yaml` and the two schema files, which
also ship) owns reading, parsing and validating:

- `resolveConfigPath(cwd)` — `CODEGEN_CONFIG_PATH` when set (the CLI sets it for the hygen subprocess, so an explicit
  `--config` reaches the prompts), else `findConfigUpward(cwd)` (the CLI's existing rule).
- `loadCodegenConfig(configPath)` — read, `yaml.parse`, `CodegenConfigSchema.parse`; cached per path for the life of
  the process. Throws `CodegenConfigError`, whose message names the file and lists every issue as
  `<key.path>: <message>`; an unknown key reads `paths.entities_dir: unknown key (expected one of: backend_src, …)`.
- `loadProjectConfig(cwd)` — `resolveConfigPath` + `loadCodegenConfig`; `null` when there is no file.

Readers after the change:

| Reader | Before | After |
|---|---|---|
| `src/cli/shared/context.ts` | `yaml.parse` cast to `CodegenConfig`; any error → `null` | `loadCodegenConfig`; `CodegenConfig` is `z.infer<typeof CodegenConfigSchema>` |
| `src/config/config-loader.mjs` | `yaml.parse` at `process.cwd()`; error → warning + `null` | `loadProjectConfig(process.cwd())` |
| `src/config/runtime-mode.mjs` › `loadRuntimeMode` | own `yaml.parse`; any error → `package` | `loadProjectConfig(cwd)?.runtime ?? 'package'` |
| `templates/_shared/entity-naming.mjs` | own `yaml.parse` of `paths` | `loadProjectConfig(cwd)?.paths` |
| `templates/entity/new/prompt.js` | two own `yaml.parse`s (`behaviors`, `patterns`) | `getProjectConfig()` |
| `templates/junction/new/prompt.js` | own `yaml.parse` | `loadProjectConfig(cwd)` |
| `src/config/naming-config.mjs` | deep-merge + re-validate `naming` | reads the parsed, defaulted `naming` |
| `src/cli/commands/project-upgrade-auth.ts` › `authBarrelImport` | regex over the file text for `runtime: vendored` | `loadProjectConfig(projectRoot)?.runtime` |
| `src/emitters/frontend/load-context.ts` | re-parses `frontend` with `safeParse`, silently defaulting on failure | reads the parsed block |
| `src/config/config-loader.ts`, `src/utils/config-loader.ts` | unimported | deleted |

The CLI throws `CodegenConfigError` out of `loadContext`; Clipanion prints `Codegen Config Error: …` and exits 1
(the error carries `clipanion: { type: 'none' }`, so no stack). A prompt run directly through hygen throws the same
error at import of `config-loader.mjs`, and hygen exits non-zero.

**Out of scope, declared only:** three readers run inside the *consumer's app*, not the generator — the generated
`main.ts` (`openapi.*`, `auth.devAllowAnonymous`; `init-scaffold.ts`, `project-upgrade-openapi.ts`,
`project-upgrade-auth.ts`) and the jobs runtime's `pool-config.loader.ts` (`jobs.pools`). They cannot import the
generator's loader without making it a runtime dependency of the app. Their keys are declared, so the generator
rejects a bad value before the app sees it. Follow-up issue filed (see Found).

### Key census

Every key path read anywhere, whether it is declared, and who reads it. "Delete" means the key is removed from its
reader and from every writer; the schema then rejects it.

| Key | Declared? | Readers |
|---|---|---|
| `runtime` | yes (`package` \| `vendored`, default `package`) | `runtime-import.ts` › `resolveRuntimeMode` (CLI), `runtime-mode.mjs` (prompts), `project-upgrade-auth.ts` |
| `paths.backend_src` | yes | `paths.mjs`, `locations.mjs`, `junction/new/prompt.js`, `entity.ts`, `events.ts`, `subsystems-path.ts`, `subsystem-detect.ts`, `barrel-generator.ts`, `orchestration.ts`, `*-scaffold-locals.ts` |
| `paths.frontend_src` | yes | `paths.mjs` |
| `paths.entities` | yes | `entities-dir.ts` (CLI + `entity-naming.mjs`), `auth-integrations-scaffold-locals.ts` |
| `paths.events_dir` | yes | `events-path.ts` |
| `paths.jobs_dir` | yes | `jobs-path.ts` |
| `paths.providers` | yes | `entity.ts`, `emitters/frontend/load-context.ts` |
| `paths.subsystems` | yes | `subsystems-path.ts`, `subsystem-detect.ts`, `events.ts`, `context.ts` |
| `paths.modules_dir` | yes | `subsystem-detect.ts`, `auth-integrations-scaffold-locals.ts` |
| `paths.orchestration_src` | yes | `paths.mjs`, `entity.ts`, `orchestration.ts` |
| `paths.generated` | yes (default `src/generated`) | `paths.mjs`, `barrel-generator.ts`, `project.ts` |
| `paths.packages` | **delete** | `paths.mjs` `BASE_PATHS.packages` — read by nothing |
| `paths.schema_dir` | **delete** | `paths.mjs` `BASE_PATHS.schemaDir` → prompt local `schemaDir`, used by no template |
| `paths.manifest_dir` | **delete** | `paths.mjs` `BASE_PATHS.manifestDir` — read by nothing |
| `generate.architecture` | yes (default `clean`) | `paths.mjs`, `prompt.js`, `junction/new/prompt.js`, `barrel-generator.ts`, `project.ts`, `load-context.ts` |
| `generate.frontend` | yes (default `false`) | `paths.mjs`, `entity.ts` |
| `generate.analytics` | yes, unread (`none` \| `cube`) | none today — PLAN Unit 3 replaces it with `generate.semantic` |
| `generate.drizzleSchema` / `commands` / `queries` / `dtos` | yes (default `true`) | `prompt.js` → `generate.*` locals, read by `backend/` (`clean`) templates — #602 territory |
| `generate.schemaServer` / `schemaClient` / `electricMigrations` | **delete** | `prompt.js` locals read by no template |
| `patterns` | yes (glob list) | `pattern-globs.ts` (CLI), `prompt.js` |
| `frontend.*` | yes (unchanged, already strict) | `emitters/frontend/load-context.ts` |
| `auth.devAllowAnonymous` | yes | generated `main.ts` (consumer runtime) |
| `auth.redirect_uri_base` | yes | `auth-scaffold-locals.ts` |
| `auth.encryption_key` / `oauth_state_store` / `enable_controller` | **delete** | written by the `auth:` injector, read by nothing |
| `naming.*` (`fileCase`, `suffixStyle`, `entityInclusion`, `terminology.{command,query}`, `layers.<layer>.*`) | yes (`BackendNamingConfigSchema`, now strict) | `naming-config.mjs` → `paths.mjs`, `prompt.js` |
| `locations.<name>.{path,import}` | yes, for the 21 names read | `locations.mjs` → `paths.mjs` (`BACKEND_LAYERS`), `prompt.js`, `prompt-extension.js`, templates; `load-context.ts` (`dbEntities`, `frontendCollectionsAuth`) |
| `locations.{backendSrc,frontendSrc,frontendCollections,frontendStore,frontendStoreEntities,frontendEntities,frontendEntityMetadata,trpcClient}` | **delete** | defaults in `locations.mjs` read by nothing |
| `database.dialect` | yes (`postgres` \| `sqlite`, default `postgres`) | `paths.mjs` → `backend/database/*.ejs.t` (`clean`) — #602 territory |
| `behaviors.strategy` | yes (`base_class` \| `inline`, default `inline`) | `prompt.js` → `backend/database/repository.ejs.t` (`clean`) — #602 territory |
| `dev.port` | yes | `dev.ts` |
| `subsystems.install` | yes (enum of subsystem names) | `subsystem-detect.ts`, `subsystems-install-config.ts` |
| `events.{backend,multi_tenant}` | yes | `subsystem-barrel-generator.ts`, `subsystem-detect.ts`, `events-scaffold-locals.ts` |
| `events.extensions.drizzle.listen_notify` | yes | `subsystem-barrel-generator.ts` |
| `events.pools` | **delete** | commented example in the `events:` injector, read by nothing |
| `jobs.{backend,multi_tenant,worker_mode,worker_pools,all_pools}` | yes | `subsystem-barrel-generator.ts`, `jobs-scaffold-locals.ts`, `subsystem-detect.ts` |
| `jobs.extensions.drizzle.{listen_notify,poll_interval_ms,stale_threshold_ms,stale_sweeper_interval_ms,claim_heartbeat_interval_ms}` | yes | `subsystem-barrel-generator.ts` |
| `jobs.extensions.bullmq.{redis_url,queue_prefix,bull_board.{enabled,mount_path}}` | yes | `subsystem-barrel-generator.ts`, `jobs-scaffold-locals.ts` (runtime shape `BullMqExtensionsConfig`) |
| `jobs.pools.<name>.{queue,concurrency,reserved,description}` | yes (open map, strict value) | jobs runtime `pool-config.loader.ts` (consumer runtime) |
| `bridge.{backend,multi_tenant}` | yes | `subsystem-barrel-generator.ts`, `bridge-scaffold-locals.ts`, `subsystem-detect.ts` |
| `integration.{backend,multi_tenant}` | yes | `subsystem-barrel-generator.ts`, `integration-scaffold-locals.ts`, `subsystem-detect.ts` |
| `integration.differ.{ignore,unignore}` | yes | `subsystem-barrel-generator.ts` |
| `observability.reporters.bridgeMetrics.{enabled,intervalMs,windowHours}` | yes | `subsystem-barrel-generator.ts`, `observability-scaffold-locals.ts` |
| `openapi.{enabled,path,title,version,description,auth}` | yes | generated `main.ts` (consumer runtime) |
| `cache.backend`, `storage.backend` | yes | `subsystem-detect.ts` › `configuredInstalledSubsystems` |
| `<name>.backend` for `observability`, `auth`, `auth-integrations`, `openapi-config` | **delete** | the same generic `config[name].backend` read; those subsystems have one backend. The read is narrowed to the six blocks that declare `backend` |
| `framework`, `orm`, `layout.*`, `_confidence`, `naming.suffixes`, `paths.{domain,application,infrastructure,presentation}` | **delete** | written by `project scan --write`, read by nothing |

## Acceptance

1. `loadCodegenConfig` on a file with `paths.entities_dir` throws `CodegenConfigError` naming `paths.entities_dir` and
   the file (issue gate 1). Same for the typo `paths.entitis`, an unknown top-level key, and an unknown key inside
   `jobs.pools.<name>`.
2. A unit test greps `src/`, `templates/` and `runtime/` for every `paths.<key>` read off a config object and
   asserts each key is declared in `PathsConfigSchema` (issue gate 2); a second grep does the same for every top-level
   key read off the parsed config.
3. `codegen entity new --all` with an unknown key exits 1 and prints the key; so does `hygen entity new` run directly.
4. Every fixture config (`test/fixtures/codegen.config*.yaml`), every subsystem-config injector block, the config
   `project init` writes and the config `project scan --write` writes pass the strict parse (unit-tested).
5. No reader of `codegen.config.yaml` in the generator calls `yaml.parse` on it except `project-config.ts` (the
   config-block injectors edit the file as text and are writers).

## What downstream must know

- Adding a config key = declare it in `CodegenConfigSchema` with a comment naming its reader. Reading an undeclared
  key is a type error in TS and a gate-2 failure everywhere.
- The parsed config carries schema defaults (`generate`, `frontend`, `auth`, `naming`, `behaviors`, `database`,
  `paths.generated`, `runtime`, `patterns`). `ctx.config` is `null` only when there is no file.
- PLAN Unit 3 renames `generate.analytics` → `generate.semantic` in this schema.
