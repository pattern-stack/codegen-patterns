# CFG-1 — the consumer app never parses `codegen.config.yaml`: boot-time config is a generated module

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issue:** #643 (with #647, the EAV import-path fix, as its first commit, and #651, found by this spec's gate)
**Project:** #578
**Depends on:** CFG-0 (#640, one schema + one loader), PATH-0 / PATH-1 (#642, #645: `projectLayout`, `paths.generated`)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility; core + extensions)

## Why

CFG-0 validates `codegen.config.yaml` once, for the generator. Three readers run inside the **consumer's app** and
still `yaml.parse` the file at boot, each with a hand-maintained shape of keys the schema already declares:

| Reader | Keys | Hand-kept shape | On a malformed file |
|---|---|---|---|
| generated `main.ts` (`init-scaffold.ts` › `mainTsContent`) | `openapi.*`, `auth.devAllowAnonymous` | `interface OpenApiConfig`, `interface AuthConfig`, `interface CodegenConfig` | `{}` — Swagger off, auth escape hatch off, silently |
| the block `project upgrade-openapi` patches into `main.ts` | `openapi.*` | inline type literal | throws into a `try` → `console.warn`, Swagger off |
| the block `project upgrade-auth` patches into `main.ts` | `auth.devAllowAnonymous` | inline type literal | boot throws a YAML error |
| `runtime/subsystems/jobs/pool-config.loader.ts` | `jobs.pools` | `UserPoolShape` + hand checks | unknown keys ignored; typos (`concurency`) silently default |

So a value edited after generation is read unvalidated, and a second copy of each shape drifts from the schema.
`config-census.test.ts` ("no second loader") lists these four files as its only exceptions.

## Charter invariants this PR touches

- **I1 declare once.** Every key is declared, defaulted and validated in `CodegenConfigSchema`. No reader in the app
  restates a shape; the jobs pool rules (framework pools, `reserved` is framework-only, a user pool needs `queue` +
  `concurrency`) are stated once, in the runtime, and the schema calls them.
- **I2 generated means regenerated.** The values reach the app through a `@generated` module the generator rewrites;
  editing the YAML without regenerating changes nothing, as for every other key.
- **I7 no backwards compatibility.** `loadPoolConfig`, its cache, `JobWorkerModuleOptions.configPath` and every boot
  YAML parse are deleted — no fallback reader, no deprecation.
- **I9 gates are honest.** The census exception list goes to zero. The smoke boots the app with non-default values in
  both runtime modes and asserts they arrived.

## Decision — per key

Two honest designs exist: **(A)** the generator writes the validated value into generated code, or **(B)** the app
reads the file at boot through the same schema (a published `runtime/config` subpath + a vendored copy). Chosen per
key by what the key is:

| Key | Decision | Why |
|---|---|---|
| `openapi.{enabled,path,title,version,description,auth}` | **(A)** | Document metadata and a mount point. They change with the codebase, not the deployment; the controllers' `@Api*` decorators they describe are generated too. |
| `auth.devAllowAnonymous` | **(A)** | A localhost-only escape hatch. Making it a deploy-time file edit is the opposite of what ADR-043 wants: flipping it should be a visible, committed, regenerated change. |
| `jobs.pools` | **(A)** | Every sibling knob is already generation-time: `jobs.worker_pools` / `all_pools` (pool **names**), `extensions.drizzle.poll_interval_ms`, `stale_*`, `extensions.bullmq.*` are baked into `<generated>/subsystems.ts` and the standalone `worker.ts` by the generator. Pool names also bind generated code (`worker_pools`, the reserved `events_*` lanes the bridge guard checks) and authored `@JobHandler({ pool })` code. A pool map read at boot while its names are baked at generation is two sources for one fact. |

No key is (B), so **no new published subpath**, no runtime dependency of the app on the schema, `zod` or `yaml`.

### The generated module

`<paths.generated>/app-config.ts` (`@generated` banner, rewritten on every regeneration, never hand-edited):

```ts
export const openapiConfig = { enabled: true, path: '/docs', title: 'My App', version: '0.1.0', auth: 'bearer', description: undefined } as const;
export const authConfig = { devAllowAnonymous: false } as const;
export const jobPools = { batch: { concurrency: 8 }, reports: { queue: 'jobs-reports', concurrency: 2 } } as const;
```

- Built by `src/cli/shared/app-config-generator.ts` › `buildAppConfigContent(config)` from the **parsed** config
  (every declared key is emitted, an absent optional one as a bare `undefined`, so the `as const` type always carries
  it — Found 5):
  `openapiConfig` = `OpenApiConfigSchema.parse(config.openapi ?? {})` (the defaults — `enabled: false`, `/docs`,
  `API`, `0.0.0`, `bearer` — move from `main.ts` into the schema), `authConfig` = the parsed `auth` block's
  `devAllowAnonymous`, `jobPools` = `config.jobs.pools ?? {}` (the overrides; the runtime merges them onto the five
  framework pools).
- Written by `project init`, and next to `<generated>/subsystems.ts` by `regenerateSubsystemBarrel` — i.e. on every
  `entity new`, `subsystem install`/`remove`. `subsystem install openapi-config` (config-only, no barrel) and
  `project upgrade-openapi` / `upgrade-auth` write it too.
- A bad value is a `CodegenConfigError` naming the key **at generation** — the CFG-0 loader rejects it before any
  file is written.

### Readers after the change

| Reader | After |
|---|---|
| generated `main.ts` | `import { [authConfig, ]openapiConfig } from '<generated>/app-config'` (`authConfig` only in package mode, where `main.ts` wires the boot-fail check); no `fs`, `path`, `yaml`, no interfaces, no `??` defaults. The app is created with `abortOnError: false` (#651) |
| `upgrade-openapi` block | imports `openapiConfig` (and a static `DocumentBuilder, SwaggerModule`) relative to `layout.mainTs`; no dynamic imports, no `try`/`warn` |
| `upgrade-auth` block | imports `authConfig` the same way — ensured on its own, even when the block is already present — and probes with `resolveUserContext` (#651); patches `abortOnError: false` onto the consumer's `NestFactory.create`; its targets resolve through `projectLayout` (they were hard-coded `src/`, Found 2) |
| jobs runtime | `pool-config.loader.ts` → `pool-config.ts`: pure `resolvePoolConfig(overrides)` + `poolOverrideIssues(overrides)`; `JobsDomainModule.forRoot({ pools })` provides the resolved map under `JOB_POOL_CONFIG`; `JobWorkerModule.forRoot({ domainModulePools })` forwards it to its inner domain module; the worker and the BullMQ orchestrator inject it (`resolvePoolQueueName` loses its `loadPoolConfig()` default) |
| generated `<generated>/subsystems.ts` | `JobsDomainModule.forRoot({ …, pools: jobPools })`, and `domainModulePools: jobPools` on the embedded `JobWorkerModule` |
| standalone `worker.ts` (emit-once) | imports `jobPools` from the generated module and passes `domainModulePools: jobPools` — so pool edits reach it on regeneration although the file itself is never rewritten |
| `CodegenConfigSchema` › `jobs.pools` | `superRefine` with the runtime's `poolOverrideIssues` — one statement of the pool rules, run at generation |

### Deleted

`interface OpenApiConfig`, `interface AuthConfig`, `interface CodegenConfig` and `loadConfig()` in the generated
`main.ts`; the YAML reads in both codemod blocks; `loadPoolConfig`, `UserPoolShape`, `extractUserPools`, the loader
cache and `_resetPoolConfigCacheForTests`; `JobWorkerModuleOptions.configPath`; the `yaml@2` pin in every consumer
smoke's dependency list (its only justification was "main.ts reads codegen.config.yaml").

## Acceptance

1. `config-census.test.ts` › "nothing but the loader locates and parses codegen.config.yaml": the exception list is
   **empty**.
2. Unit: `buildAppConfigContent` emits the schema defaults for a config with no `openapi:` / `auth:` / `jobs:`, and the
   declared values otherwise.
3. Unit: `loadCodegenConfig` rejects, naming the key, `jobs.pools.events_inbound.reserved: false`-style reserved
   flips, `jobs.pools.reports` with no `queue`, a user pool with `reserved: true`, `openapi.auth: basic`,
   `openapi.titel`.
4. Unit: `resolvePoolConfig` merges overrides onto the framework pools; the runtime specs drive pools through
   `JobsDomainModule.forRoot({ pools })` / `JobWorkerModule.forRoot({ domainModulePools })`.
5. Smoke (`test-smoke-junction --layout custom`, vendored **and** package): after the events + jobs installs the
   harness (`test/junction/_helpers.ts` › `writeBootConfig`) sets `openapi: { enabled, path: /reference, title:
   Junction Smoke API, version: 9.9.9 }`, `auth.devAllowAnonymous: true`, `jobs.pools: { batch: { concurrency: 7 },
   reports: { queue: jobs-reports, concurrency: 3 } }` and `jobs.worker_mode: standalone`, and spreads
   `SUBSYSTEM_MODULES` into `AppModule` (Found 6). `verify-boot.ts --expect-pools` asserts the booted app's
   `JOB_POOL_CONFIG` holds both pools; the new `verify-main.ts` runs the generated `main.ts`, fetches
   `/reference-json` and asserts `info.title` / `info.version`, and in package mode (where `main.ts` wires the
   boot-fail check) asserts the process served with the `devAllowAnonymous` warning. In vendored mode `main.ts` reads
   no `auth.*` until `project upgrade-auth` (unit-tested, `project-upgrade-auth.test.ts`).
6. The consumer smokes no longer install `yaml`: the generated app has no YAML dependency.

## Out of scope

- The standalone `worker.ts` is emit-once, so the extension knobs `resolveWorkerForRootOpts` bakes into it
  (`backend`, `listen_notify`, `poll_interval_ms`, `stale_*`, `bullmq.*`) are frozen at first install. Same I2 defect
  class, different keys. Filed: **#652**. (`jobs.pools` is routed around it: `worker.ts` imports `jobPools`.)
  *Revision 2026-09-18 (GEN-0, #652):* closed — `worker.ts` passes `jobWorkerOptions` from `app-config.ts` and holds
  no config value; `resolveWorkerForRootOpts` is deleted (`docs/specs/GEN-0.md`).

## Found

1. **The `jobs:` injector restated the framework pools.** `codegen-config-jobs-block.ejs.t` wrote all five framework
   pools with their `queue` and `reserved`. With the pool rules stated once and run at generation, that block failed
   its own schema (the fixture test caught it). The block now carries a commented `pools:` example and a sentence on
   the rules; the framework pools exist without it.
2. **`project upgrade-auth` ignored `paths.*`.** It patched `src/app.module.ts` / `src/main.ts` and imported
   `./shared/subsystems/auth` regardless of `paths.backend_src` — PATH-0 missed it. It now resolves every target
   through `projectLayout` (the new `authConfig` import needed the layout anyway).
3. **#651 — the generated package-mode `main.ts` could never boot without an `IUserContext`.** Running `main.ts` —
   which no gate had done — showed `installRequesterContext` and the boot-fail check both assumed
   `app.get(AUTH_USER_CONTEXT, { strict: false })` returns `undefined` when unbound. Nest throws
   `UnknownElementException`, and on an HTTP app with the default `abortOnError` its exception-zone proxy turns the
   throw into `process.exit(1)` before any `catch` runs. So `auth.devAllowAnonymous: true` never worked. Fixed in its
   own commit: `resolveUserContext(app)` in the auth runtime (symbol token, catches only the unknown-element error),
   the generated `main.ts` creates the app with `abortOnError: false`, and `project upgrade-auth` patches that option
   onto the consumer's create call. The unit spec's mocked `app.get` (returning `undefined`) is replaced with real
   Nest HTTP apps — `createApplicationContext` does *not* exit on the same lookup, which is why an application-context
   test would also have missed it.
4. **The checkout package smoke runs two `@nestjs/core` copies.** A first `ModuleRef`-based `resolveUserContext` passed
   the unit tests and failed the package leg (`Nest could not find ModuleRef element`): the aliased runtime sources
   resolve Nest from the repo's `node_modules`. Symbol tokens are unaffected, so the probe uses one. Filed: **#653**.
5. **An `as const` literal drops absent optional keys.** With no `openapi.description`, the emitted object had no
   `description` key and `main.ts`'s `openapiConfig.description` failed `tsc` (the smoke caught it). Absent optional
   keys are emitted as a bare `undefined`.
6. **The junction smoke's DI boot never booted a subsystem.** The init-emitted `AppModule` does not spread
   `SUBSYSTEM_MODULES` (that wiring is left to the consumer), so the custom-layout legs' `verify-boot` resolved
   entity modules only. The custom legs now wire it, as `run-smoke-subsystems.ts` does, with `worker_mode:
   standalone` so the boot does no database I/O.
7. **The EAV fix (#647) was wider than filed.** `repository.ejs.t` and `module.ejs.t` carried the same hand-built
   `'../field_values/'` path as the three templates the issue named; all five resolve `field_value` through
   `resolveTargetNaming` now, and the module import uses the field-value entity's own plural
   (`<Plural>Module` from `<plural>.module`). The create/update use cases compute their specifier from their own
   `use-cases/` folder with `relativeModuleDir` (`eavFieldValueUseCaseImportDir`), not by prefixing `../` onto the
   module-level one (review).
8. **App-config regeneration inherits the barrel's warn-only soft-fail.** `regenerateSubsystemBarrel` (which now
   writes `app-config.ts`) is wrapped in `try … printWarning` at `entity.ts` (~708) and `subsystem.ts` (~718, ~899),
   so a failed regeneration exits 0 and can leave the generated `main.ts` / `worker.ts` importing a missing or stale
   module. Behaviour unchanged here (review); filed: **#655**.
9. **`project upgrade-auth` added the `authConfig` import only with the block** (review). A `main.ts` that already
   carried the block but lacked the import stayed broken and was reported `unchanged`. The import is now ensured on
   its own, idempotently, and reported `updated` when it lands (unit-tested).
10. **Deploy-time pool tuning is gone, by decision.** `jobs.pools.<name>.concurrency` is fixed at generation like every
    other `jobs.*` knob. The documented escape route for a deployment that needs an env-derived value is the
    `JobsDomainModule.forRoot({ pools })` seam (`{ ...jobPools, batch: { concurrency: … } }` in the consumer's own
    wiring), checked by `resolvePoolConfig` at boot — recorded in the jobs skill and the consumer jobs skill.

## Gates

Run after the last code edit — the review revision (`fix(#643): review …`); that commit's only change after the run is this table.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass (baseline runner byte-identical) |
| `just test-all` | pass: 3485 unit tests, 0 fail (new: `cli/app-config-generator.test.ts`, `cli/project-upgrade-auth.test.ts`; census list empty); baseline; every smoke — both custom-layout junction legs now assert `JOB_POOL_CONFIG` + run `main.ts` (`/reference-json` → `Junction Smoke API` 9.9.9; package: served with the `devAllowAnonymous` warning); subsystems (vendored + package); capability (both); junction snapshots (10); integration-emit (56); smoke-integration |
| `just test-integration` | pass: 74 pass, 0 fail, 2 skip (the pre-existing `test.skip` pair) |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** (110 × TS2307 + 8 × TS7006, #602) |
| `just test-post-publish` | pass — the schema's import of `runtime/subsystems/jobs/pool-config.ts` resolves from the tarball; the consumer workflow installs no `yaml` |

Two gate runs before this one failed and were fixed in their own commits: the baseline runner invokes the jobs prompt
directly and lacked the new `--appConfigImport` (`3d7673c`); the package subsystems smoke typechecks `worker.ts` in an
isolated copy that lacked the generated `app-config.ts` (`388830b`).
