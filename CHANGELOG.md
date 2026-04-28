# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.6.6] — 2026-04-27

Bundled cleanup PR for the auth subsystem surfaced during integration-patterns review. Pre-1.0, so two breaking renames are taken without compatibility shims.

### Changed

- **BREAKING — env var rename.** `TOKEN_ENCRYPTION_KEY` → `INTEGRATION_TOKEN_ENCRYPTION_KEY`. The auth subsystem only encrypts integration tokens; the scoped name is clearer about what the key protects and avoids colliding with other token-encryption keys a consumer might own. Read site (`runtime/subsystems/auth/backends/encryption-key/env.ts`), install template (`templates/subsystem/auth/env-config.ejs.t` + idempotency `skip_if`), CLI scaffold helpers, tests, and docs all moved together. Consumers running 0.6.5 must rename the env var and the `skip_if` line in their generated `.env.config`.
- **BREAKING — interface rename.** `ProviderStrategy` → `IProviderStrategy` to match the rest of the auth port naming (`IIntegrationReader`, `IUserContext`, `IOAuthStateStore`, `IEncryptionKey`). Convention documented at the top of `runtime/subsystems/auth/protocols/provider-strategy.ts`: `I*` for behavioral ports, no prefix for data DTOs / template-method abstract classes. `ProviderStrategyRegistry` (a `ReadonlyMap` value-shape) keeps its name.
- **OSS-hygiene scrub.** Removed or generalized references to the upstream extraction-source consumer across `runtime/`, `examples/`, and user-facing docs. ADRs and RFCs that document decision history retain their references intentionally.



