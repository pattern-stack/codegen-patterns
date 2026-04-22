# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
