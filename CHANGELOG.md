# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.4.4] — 2026-04-23

### Fixed

- **`fix(jobs)` #197 — SEVERITY: silent pool-level outage.** `JobWorkerModule` was passing `def.queue` (e.g. `'jobs-crm-sync'`) as the worker's claim-filter pool, but the orchestrator writes the logical `poolName` (e.g. `'crm_sync'`) into `job_run.pool` from `@JobHandler.meta.pool`. As a result, **no job in any stack using `@JobHandler` was ever claimed by a worker** — the claim query never matched a row, zero exceptions were raised, and the pool sat idle. Every consumer of the jobs subsystem since pools-and-queues diverged was affected. Fixed by passing `poolName` as the worker's `pool`. If you ran 0.4.0–0.4.3 with `@JobHandler` handlers: any jobs enqueued in that window are still pending in `job_run` with `status='pending'` and will now claim on next worker tick.
- **`fix(jobs)` #197 — cross-module handler DI scope.** `moduleRef.create(HandlerClass)` only instantiates within `JobWorkerModule`'s scope, so any handler with a cross-module `@Inject` dep (e.g. a sync job injecting a factory from a feature module) crashed at claim time with "not a provider of the current module". The 0.4.3 `ModuleRef` fix was necessary but not sufficient. Switched to `moduleRef.get(HandlerClass, { strict: false })` in both the Drizzle worker and the in-memory orchestrator, which walks the whole DI graph. **New hard requirement**: handler classes MUST be registered as providers in their owning `@Module`. `@JobHandler` registers with the job registry, not with Nest DI — both registrations are required. Documented in `.claude/skills/jobs/handler-authoring.md`.

### Added

- **`feat(events)` #198 — `type: array` payload field.** Closes a silent validation hole. Payloads with list-shaped fields had no well-typed representation; the only option was `type: json`, which emits `Record<string, unknown>` / `z.record(z.unknown())`. At publish time the runtime Zod validator rejected actual arrays, the event was dropped, and downstream `bridge_delivery` rows never landed — with no surfaced error. Now: `type: array` with a required scalar `items:` (`uuid | string | number | boolean | date`) emits `T[]` + `z.array(T)`. Nested arrays / nested json inside an array are deliberately rejected — payloads are a wire format, not an embedded schema. Consumer migration: change any list-shaped payload field from `type: json` to `type: array, items: <scalar>`, re-run `codegen events`, drop any `as unknown as Record<string, unknown>` publish-site casts.

## [0.4.3] — 2026-04-22

### Fixed
- **`fix(jobs)`** — handlers are now instantiated via `ModuleRef` so `@Inject()`-annotated constructor parameters resolve correctly. Applies to both the Drizzle and in-memory job backends. Before this fix, handlers with DI-injected dependencies would fail at runtime because the worker constructed them outside Nest's container. (commits e7348cd, c685a63)
- **`fix(bridge)` #193** — bridge registry codegen is gated on the bridge subsystem being installed (PR #192), and `bridgeHandlersDir` now resolves under `paths.backend_src` instead of hard-coding `src/jobs` (PR #194). Together these close the "stray `src/shared/subsystems/bridge/generated/registry.ts` with broken `../bridge.protocol` import" bug for both the "bridge declared in config but not installed" case and the "installed with non-default backend_src so triggers were never scanned" case.

## [0.4.1] — 2026-04-21

### Added
- **`codegen project upgrade-openapi`** — surgical AST-based codemod that brings an existing consumer `src/app.module.ts` + `src/main.ts` up to the OPENAPI-4 shape `project init` emits on a fresh project. Merges `@nestjs/common` imports, adds `OpenApiModule` (the `@Global()` wrapper around `OPENAPI_REGISTRY`), wires it into `AppModule.imports`, injects the two-pass Swagger bootstrap into `main.ts`, and vendors `src/shared/openapi/*`. Idempotent; `--dry-run` and `--path` supported. Proof-of-concept for issue #188 (additive subsystem install, targeted for 0.5.0).
- **`src/cli/shared/ast-patch.ts`** — ts-morph patching primitives (`ensureImport`, `ensureClassDeclaration`, `ensureModuleImportEntry`, `ensureMainSwaggerBlock`). Each is idempotent and bails cleanly on exotic shapes (factory-based modules, non-array `imports`, missing `@Module()` decorator).

### Changed
- **`project init` skip reasons** — when `app.module.ts` or `main.ts` exist, the skip message now points at `codegen project upgrade-openapi` as the automated path (previously instructed manual wiring only).

### Dependencies
- Added `ts-morph` (runtime dep; CLI-side) for AST manipulation.



