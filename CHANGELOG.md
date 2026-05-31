# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.12.2] — 2026-05-31

Track D consumer-CLI fix. The 0.12.0/0.12.1 generator was correct in the
hermetic D7 path but broke for real consumers driving it through the CLI. Two
schema/loader bugs plus a DX gap that masked the first. No swe-brain YAML change
is required — consumer YAML already wrote the keys in the natural place; the
schema is now corrected to match.

### Fixed

- **`entity.surface` / `entity.context` schema level.** `surface:` and
  `context:` were defined at the ROOT of `EntityDefinitionSchema` (sibling of
  `entity:`/`fields:`), but consumers naturally write them INSIDE the `entity:`
  block (next to `pattern:`/`name:`/`table:`). Because the `entity:` block is
  `.strict()`, those YAMLs were rejected with "Unrecognized key(s) in object:
  'surface' at 'entity'". The fields now live in `EntityConfigSchema` and are
  read as `entity.surface` / `entity.context`. Clean break — root-level
  placement no longer validates. Read sites updated:
  `collectEntitySurfaces` (`validate-providers.ts`), `collectEntitiesBySurface`
  (`adapter-emission-generator.ts`), the provider surface cross-check
  (`entity.ts`), and the clean-lite-ps output-subfolder consumer
  (`prompt-extension.js` `buildCleanLitePsLocals`).
- **Entity `--all` discovery no longer globs `definitions/providers/`.** With
  `entities_dir: definitions`, the recursive YAML walk pulled provider files
  into the entity loader, where they fail entity validation. Entity discovery
  (`findYamlFiles`, `loadEntities`, `listEntityYamls`) now excludes the
  configured providers dir (`paths.providers`, default `definitions/providers`).
  Provider files route only through `ProviderDefinitionSchema`.

### Changed

- **`entity new --dry-run` surfaces the Zod detail.** The failure path printed
  only "Validation failed for <file>"; it now emits the same per-issue Zod
  diagnostics as `entity validate`, so a misplaced key reports which key/level
  is wrong (the DX gap that hid the `entity.surface` rejection).

## [0.12.1] — 2026-05-31

Track D (provider/adapter integration codegen) discoverability fix. The 0.12.0
generator wiring is correct and shipped — provider + adapter emission runs as a
post-step of `codegen entity new` whenever `definitions/providers/*.yaml` exist
— but nothing in the CLI surfaced that, so consumers searched `--help` for a
`provider` / `integration` / `gen` command, found none, and mistook a working
feature for a publish gap. Docs-and-help only; no generator behavior changed.

### Changed

- **`codegen entity new --help`** now documents every post-generation step it
  runs (event / bridge / orchestration / **provider + adapter (Track D)**
  codegen), including Track D's trigger (`definitions/providers/*.yaml`), output
  paths (`<backendSrc>/integrations/{providers,}`), emit-once semantics, and an
  explicit note that there is no standalone `provider` / `integration` / `gen`
  command — Track D is driven entirely by re-running `entity new`.
- **`codegen entity` summary hints** now surface a Track D regen hint when the
  project has a providers directory — a discoverability path that does not
  require reading `entity new --help`.
- **Integration domain skill** (`protocols-and-ports.md`, `SKILL.md`) documents
  the Track D invocation, the skip-when-no-providers-dir behavior, and that the
  generated scaffold (not the `.d.ts`) is ground truth for adapter port shape.

## [0.12.0] — 2026-05-31

Integration codegen retarget (RFC-0001): a **provider/adapter/surface** model
for integration codegen, plus a **surface-package framework**. Additive over
0.11.0 — new declarative inputs and emitted artifacts; existing entity codegen
is unchanged. The one breaking item (the ADR-033.2 per-entity provider tuples)
has no consumers. Consumers adopt by adding `definitions/providers/*.yaml` and
regenerating. Ships alongside four independently-versioned **surface packages**
(`@pattern-stack/codegen-{crm,calendar,mail,transcript}`) at `0.1.1`. (Their
initial `0.1.0` release peer-depended on `@pattern-stack/codegen` `^0.11.0`,
which predates the `./subsystems` export they require; `0.1.1` corrects the peer
to `^0.12.0`. The peer source fix merged with 0.12.0 but the version bump was
missed — this completes it.)

### ⚠ BREAKING CHANGES