Auth subsystem reaches consumers. `runtime/subsystems/auth/`, the `auth-integrations` starter, and the `cdp subsystem install auth` + `auth-integrations` templates were all merged on `main` (PRs #289, #290, #292, #293, #294, #295) but the published artifact was still pinned at `0.6.4`. This release ships them.

### Added

- **`feat(auth)` #289** — provider-agnostic `AuthController` mounting `GET /auth/:provider/connect` and `GET /auth/:provider/callback`, plus the `IUserContext` / `IOAuthStateStore` / `IIntegrationGrantSink` ports and memory + drizzle state-store backends. `OAuth2RefreshStrategy` extracted as a template-method base class. See `runtime/subsystems/auth/`.
- **`feat(examples)` #290** — `examples/auth-integrations/` starter: canonical `integration.yaml` entity + adapters that satisfy the three `AUTH_INTEGRATION_*` ports + `IntegrationsService` facade.
- **`feat(cdp)` #293** — `cdp subsystem install auth` and `cdp subsystem install auth-integrations` templates. The auth template emits `auth_oauth_state` drizzle schema, appends `TOKEN_ENCRYPTION_KEY` + `AUTH_REDIRECT_URI_BASE` to `.env.config`, and drops a TODO into `app.module.ts`. `auth-integrations` vendors the starter under `apps/api/src/shared/integrations/`.

## [0.6.4] — 2026-04-27

Two consumer-DX fixes surfaced by a fresh `cdp project init` run.

### Fixed

- **`fix(init)` #277** — typed the empty `GENERATED_MODULES` barrel emitted by `cdp project init`. The scaffold previously emitted `export const GENERATED_MODULES: unknown[] = []`, which fails `tsc --noEmit` against the scaffolded `app.module.ts` (`...GENERATED_MODULES` spread doesn't satisfy NestJS's `imports:` type) on day one of any new consumer project. Now typed as `Array<Type | DynamicModule | Promise<DynamicModule> | ForwardReference>`. Entity-populated barrels remain unaffected — class refs already satisfy `Type`.

### Changed

- **`fix(bin)` #277** — added `codegen` as the primary bin name in `package.json`. The previous bin name `cdp` collides with an unrelated published npm package, so `bunx cdp ...` (without a local install) silently fetches and runs the wrong package. The CLI banner, README, and downstream docs all already refer to the binary as `codegen`. `cdp` is preserved as an alias for backwards compatibility.

## [0.6.3] — 2026-04-26

### Fixed

- **`fix(publish)`** — remove stray `"private": true` field introduced incidentally in `0.6.2` (PR #273). `0.6.2` could not be published to npm (`EPRIVATE` error from `npm publish`). `0.6.3` is functionally identical to `0.6.2` plus the manifest fix.

## [0.6.2] — 2026-04-26

Critical hotfix for #272 + #269. `0.6.1` shipped with a tarball-only failure mode: `cdp entity` died with `Unknown Syntax Error: Extraneous positional argument ("entity")` because the entity noun silently failed to register. The actual cause was hidden by a bare `try { ... } catch {}` in `loadNouns()` swallowing the import error.

### Fixed

- **`fix(release)` #272** — root cause: `typescript` was declared in `devDependencies` but `import ts from 'typescript'` runs at module init from `src/cli/shared/bridge-registry-generator.ts` and `src/cli/commands/events.ts`. tsup externalizes `dependencies` / `peerDependencies` only — devDeps get inlined into `dist/src/cli/index.js`. The CJS `typescript` package then triggers `Dynamic require of "fs" is not supported` when its body runs inside the ESM bundle, killing the entity-noun import. The repo's source-checkout smoke (`just test-smoke`) doesn't catch this because it runs against `src/`, not the bundled tarball, where `typescript` resolves through Node's normal module loader. Fix: move `typescript` to `dependencies`. ts-morph already depended on it transitively; this just makes the direct import path correct.
- **`fix(cli)` #269** — `loadNouns()`'s per-noun `try { ... } catch {}` blocks silently dropped any noun whose import failed, so #272 surfaced as a cryptic "extraneous argument" error from clipanion instead of the real `Dynamic require of "fs"` ImportError. Replaced the dynamic-import + try/catch loader with static top-of-file imports and a flat `nouns` array. Static imports fail loudly at module-init with the real error; there is nothing left to catch. The defensive try/catch was a phase-transition artefact (intent: "skip unimplemented nouns") with no remaining purpose — every noun is now implemented and required.

### Prevention

The post-publish smoke (#190 / PR #271) catches this regression class: it packs the tarball, installs into a fresh tmp project, and exercises `cdp entity new --all` end-to-end. Once that lands on `main`, any future devDep-vs-bundle drift will fail CI on the publish path rather than on first npm-install by a downstream consumer.

## [0.6.1] — 2026-04-26

Critical hotfix for #266. `0.6.0` shipped with a broken `entity new` command for every npm consumer: `templates/entity/new/prompt.js` and `templates/entity/new/clean-lite-ps/prompt-extension.js` import runtime helpers from `../../../src/config/*.mjs` and `../../../src/patterns/registry.js`, but the `package.json:files` manifest excluded `src/`. Every published-tarball invocation died with `ResolveMessage: Cannot find module '../../../src/config/paths.mjs'`. The repo's smoke + baseline tests didn't catch this because they run from the source checkout, where the relative paths resolve directly.

### Fixed

- **`fix(release)` #266** — extend `package.json:files` with the narrow set of `src/` paths that templates reach for at runtime: `src/config/*.mjs`, `src/schema/naming-config.schema.mjs`, `src/patterns/registry.ts`, `src/patterns/pattern-definition.ts`, `src/patterns/library/*.ts`. Narrow paths (not a broad `src/` entry) so test files and CLI source stay out of the tarball. Verified by `npm pack && npm install ./pack.tgz && entity new` against a real fixture entity — generation now succeeds end-to-end.

### Added

- **Prevention test** at `src/__tests__/templates/files-manifest-coverage.test.ts`: statically scans every `templates/**/*.{js,mjs,cjs}` for relative imports that escape the `templates/` tree, resolves each against the source layout (with `.js → .ts` rewrite for Bun TS-aware ESM), and asserts the resolved path matches at least one entry in `package.json:files`. Fails CI when a future template adds a cross-package import without updating the manifest. Closes the hole identified in #190 (post-publish smoke proposal).

## [0.6.0] — 2026-04-26

Sync subsystem Phase 2: configurable change sources land. Detection mode is now declarative — entity YAML carries a `detection:` block parsed into a typed `DetectionConfig`, and codegen emits a per-entity Map factory module that wires consumer-supplied adapter callbacks to the right primitive. Plus audit-tier event classification (epic #242 phases 1–4).

### Added — sync configurable change sources (epic #226 / ADR-033)

- **`feat(sync)` #234 (#226-1)** — `DetectionConfigSchema` (Zod) at `runtime/subsystems/sync/detection-config.schema.ts`: discriminated union over `mode: 'poll' | 'webhook'`; flat-AND `ResolvedFilter` triples (`eq | neq | in | nin | gt | gte | lt | lte`); `CursorStrategy` tagged union (`systemModstamp | replayId | timestamp | eventId`); `poll.provenance: 'cdc'` knob for Stripe-style cursor-based event endpoints. Single source of truth for filter/mapping/cursor shape across the subsystem. ADR-033 locked. (`fced3e0`)
- **`feat(sync)` #237 (#226-3)** — `PollChangeSource<T>` poll-mode primitive parameterized by parsed `DetectionConfig` + `PollFetchCallback<T>`. Owns filter resolution, field-mapping → `externalId`, middleware composition, `Change<T>.source` provenance. (`2ba968e`)
- **`feat(sync)` #238 (#226-4)** — `WebhookChangeSource<T>` webhook-mode primitive: stamps `Change<T>.source = 'webhook'`, populates `dedupKey` from `webhook.eventIdField`. Passive iterator (does not drive the orchestrator). Inbound staging schema stays consumer-owned per ADR-002 §Phase 4. (`86f252b`)
- **`feat(sync)` #239 (#226-5)** — `createLoopbackMiddleware(store)` factory: loopback fingerprint suppression now ships as a stock `ChangeMiddleware<T>` consumers compose into a primitive's middleware chain. Orchestrator's `@Optional() SYNC_LOOPBACK_FINGERPRINT_STORE` branch deleted. (`f099269`)
- **`feat(schema)` #236 (#226-6)** — entity-YAML `detection:` block validated against `DetectionConfigSchema` at `pts codegen entity validate`. (`7fb27d9`)

### Added — provider-keyed detection (RFC #241 / ADR-033.1 + ADR-033.2)

- **`feat(schema)` #255 (ADR-033.1 a)** — `detection: z.record(z.string(), DetectionConfigSchema)`. Provider name is structure (the YAML key), not a new schema field. Within-file `superRefine` cross-checks every `detection:` key exists under `sync.providers:`. Multi-provider entities (HubSpot + Salesforce on the same canonical entity) are now first-class. (`d58d0e3`)
- **`feat(sync)` #256 (ADR-033.1 b)** — `buildChangeSource()` runtime factory: switches on `cfg.mode` to instantiate `PollChangeSource<T>` or `WebhookChangeSource<T>`, threads middlewares. Hides per-mode option-bag asymmetry (`adapter` vs `queue`) behind a single `fetch` callback parameter. Barrel-exported. (`5485922`)
- **`feat(codegen)` #259 (ADR-033.1 c + ADR-033.2)** — per-entity `<entity>-sync-source.module.ts` factory module: emits `<ENTITY>_DETECTION_CONFIGS` (private const) + `<ENTITY>_POLL_FETCH_REGISTRY` (consumer fills) + `<ENTITY>_CHANGE_SOURCES: ReadonlyMap<string, IChangeSource<T>>` (factory output). One module per entity regardless of provider count; no per-provider symbols. Also emits sibling `<entity>-sync-source.providers.ts` with `as const` tuple + `<EntityName>Provider` literal-union type for compile-time consumer registry checks. Drops `isCleanArchitecture` gate so the template emits in `clean-lite-ps` too. (`43a30ae`)
- **ADRs locked** (PR #249): `docs/adrs/ADR-033.1-provider-keyed-detection.md` (Accepted), `docs/adrs/ADR-033.2-typed-provider-artifacts.md` (Accepted), `docs/adrs/ADR-034-provider-registry.md` (Draft — placeholder for project-wide provider registry; tightens 033.1 validation when consumed). (`dfa90cd`)

### Added — audit-tier event classification (epic #242 phases 1–4)

- **`feat(events)` #219** — `tier` as a first-class event classification (`audit | domain | analytics`); foundation for downstream routing decisions. (`ad648df`)
- **`feat(events)` #258 (#244)** — `tier` column on event tables + CHECK constraint + Zod lock. Schema-level enforcement that every published event carries an explicit tier. (`14740b1`)
- **`feat(events)` #262 (#245)** — codegen emits `tier`; codegen errors on `audit` events used as bridge triggers (audit-tier is bridge-inert by design). (`9685021`)
- **`feat(events)` #263 (#246)** — `TypedEventBus` stamps `tier` on publish; audit-tier routing forced to `null` (no bridge delivery). (`160c8a1`)
- **`feat(bridge)` #264 (#247)** — bridge `processEvent` short-circuits on `tier === 'audit'` at the top of the handler, before any work. (`369dfaf`)

### Changed — breaking

- **`feat(sync)!` #235 (#226-2)** — `IChangeSource<T>.listChanges` signature is now `(subscription, cursor)` (cursor passed by value at the port seam, ADR-033). Every in-tree adapter and test fake updated. Downstream consumers must update their adapter shells. (`663b621`)
- **`feat(sync)!` #239 (#226-5)** — `SYNC_LOOPBACK_FINGERPRINT_STORE` no longer a top-level orchestrator binding. Consumers using the orchestrator-side loopback path migrate to `createLoopbackMiddleware(store)` composed into their primitive's middleware chain. Migration documented in `docs/guides/sync-migration.md`. (`f099269`)

### Docs

- `.claude/skills/sync/SKILL.md` — Phase 2 gating sentence flipped to "PollChangeSource emission shipped (provider-keyed); webhook + streaming deferred"; new factory + middleware files added to runtime snapshot.
- `docs/CONSUMER-SETUP.md#sync-subsystem` — "Detection block — provider-keyed codegen factory module" walkthrough added.
- `docs/guides/sync-migration.md` — "Migrating from a hand-authored `IChangeSource` to a provider-keyed `detection:` block" appended.

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