### Added
- **Noun-verb CLI** — Clipanion-based CLI replacing the legacy single-file handler. Commands: `entity`, `subsystem`, `project`, `dev`. Each noun has a summary pane with dynamic hints. (ADR-015)
- **UI toolkit** — chalk theme tokens, icons with ASCII fallback, Ora spinners, pane/hints rendering, `--json` mode across all commands. (ADR-016)
- **Barrel files** — `src/generated/modules.ts` and `src/generated/schema.ts` replace app.module.ts injection. Codegen never touches user-authored files. (ADR-017)
- **`codegen init`** — scaffolds a consumer project: codegen.config.yaml, tsconfig path aliases, DatabaseModule, runtime shims, empty barrels, example entity YAML.
- **`codegen dev`** — manages Docker services (Postgres + Redis), starts/stops the NestJS app, shows health dashboard with endpoint probing.
- **Redis event bus** — `EventsModule.forRoot({ backend: 'redis' })` using ioredis Pub/Sub. Optional peer dependency.
- **Declarative query methods on repository** — clean-lite-ps repository template now generates `findByX` methods from the `queries:` block.
- **Smoke test harness** — `just test-smoke` scaffolds a fresh project, generates entities, runs `tsc --noEmit`. Catches template and import regressions.
- **Consumer setup docs** — `docs/CONSUMER-SETUP.md` covering the full wire-up contract: tsconfig aliases, DatabaseModule, runtime shims, barrels.
- **Browser-pilot agent** — Playwright + Chrome DevTools + Lighthouse MCP for endpoint verification and visual QA.
- **Team agents** — architect, builder, coordinator, validator adapted for codegen-patterns workflows.
- **Dev companion commands** — `/dev-check`, `/dev-test`, `/dev-debug` for interactive development with teammate/subagent fallback.
- **Claude Code skill** — `.claude/skills/codegen/SKILL.md` teaches Claude the full CLI reference. Install with `just install-skill <target>`.

### Changed
- **Package renamed** from `@anthropic/codegen` to `@pattern-stack/codegen`.
- **Repo reorganized** — source under `src/`, shipped runtime under `runtime/`, tests under `src/__tests__/`. Root cut from ~17 directories to 5.
- **`output/` renamed to `src/formatters/`** for clarity.
- **`shared/` renamed to `runtime/`** — makes the generator-vs-emitted boundary visible.
- **`generate.cleanLitePs`** replaced by `generate.architecture: 'clean' | 'clean-lite-ps'` enum. No deprecation shim (no existing users).
- **`generate.frontend`** added (default `false`). Scanner flips true when `apps/frontend/` detected.
- **Use case naming** — declarative queries now emit entity-prefixed names (`FindAccountByDomainUseCase`, not `FindByDomainUseCase`). Prevents cross-entity collisions.
- **WithAnalytics mixin** — preserves abstract base class type and method signatures through the mixin chain.
- **`baseQuery()`** uses Drizzle `$dynamic()` for consistent return type. Fixes `.where()` chaining in all family repositories.
- **Subsystem install default path** — `shared/subsystems/` (was `src/shared/subsystems/`).
- **Drizzle backend filter** — `subsystem install --backend drizzle` now keeps memory backend too (needed for tests).

### Fixed
- Clean-lite-ps and clean-architecture templates no longer both emit when one is selected.
- Frontend templates no longer emit when `generate.frontend` is false.
- `app.module.ts` injection removed entirely (replaced by barrels).
- Templates dir resolves correctly when CLI invoked from outside the repo.
- WithAnalytics template import changed from `base-analytics-service` to `with-analytics` (matches runtime filename).
- EJS HTML-escape in declarative query templates — enum union types (`'active' | 'inactive'`) no longer rendered as `&#39;active&#39;`.
- Validator includes `belongs_to` foreign key fields in available-fields set for query validation.
- `MetadataEntityRepository.upsertMany` signature matches base class (conflictTarget now optional).
- `Column` import from drizzle-orm/pg-core changed to `PgColumn` (matches 0.45 exports).
- `prompt.js` config imports fixed after `src/` reorg.

### Removed
- Legacy `src/cli.ts` (25K single-file CLI) — replaced by `src/cli/` noun-verb architecture.
- 11 Hygen inject templates that mutated `app.module.ts` and `schema.ts`.
- Stale docs: `CODEGEN-EVOLUTION-PLAN.md`, `SNAKE_CAMEL_SYNC.md`, `context-engine.md`, `v2-initiative-overview.md`, `contact-module-sketch.md`.
- Empty `tools/` directory.

## [0.2.0] - 2026-04-12

### Added
- Infrastructure subsystems: events, jobs, cache, storage (ADR-008). Protocol → Backend → Factory pattern.
- CRM family renamed to Synced (domain-agnostic).
- Getting Started guide.
- Declarative query codegen from `queries:` YAML block.
- Clean-Lite-PS template pipeline.
- Entity family base classes (synced, activity, metadata, knowledge).
- BaseRepository and BaseService with behavior injection.
- Project scanner for convention detection.

## [0.1.0] - 2026-04-12

Initial release. YAML schema, parser, analyzer, Hygen template pipeline, baseline test infrastructure.