- **ADR-033.2 per-entity provider tuples removed.** The
  `<entity>-integration-source.providers.ts` emission (`<ENTITY>_PROVIDERS`
  const + `<Entity>Provider` type) is deleted. Its replacement is the
  surface-scoped, codegen-owned typed view at
  `src/integrations/<surface>/types.generated.ts` (`<Surface>Provider` /
  `<Surface>Entity` unions + a `(provider, entity)` validity map) — a single
  source of provider truth. ADR-033.2 is superseded by RFC-0001. No published
  consumers depend on the tuples.

### Added

- **Track C — surface-package framework (ADR-036).** First-class L2 *surface
  packages* shipping type-shaped ports + DI tokens + an L3 composing port per
  integration surface:
  - **L1** — `IEntityChangeSourceRegistry` (entity-keyed change-source
    resolver) + `MemoryEntityChangeSourceRegistry` + the
    `ENTITY_CHANGE_SOURCE_REGISTRY` token, in the integration subsystem;
    exported across the package boundary via `@pattern-stack/codegen/subsystems`.
  - **`@pattern-stack/codegen-crm`** — L2 CRM ports (`IFieldDefinitionReader`,
    `IPicklistReader`, `IAssociationReader`), the `CrmCapabilities` descriptor,
    and the L3 entity-agnostic **`CrmPort`** composing port + `assertCrmAdapter`
    conformance helper (on the `/testing` subpath).
  - **`@pattern-stack/codegen-{calendar,mail,transcript}`** — incremental-read
    interaction surfaces (`CalendarPort` / `MailPort` / `TranscriptPort`,
    canonical types, capability descriptors). Independently versioned (`0.1.1`).
- **Track D — provider/adapter integration codegen (RFC-0001).**
  - `definitions/providers/<provider>.yaml` — providers as first-class
    declarative artifacts (slug, auth strategy, client, surfaces); Zod schema +
    validator with a **pre-flight import-path check** (a missing
    strategy/client export fails `cdp gen`, not NestJS boot), surface
    cross-check, and slug-uniqueness.
  - Emits, per provider × surface: a `<provider>.provider.module.ts`, an
    **emit-once** `<provider>-<surface>.adapter.ts` scaffold (sentinel-guarded,
    author-owned after first emit), fully codegen-owned adapter modules +
    barrels, a per-surface registry (`<SURFACE>_ADAPTER_CONTRIBUTIONS` →
    `<SURFACE>_ENTITY_SOURCES`, folding into the L1 registry), and the
    `types.generated.ts` typed view.
  - Optional entity-YAML **`surface:`** field — the declarative input the
    provider/adapter emission groups entities by.
