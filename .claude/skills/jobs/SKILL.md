---
name: jobs
description: Load when working on the jobs subsystem in this repo. Triggers include changes under `packages/jobs/` (`@pattern-stack/jobs`: the engine, stores, executors, the Nest layer), `runtime/subsystems/jobs/` (`JobsEngineModule`, `JobStarter`, `tenantRunScope`, job factories), the job registry and YAML-job emitters (`src/cli/shared/job-registry-generator.ts`, `job-emission-generator.ts`, `emit-jobs.ts`), the `jobs:` config schema, `templates/subsystem/jobs*/`, the bridge's drain hook starting runs, and any work referencing JOBS-3.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Jobs (JOBS-3: `@pattern-stack/jobs`)

Generated apps run jobs on `@pattern-stack/jobs`, a workspace package in `packages/jobs/`. ADR-022's subsystem (`@JobHandler`, orchestrator, `job_run` tables, `JobWorkerModule`) is gone.

**Read first:** `docs/specs/JOBS-3.md` (decisions, the renamed-names table, "As built"), then
`packages/jobs/JOBS_CONTRACT.md` (the engine's contract) and
`packages/jobs/AGENTS.md`. The app upgrade is `docs/MIGRATION-jobs-engine.md`.

## Where things are

| Concern | Where |
|---|---|
| Engine, `defineJob`, `jobFactory`, stores, executors | `packages/jobs/src/` (`define/`, `engine/`, `adapters/`, `postgres/`, `bullmq/`, `nest/`) |
| The job tables (owned by the package) | `packages/jobs/src/postgres/tables.ts` (`timestamptz(3)`, text tenant) |
| The Nest host in a generated app | `runtime/subsystems/jobs/jobs-engine.module.ts` (`JobsEngineModule.forRoot`) |
| Starting runs (app code, bridge, facade) | `runtime/subsystems/jobs/job-starter.ts` (`JobStarter.start(key, input, opts, tx?)`) |
| Job factories | `packages/jobs/src/define/job-factory.ts` (core: `jobFactory`, `buildJobs`, `assertResolvable`); the Nest binding in `packages/jobs/src/nest/jobs.module.ts` |
| Steps in the run's tenant | `runtime/subsystems/jobs/tenant-run-scope.ts` |
| The generated registry | `src/cli/shared/job-registry-generator.ts` → `<generated>/jobs.ts` |
| YAML jobs (RFC-0005) | `src/cli/shared/job-emission-generator.ts`, `emit-jobs.ts`, `src/schema/job-definition.schema.ts` |
| Config | `JobsConfigSchema` in `src/schema/codegen-config.schema.ts`; `app-config-generator.ts` (`jobLimiters`, `jobsInProcessOptions`) |
| Barrel line | `subsystem-barrel-generator.ts` (`jobs` composer) |
| Bridge start | `runtime/subsystems/bridge/bridge-outbox-drain-hook.ts` |

## Gates

- `just test-jobs` — the package's own tests, its typecheck with tests, and its build (in `test-all`).
- `just test-jobs-integration` — `storeContract` and the executor's cases on real Postgres (Docker; CI's integration
  job).
- `just typecheck` builds the package first: codegen's runtime type-checks against its built declarations.
- `src/__tests__/runtime/subsystems/job-factories.spec.ts` — a YAML job arm reaching `ExecuteIntegrationUseCase`
  through the real `JobsEngineModule`.
- The smokes install the package from a packed tarball (`addJobsPackage`, `test/smoke/_package-runtime.ts`).

## Rules

- The package stays framework-free outside `./nest`, `./postgres`, `./bullmq`, `./redis` (`fences.test.ts`).
- A job with dependencies is a `jobFactory` (framework-free); Nest resolves its deps through `ModuleRef`, plain
  wiring calls `create(deps)`. `create` never reads a dependency while building the job.
- The bridge's exactly-once is its transaction and the `bridge_delivery` UNIQUE key, never a dedupe key or window.
- A removed config key is declared as removed (`removedJobsKey`), naming itself and the migration note.

## Under `target.wiring: pattern-stack` (J-1)

The same engine without Nest: `runtime/subsystems/jobs/core.ts` (`createJobsEngine`, `JobRunStarter`; `JobStarter` is the
Nest subclass), `@pattern-stack/jobs/host` (the framework-free host parts the package's Nest layer wraps), and the
composition's `jobs` system and `jobDeps` module (`src/emitters/composition/emit-composition.ts`). A factory's
dependencies are composition parts provided typed per factory. Every choice made from a config value is a table read
through `rowFor`. Spec: `docs/specs/J-1.md`.
