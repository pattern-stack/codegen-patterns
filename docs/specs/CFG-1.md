# CFG-1 — the consumer app never parses `codegen.config.yaml`: boot-time config is a generated module

**Status:** Draft
**Date:** 2026-09-18
**Issue:** #643 (with #647, the EAV import-path fix, as its first commit)
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
export const openapiConfig = { enabled: true, path: '/docs', title: 'My App', version: '0.1.0', description: '…', auth: 'bearer' } as const;
export const authConfig = { devAllowAnonymous: false } as const;
export const jobPools = { batch: { concurrency: 8 }, reports: { queue: 'jobs-reports', concurrency: 2 } } as const;
```

- Built by `src/cli/shared/app-config-generator.ts` › `buildAppConfigContent(config)` from the **parsed** config:
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
| generated `main.ts` | `import { authConfig, openapiConfig } from '<generated>/app-config'`; no `fs`, `path`, `yaml`, no interfaces, no `??` defaults |
| `upgrade-openapi` block | imports `openapiConfig` from the generated module (relative to `layout.mainTs`); no `try`/`warn` |
| `upgrade-auth` block | imports `authConfig` the same way; its targets resolve through `projectLayout` (they were hard-coded `src/`) |
| jobs runtime | `pool-config.loader.ts` → `pool-config.ts`: pure `resolvePoolConfig(overrides)` + `poolOverrideIssues(overrides)`; `JobsDomainModule.forRoot({ pools })` provides the resolved map under `JOB_POOL_CONFIG`; `JobWorkerModule.forRoot({ domainModulePools })` forwards it to its inner domain module; the worker and the BullMQ orchestrator inject it (`resolvePoolQueueName` loses its `loadPoolConfig()` default) |
| generated `<generated>/subsystems.ts` | `JobsDomainModule.forRoot({ …, pools: jobPools })`, and `domainModulePools: jobPools` on the embedded `JobWorkerModule` |
| standalone `worker.ts` (emit-once) | imports `jobPools` from the generated module and passes `domainModulePools: jobPools` — so pool edits reach it on regeneration although the file itself is never rewritten |
| `CodegenConfigSchema` › `jobs.pools` | `superRefine` with the runtime's `poolOverrideIssues` — one statement of the pool rules, run at generation |

### Deleted

`interface OpenApiConfig`, `interface AuthConfig`, `interface CodegenConfig` and `loadConfig()` in the generated
`main.ts`; the YAML reads in both codemod blocks; `loadPoolConfig`, `UserPoolShape`, `extractUserPools`, the loader
cache and `_resetPoolConfigCacheForTests`; `JobWorkerModuleOptions.configPath`; the `yaml@2` smoke pin's
justification ("main.ts reads codegen.config.yaml").

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
5. Smoke (`test-smoke-junction --layout custom`, vendored **and** package): the config carries non-default `openapi.*`,
   `auth.devAllowAnonymous: true` and `jobs.pools`; `verify-boot.ts` asserts the booted app's `JOB_POOL_CONFIG` holds
   them, and a new `verify-main.ts` runs the generated `main.ts` over HTTP and asserts `/<path>-json` carries the
   configured title/version (and, in package mode where `main.ts` wires the boot-fail check, that it served with the
   `devAllowAnonymous` warning instead of refusing to boot).

## Out of scope

- The standalone `worker.ts` is emit-once, so the extension knobs `resolveWorkerForRootOpts` bakes into it
  (`listen_notify`, `poll_interval_ms`, `bullmq.*`) are frozen at first install. Same I2 defect class as this issue,
  different key set — filed separately (see Found).

## Found

_(filled in during implementation)_

## Gates

_(filled in after the last edit)_