- **`context:` output-folder grouping (#403).** An optional top-level entity
  `context:` nests its generated module folder under that segment
  (`<modules>/<context>/<plural>/`); no context → flat (byte-identical to
  before).
- **Multi-package release.** `just publish` publishes the root plus every
  opted-in `packages/*` (those declaring `publishConfig.access: public`) at its
  own independent version, skipping versions already on npm.

## [0.11.0] — 2026-05-30

Vocabulary rename per **ADR-0005 (swe-brain `.ai-docs/decisions/ADR-0005-rename-sync-to-integration.md`)**:
the data-movement domain `sync` → `integration` (reserving "sync" for
ElectricSQL-style replication), the `Synced` entity family → `Integrated`, and
the authenticated vendor-link `IntegrationStore` → `ConnectionStore`. This is a
clean break — there are no compat shims or deprecated aliases; consumers
migrate by **regenerating** off the renamed substrate (codegen owns the
physical/structural names).

### ⚠ BREAKING CHANGES

- **Integration engine (`sync` → `integration`).**
  - `SyncModule` → `IntegrationModule` (`.forRoot({ backend, multiTenant? })`);
    `ExecuteSyncUseCase` → `ExecuteIntegrationUseCase`.
  - Tokens `SYNC_*` → `INTEGRATION_*` (cursor store, run recorder, field
    differ, change source, sink, multi-tenant flag, module options).
  - Protocols/ports/recorders/cursor-stores/errors `sync-*` → `integration-*`;
    `runtime/subsystems/sync/**` → `runtime/subsystems/integration/**`.
  - Tables `sync_runs` / `sync_run_items` / `sync_subscriptions` →
    `integration_runs` / `integration_run_items` / `integration_subscriptions`;
    cursor column `last_sync_at` → `last_integration_at`.
  - Entity-YAML config block `sync:` → `integration:` (incl. `sync.inbound` →
    `integration.inbound`); the per-entity `*-sync-source.module.ts` codegen
    output → `*-integration-source.module.ts`.
  - CLI: `codegen subsystem install sync` → `… install integration`; the
    `/sync` skill → `/integration`.
- **`Synced` entity family → `Integrated`.**
  - `SyncedEntityRepository` / `SyncedEntityService` → `IntegratedEntityRepository`
    / `IntegratedEntityService`; `SyncUpsertConfig` → `IntegrationUpsertConfig`;
    `syncUpsertOne`/`syncUpsert`/`syncConfig`/`SyncFkResolver` →
    `integrationUpsertOne`/`integrationUpsert`/`integrationConfig`/`IntegrationFkResolver`;
    `junction-sync-repository.ts` → `junction-integration-repository.ts`.
  - YAML `pattern: Synced` → `pattern: Integrated`.
- **Auth vendor-link `integration` → `connection`.**
  - `IntegrationStore` ports → `ConnectionStore`:
    `IIntegrationReader`/`IIntegrationTokenWriter`/`IIntegrationGrantSink` →
    `IConnection*`; `DecryptedIntegration` → `DecryptedConnection`;
    `IntegrationGrantInput`/`IntegrationTokenUpdate` → `Connection*`;
    `IntegrationBrokenError` → `ConnectionBrokenError`; DI tokens
    `AUTH_INTEGRATION_*` → `AUTH_CONNECTION_*`.
  - Engine FK `integration_subscriptions.integration_id` → `connection_id`
    (the column references the connected account/instance — a *connection*;
    the table name stays `integration_subscriptions`).
  - The `examples/auth-integrations` starter is fully renamed to the connection
    vocabulary: `connection.yaml` entity (table `connections`),
    `ConnectionsService`, `ConnectionsAuthModule`, `Connection*Adapter`,
    vendored under `<modules>/connections/`. The `auth-integrations` subsystem
    **install command** keeps its name.

### Preserved (NOT renamed)

- The CLI imperative **verb** `sync` in app-level event names
  (`crm_sync_started`, `webhook_outbound_contact_sync`).
- ElectricSQL `frontend.sync` collection config (replication sense).

### Migration

No shims. Re-vendor the runtime (`codegen update`) and **regenerate** entities/
subsystems off the renamed names; update app code that references the renamed
symbols/tokens/tables/config keys. See ADR-0005 (swe-brain `.ai-docs/decisions/ADR-0005-rename-sync-to-integration.md`).

## [0.10.1] — 2026-05-28

Dogfood fixes found wiring `@pattern-stack/codegen@0.10.0` into a second
consumer (swe-brain): the type-check blockers that forced consumers to exclude
the vendored subsystem tree from `tsc` are gone. A drizzle-only install now
type-checks its full tree (`src/shared/subsystems/**` included) with no
`ioredis`/`bullmq` peer deps.

### Fixed

- **`fix(subsystems)` — detection + barrel emission key on `<name>.module.ts`
  (#4, #2).** Installing one subsystem can vendor *protocol stubs* of another
  (e.g. events vendors `bridge/bridge.protocol.ts`); detection used to report
  those stub-only dirs as `installed` and the barrel emitted a phantom
  `BridgeModule` import for a module that was never installed (TS2307).
  Detection now requires the module file; `subsystem list` reports `incomplete`
  for stub-only dirs; the barrel skips them.
- **`fix(events)` — drizzle backend type-checks against its paired schema
  (#3).** `event-bus.drizzle-backend.ts` read a `tier` column the schema never
  emitted and `tenant_id` columns only present under multi-tenancy. `tier` is
  now always emitted; `tenant_id` access is gated behind `multiTenant`, so the
  backend type-checks under any configuration.
- **`fix(subsystems)` — installs no longer vendor unselected backends (#6).** A
  `--backend drizzle` install previously vendored the Redis and BullMQ backend
  sources too, dragging `ioredis`/`bullmq` (uninstalled optional peers) into the
  consumer's type-check. The copy filter now prunes `*.redis-backend.ts` /
  `*.bullmq-backend.ts` for non-matching installs; modules lazy-load the chosen
  backend via a non-literal dynamic import; backend-specific classes are no
  longer re-exported from the public barrels; `bullmq.config.ts` is kept on
  every install (peer-dep-free) for its static token references; the BullMQ
  backend is `noImplicitAny`-clean.
- **`fix(barrel)` — empty-composer output emits the `DynamicModule` import.** A
  generated `subsystems.ts` with no composer calls referenced `DynamicModule`
  without importing it (latent since BULLMQ-1, surfaced by the stricter
  detection above).

### Added

- **`feat(cli)` — `codegen subsystem remove` (#5, #7).** Real implementation:
  deletes the vendored subsystem dir, regenerates the barrel, git-safety gated
  with `--force`, and `--yes`/`-y` parity with `install`. Prints the manual
  follow-ups it deliberately does *not* perform (config-block strip,
  `forRoot` un-registration).
- **`test(smoke)` — `run-smoke-subsystems.ts`.** Exercises an events + jobs +
  bridge drizzle install with a full-tree `tsc` (no subsystem excludes) + a
  programmatic NestJS boot that validates the bridge reserved-pool dependency
  graph. Wired into `just test-all`.

## [0.10.0] — 2026-05-27

### Added

- **`feat(cli)` — consumer skill distribution (ADR-035).** A curated
  `consumer-skills/` set (a `codegen` router plus `entities`, `subsystems`,
  `jobs`, `events`, `bridge`, `sync`) is vendored into a consumer's
  `.claude/skills/` via a new `skills` noun (`codegen skills install` / `list`),
  and by `codegen init` by default (`--no-skills` to opt out). Authored fresh
  for a consumer audience; shipped in the npm `files` array.
- **`feat(cli)` — `codegen update`.** Re-syncs the vendored runtime closure,
  installed subsystems' runtime, and consumer skills to the installed package
  version after a bump. Drift-aware, git-clean gated (`--force`), `--dry-run`;
  never touches consumer-owned files (config, `app.module.ts`, barrels).
- **`feat(parser)` — recursive YAML discovery.** Entity / relationship /
  junction / event discovery routes through a single `findYamlFiles` helper;
  domain-folder layouts (`entities/crm/account.yaml`) are first-class.

### Changed

- **Docs split.** `CONSUMER-SETUP.md` became a hub; the per-subsystem deep dives
  moved to `docs/consumer/{events,bridge,sync,auth,openapi}.md` (progressive
  disclosure), with jobs-API drift (`JobsModule` → `JobsDomainModule` +
  `JobWorkerModule`, `JobHandlerBase`, `concurrency: { key }`) corrected.

## [0.9.0] — 2026-05-25

Bundles four merged PRs (none carried a version bump): the BullMQ backend and
observability list-reads (features), plus two consumer-facing type-check fixes.

### Added

- **`feat(jobs)` — BullMQ `IJobOrchestrator` backend (BULLMQ-1, #385).** A second
  orchestrator backend behind the existing core contract, plus the Phase-1 prep:
  the bridge reserved-pool guard is revived (`JOB_WORKER_MODULE_OPTIONS` export),
  a `JobWorkerModule.forRoot({ allPools })` option, and a bridge/events-aware
  standalone `worker.ts` template.
- **`feat(observability)` — row-level list reads in the combiner (OBS-LIST-1,
  #384).** `listJobRuns` / `listEvents` / `getCorrelationTimeline` on the
  observability combiner + composing ports (drizzle + memory).

### Fixed

- **`fix(subsystems)` — type-check under a `multi_tenant:false`, no-events
  consumer (#383).** The sync schema template now always emits `tenant_id`
  (the runtime sync code references it unconditionally; `SYNC_MULTI_TENANT`
  gates enforcement, not the column), and the event-codegen generator falls back
  to `EventOfType<T> = DomainEvent` (not `never`) when no events are declared, so
  the bridge `EventFlowService` type-checks. Surfaced by a downstream consumer's
  CI; codegen-patterns' own suite never hit it.
- **`fix(clean-lite-ps)` — create-DTO nullable fields are also optional (#382).**
  `zodChainForCreate` applied `.nullable()` / `.optional()` mutually
  exclusively, so a nullable, non-required field stayed a required key.

## [0.8.1] — 2026-05-25

Closes the loop on ambient tenant scoping (0.8.0): adds the **RequesterContext
boundary** that turns an authenticated request into ambient scope, so scoping
actually engages over HTTP — including Swagger's "Authorize" bearer flow. See
ADR-0002 (`ai-docs/adrs/0002-requester-context-boundary.md`).

### Added

- **`feat(auth)` — `RequesterContextMiddleware` + `installRequesterContext`.** New
  `runtime/subsystems/auth/middleware/requester-context.ts`. The Express-style
  middleware resolves the requester via the consumer's `IUserContext` and runs the
  rest of the request inside `withRequester(...)`, so every downstream repository
  read/write is auto-scoped (ADR-0001) with no threaded `userId`. ALS-correct
  (middleware, not interceptor). `installRequesterContext(app)` is the one-liner
  for `main.ts`: resolves `AUTH_USER_CONTEXT` from the root container
  (`app.get(token, { strict: false })`), no-ops with a warning when unbound.
  Exported from the auth barrel. Verified over real HTTP — two concurrent requests
  with different bearer tokens each observe their own scope; an unauthenticated
  request observes none (`requester-context.http.spec.ts`).
- **`feat(auth)` — optional `IUserContext.resolveRequester(req)`.** Supplies the
  full `org`/`superuser` `RequesterContext` (org member list resolved at the
  boundary). Backward compatible: when absent, the boundary derives plain `'user'`
  scope from `getCurrentUserId`.

### Changed

- **`feat(scaffold)` — generated `main.ts` persists Swagger auth.**
  `SwaggerModule.setup(...)` now passes `{ swaggerOptions: { persistAuthorization:
  true } }`, so the "Authorize" bearer token survives reloads and keeps flowing as
  the `Authorization` header the boundary reads. The generated `main.ts` also
  carries a commented `installRequesterContext(app)` hint (not a static import — so
  scaffolds without the auth subsystem still compile).

### Notes

- Wiring is opt-in: add `installRequesterContext(app)` to your bootstrap after
  `NestFactory.create`. Auto-patching it in at `subsystem install auth` time (like
  the Swagger block) is a deferred follow-up (ADR-0002). A tRPC-side boundary and
  junction-repo scoping remain deferred.

## [0.8.0] — 2026-05-25

Adds **ambient tenant scoping** to `BaseRepository`: user-owned repos filter every
read/write by the requester automatically, instead of relying on hand-threaded
`userId` parameters. Ports the proven `dealbrain` `RequesterContext` pattern into
the codegen substrate. See ADR-0001 (`ai-docs/adrs/0001-ambient-tenant-scoping.md`).

### Added

- **`feat(runtime)` — `tenant-context.ts` ambient scope primitive.** New
  `runtime/base-classes/tenant-context.ts`: an `AsyncLocalStorage`-backed
  `RequesterContext { userId, organizationId, scope?, orgUserIds? }` with
  `withRequester(ctx, fn)` (set at a boundary), `requireRequester()` /
  `tryGetRequester()` (read inside repos), and `withUserScope` / `withOrgScope` /
  `withSuperuserScope` helpers. Scope model (`'user' | 'org' | 'superuser'`)
  copied verbatim from `dealbrain` `packages/integrations/src/framework`.
  Vendored into consumers via `init-scaffold` and exported from the base-classes
  barrel.
- **`feat(runtime)` — `BaseRepository.scopePredicate()` + `scopeAnd()`.** When a
  repo declares `behaviors.userTracking` (i.e. the entity has the `user_tracking`
  behavior) and an ambient `RequesterContext` is active, `findById`, `findByIds`,
  `list`, `count`, `update`, and `delete` automatically filter by `user_id`:
  `= ctx.userId` (`user`), `IN ctx.orgUserIds` (`org`; empty ⇒ matches nothing),
  or unfiltered (`superuser`). **No new per-entity config knob** — it rides the
  existing (previously dormant) `userTracking` flag. No template changes.
- **Unit coverage** — `base-repository.spec.ts` gains a scoping suite that renders
  real Drizzle SQL (via `QueryBuilder`) to assert the emitted `WHERE` per scope,
  gating (off when `userTracking` false / no context), strict-mode throw, and the
  combined soft-delete + scope + leaf predicate.

### Changed

- **`scopeEnforcement` (lenient default).** With no ambient context active, a
  `userTracking` repo is **not** scoped — adopting ambient scoping is additive,
  and isolation engages only once a boundary installs `withRequester(...)`. Set
  `protected readonly scopeEnforcement = 'strict'` on a repo or family base to
  make a missing boundary throw (fail-loud). Validated against
  `dealbrain-integrations` (no `userTracking` repos today): typecheck + 737 tests
  green, behavior unchanged.

### Fixed

- **`fix(runtime)` — soft-delete guard no longer dropped on `findById` /
  `list({where})` / bespoke query methods.** Drizzle's `.where()` *overrides* a
  prior `.where()` on a `$dynamic()` query, so the soft-delete `isNull` filter
  that `baseQuery()` added was being silently discarded whenever a leaf method
  chained its own `.where()` — only no-arg `list()` and `count()` actually
  excluded soft-deleted rows. `baseQuery(extra?)` now folds soft-delete + scope +
  the leaf predicate into a single AND-joined `WHERE`.
  - **Migration:** on `soft_delete` entities, `findById(id)` and `list({ where })`
    now correctly **exclude** soft-deleted rows (previously returned them). Code
    that relied on the old behavior to read a soft-deleted row must query
    `deletedAt` explicitly.

## [0.7.8] — 2026-05-25

Fixes a NestJS DI-resolution bug in cross-entity module wiring. A generated service that injects a sibling entity's **repository** — junction `.list()` composition (CGP-60), EAV value→definition resolution (`eav_value_table`) — failed at runtime because the sibling module exported only its **service**, never its repository (ADR-002). The code typechecked (`tsc` can't see DI wiring), so it shipped and only surfaced on a consumer's first `NestFactory` boot (dealbrain-integrations).

### Fixed

- **`fix(templates)` — entity modules export their repository.** `templates/entity/new/clean-lite-ps/module.ejs.t` now emits `exports: [<Service>, <Repository>]`. Cross-module consumers already imported the sibling *module*; the repository was just never exported, so DI couldn't resolve it. Exporting it means the consumer injects the **home-module instance** — the only place the repo's own dependencies are wired (e.g. an EAV entity's repository injects `FieldValueService` for the sync dual-write transaction, so it can only be constructed in its home module; local-providing it elsewhere can't satisfy that dep). ADR-002 revised: the repository is part of a module's public surface; use-case internals stay unexported.

### Added

- **DI-resolution smoke gate (`test/smoke/verify-boot.ts`).** Boots the generated `AppModule` via `NestFactory.create` + `app.init()` — instantiating every provider across every module — wired into the junction smoke (`run-smoke-junction.ts` step 10). Closes the gap that let the bug ship: the junction + EAV pipelines were gated only by `tsc` + grep, neither of which exercises runtime DI. Verified: reverting the repository export passes `tsc` but fails the boot gate with the exact `UnknownDependencies` error.

## [0.7.3] — 2026-05-23

Auto-emits `<generated>/subsystems.ts` — a `SUBSYSTEM_MODULES` barrel of `forRoot()` calls for every installed subsystem. Removes the "did I forget to wire `SyncModule`?" class of silent-failure bug when a subsystem is declared in `subsystems.install` but never imported into AppModule.

### Added

- **`feat(codegen)` — subsystem composition barrel.** New `src/cli/shared/subsystem-barrel-generator.ts` emits `<generated>/subsystems.ts`:

  ```ts
  // AUTO-GENERATED — wire into AppModule once:
  // @Module({ imports: [DatabaseModule, ...SUBSYSTEM_MODULES, ...GENERATED_MODULES] })
  import type { DynamicModule } from '@nestjs/common';
  import { EventsModule } from '../shared/subsystems/events/events.module';
  import { JobsDomainModule } from '../shared/subsystems/jobs/jobs-domain.module';
  import { JobWorkerModule } from '../shared/subsystems/jobs/job-worker.module';
  import { BridgeModule } from '../shared/subsystems/bridge/bridge.module';
  import { SyncModule } from '../shared/subsystems/sync/sync.module';

  export const SUBSYSTEM_MODULES: DynamicModule[] = [
    EventsModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    JobsDomainModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    JobWorkerModule.forRoot({ mode: 'embedded' }),
    BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    SyncModule.forRoot({ backend: 'drizzle', multiTenant: false }),
  ];
  ```

  Composer coverage: `events`, `jobs` (+ `JobWorkerModule` when `worker_mode: 'embedded'`), `bridge`, `sync`. `auth`, `auth-integrations`, `observability` are out of scope (their `forRoot` shapes take init-time arguments — encryption keys, IUserContext adapters — that can't be synthesized from config alone; hand-wire those).

- **Auto-regen wiring.** `codegen entity new --all` and `codegen subsystem install <name>` now call `regenerateSubsystemBarrel({ ctx, generatedDir })` after their existing barrel work. Soft-fail (warn-only) to match the entity-barrel pattern.

- **8 unit tests** under `src/__tests__/cli/subsystem-barrel-generator.test.ts` covering empty install set, single-subsystem composition, full-minimum-set ordering, `worker_mode: 'embedded'` toggle, `multi_tenant` propagation, unsupported subsystem reporting via `skipped`, default options when config block is missing.

### Migration

Greenfield: re-run `codegen entity new --all` and add `...SUBSYSTEM_MODULES` to your AppModule's `imports`. The barrel is opt-in — existing AppModules continue to work without it.

The 4 subsystems composer currently supports are the ones consumers actually wire today; widening the composer set is straightforward — see `COMPOSERS` map in `subsystem-barrel-generator.ts`.

### Known interaction

If your project uses `SyncModule.forRoot({ backend: 'drizzle', multiTenant: false })`, tsc will surface pre-existing `tenantId`-reference errors in `sync-cursor-store.drizzle-backend.ts` / `sync-run-recorder.drizzle-backend.ts` when the subsystem barrel transitively pulls those files into typecheck scope. This is an unrelated upstream issue (multi-tenancy-off + drizzle backend wasn't typecheck-clean before this PR either; consumers worked around it by excluding `src/shared/subsystems` from tsconfig). Either keep the exclude in place, or set `multi_tenant: true` in your sync config to add the `tenant_id` column the backends reference.

## [0.7.2] — 2026-05-23

Hotfix for the sync subsystem differ — `external_id_tracking` columns (added by the `external_id_tracking` behavior) were always emitting field diffs even when they hadn't changed in vendor input, producing churn. (Shipped on `main` between 0.7.1 and the junction-import dedupe; previously unreleased.)

## [0.7.1] — 2026-05-23

Hotfix for the junction emit pipeline (CGP-60, shipped in 0.7.0). When a parent entity participated in **multiple junctions** (e.g. `contact` appearing as the right side of both `account_contact` and `opportunity_contact`), each junction's `_inject-parent-{service,module}-import-clp-{left,right}.ejs.t` template emitted the same shared `import { forwardRef } from '@nestjs/common';` line independently — producing duplicate-import TS errors (TS2300 `Duplicate identifier 'forwardRef'`). The same loop also re-emitted the counterparty entity type import (`import type { Account } from '../accounts/account.entity'`), which collided with the parent's own `belongs_to` import emitted by `service.ejs.t`.

### Fixed

- **`fix(codegen)` — junction import dedupe across multi-junction parents.** Split each of the 4 existing junction inject templates (`_inject-parent-{service,module}-import-clp-{left,right}.ejs.t`) into 3 narrower inject templates with broader `skip_if` guards:
  - `_inject-parent-{service,module}-forwardref-clp-{left,right}.ejs.t` — emits only `import { forwardRef }`, gated by `skip_if: "import { forwardRef"` (matches actual import line, not body usage)
  - `_inject-parent-service-counterparty-clp-{left,right}.ejs.t` — emits the counterparty entity type import, gated by `skip_if: "from '<counterparty-path>'"` (matches any prior import from that path, including the parent's `belongs_to` import)
  - Existing `_inject-parent-{service,module}-import-clp-{left,right}.ejs.t` — narrowed to just the junction-specific imports (already had a per-junction `skip_if`)
- Updated junction snapshot tests (`test/junction/__snapshots__/opportunity-contact.test.ts.snap`, `opportunity-activity.test.ts.snap`) to reflect the new split-block layout.

### Migration note

No breaking change for the emitted code semantics — the output is functionally identical for single-junction projects, and now actually compiles for multi-junction projects. Greenfield re-emit is safe; existing emitted files re-emit cleanly via `--force`.

## [0.6.8] — 2026-04-28

Hotfix for enum codegen in the `clean-lite-ps` template pipeline. Surfaced during integration-patterns Wave 0b: enum-typed YAML fields emitted a Drizzle `text()` column instead of a `pgEnum`, so `InferSelectModel` resolved to `string` instead of the literal-union type and forced hand-casts in consumer code (e.g. `as DecryptedIntegrationRow['status']`).

### Fixed

- **`fix(codegen)` — clean-lite-ps enum emission.** `templates/entity/new/clean-lite-ps/prompt-extension.js` now produces `pgEnum` declarations + column references for any field with `choices` (or `type: enum`), matching the backend pipeline at `templates/entity/new/backend/database/schema.ejs.t:66-104`. Generated entity files now contain `export const xEnum = pgEnum('x', [...])` ahead of the `pgTable(...)` block and reference `xEnum('x').notNull()` inside the column map. `pgEnum` is added to the `drizzle-orm/pg-core` import list automatically when any enum field is present. The emitted `InferSelectModel` type now narrows to the literal union — consumers can drop `as Row['status']` casts. New unit coverage: `src/__tests__/clean-lite-ps/entity-enum-template.test.ts`.

### Migration note

Not a breaking change for the emitted code shape (the field's TypeScript type narrows — a strict superset of what consumer code can do). Existing Postgres databases generated against 0.6.7 or earlier will need a one-time `CREATE TYPE … AS ENUM (...)` + `ALTER TABLE … ALTER COLUMN x TYPE x_enum USING x::x_enum;` migration, since the column was previously `text`. Greenfield projects, or anyone regenerating before the first migration runs, are unaffected.

## [0.6.7] — 2026-04-28

Hotfix bundle for `cdp subsystem install auth-integrations`. 0.6.5 / 0.6.6 shipped the auth-integrations starter and install template, but every downstream consumer ran into four blockers on a fresh install. None of them surfaced from the source-checkout smoke (the install code resolves examples/ via the package root, which exists in dev) — they only exposed themselves through `npm install + bunx cdp subsystem install auth-integrations` against the published tarball. Bundles a fifth fix that unifies the integrations folder layout. Surfaced by integration-patterns Wave 0b.

### Changed

- **BREAKING — `fix(cli)` #303 (fix #5)** — `cdp subsystem install auth-integrations` now vendors the starter under `<paths.backend_src>/modules/integrations/` (override via `paths.modules_dir`), next to the codegen-emitted `integration` entity module. Previously: `<paths.backend_src>/shared/integrations/`. The starter's runtime tree is now organized under `adapters/`, `facade/`, and `oauth/use-cases/` subfolders to avoid collision with codegen output, and `IntegrationsAuthModule` lives at the integrations folder root. Relative imports inside the vendored files (and the bare-package auth import rewriter, fix #3) target the new layout. Detection (`detectInstalledSubsystems`) checks the new vendor target first and falls back to the legacy shared/integrations location for any pre-0.6.7 install. Pre-1.0; the only downstream consumer of 0.6.5/0.6.6 is integration-patterns Wave 0b (unmerged).

### Fixed

- **P0 — `fix(packaging)` #303** — added `examples/auth-integrations/**` to `package.json:files`. The 0.6.6 tarball did not include the starter source; `cdp subsystem install auth-integrations` therefore failed to find `node_modules/@pattern-stack/codegen/examples/auth-integrations/` and aborted the vendor copy. Narrowed to the auth-integrations subtree only — internal `examples/` (eav etc.) stay out of the published artifact. Prevention: `src/__tests__/templates/auth-integrations-files-coverage.test.ts` walks every file under `examples/auth-integrations/` and asserts it matches a `files` pattern.
- **`fix(cli)` #303** — `cdp subsystem install auth-integrations` no longer drops `integration.yaml` at the wrong path. The scaffold-locals resolver was reading `paths.definitions` (a key that doesn't exist in the schema); switched to `paths.entities` with a fallback to legacy `paths.entities_dir`, matching the resolution order in `Context.entitiesDir` and `cdp project init`. Default location (`<cwd>/definitions/entities/integration.yaml`) is unchanged.
- **`fix(cli)` #303** — vendored adapters under `<sharedRoot>/integrations/` no longer carry bare-package imports `from '@pattern-stack/codegen/runtime/subsystems/auth'`. Those imports both fail `tsc --noEmit` (the package's `exports` map points at compiled `dist/runtime/*` files, not deep subpaths) AND would inject against the publisher's compiled token Symbols rather than the consumer's vendored auth subsystem (duplicate-DI hazard). The install logic now rewrites every such specifier to a relative path resolving against `<subsystemsRoot>/auth` at copy time.
- **`fix(examples)` #303** — `IntegrationsAuthModule` is now `@Global()`. `AuthController` lives inside `AuthModule`'s injector and resolves the `AUTH_INTEGRATION_*` providers exposed by `IntegrationsAuthModule`; without `@Global()`, Nest fails to boot. Same root cause as the auth-bindings module pattern in integration-patterns PR #93.

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
