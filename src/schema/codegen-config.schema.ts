import { z } from "zod";
import { BackendNamingConfigSchema } from "./naming-config.schema.js";

/**
 * Codegen Configuration Schemas
 *
 * Zod schemas for every `codegen.config.yaml` block. {@link CodegenConfigSchema}
 * at the bottom composes them into the whole file; `src/config/project-config.ts`
 * parses the file through it once, for every reader (CFG-0, #640). Every key
 * declared here names its reader; a key nothing reads is deleted, not declared.
 * Every block whose keys can be enumerated is `.strict()`, so an unknown or
 * removed key is an error naming the key — never a silent default.
 *
 * Ships in the package's `files` (the hygen prompts import the loader, `.ts`
 * resolved by bun), so it may import only `zod` and other shipped schema files.
 *
 * Only two blocks are open maps, because they model a map: `jobs.pools` (keyed
 * by pool name; each value is strict) and `frontend.parsers` (keyed by Electric
 * column type).
 */

// ============================================================================
// Generate Config
// ============================================================================

/**
 * Top-level entity generation toggle schema.
 *
 * The `generate` block in `codegen.config.yaml` controls which pipelines the
 * entity generator walks and which coarse-grained outputs it produces. These
 * are the user-facing generation switches (`generate.frontend` is the single
 * frontend gate since ADR-038 FE-1 dropped the dead `pipelines:` block).
 *
 * Keys validated here:
 * - `architecture`: which backend architecture flavor to emit. Selects one of
 *   the two backend template sets and is mutually exclusive (emitting both
 *   was the v0.2 dogfood bug). Readers: `paths.mjs`, `templates/entity/new/prompt.js`,
 *   `templates/junction/new/prompt.js`, `barrel-generator.ts`, `project.ts`,
 *   the frontend emitter.
 * - `frontend`: whether to emit the frontend pipeline at all. Defaults to
 *   `false` so backend-only projects don't get a half-built frontend tree.
 *   Readers: `paths.mjs`, `entity.ts`.
 * - `analytics`: parsed, read by nothing yet — PLAN Unit 3 replaces it with
 *   `generate.semantic`.
 * - `drizzleSchema` / `commands` / `queries` / `dtos`: `clean` pipeline
 *   emission toggles, read by `prompt.js` into the `generate.*` locals of the
 *   `templates/entity/new/backend/` templates (#602 territory).
 *
 * `.strict()` (CFG-0) — the frontend toggles deleted in FE-3 and the
 * never-consumed `schemaServer` / `schemaClient` / `electricMigrations` are
 * errors, not silent passthrough.
 */
export const GenerateConfigSchema = z
  .object({
    /**
     * Backend architecture to generate. One of:
     * - 'clean'          — Full Clean Architecture (domain + application + infrastructure + presentation)
     * - 'clean-lite-ps'  — Clean-Lite-PS modules/{plural}/ layout
     *
     * Default: 'clean'.
     */
    architecture: z.enum(["clean", "clean-lite-ps"]).default("clean"),
    /**
     * Whether to emit the frontend pipeline (collections, hooks, entity metadata).
     * Default: false — backend-only projects opt out by default.
     */
    frontend: z.boolean().default(false),
    /**
     * Analytics backend to generate.
     * - 'none': no analytics layer (default)
     * - 'cube': generate cube.js semantic layer and analytics providers
     */
    analytics: z.enum(['none', 'cube']).default('none'),
    /** `clean` pipeline: emit the Drizzle schema files. Default true. */
    drizzleSchema: z.boolean().default(true),
    /** `clean` pipeline: emit the command classes. Default true. */
    commands: z.boolean().default(true),
    /** `clean` pipeline: emit the query classes. Default true. */
    queries: z.boolean().default(true),
    /** `clean` pipeline: emit the DTO schemas. Default true. */
    dtos: z.boolean().default(true),
  })
  .strict();

export type GenerateConfig = z.infer<typeof GenerateConfigSchema>;

// ============================================================================
// Paths Config
// ============================================================================

/**
 * Filesystem path configuration for the `paths` block.
 *
 * **This is the single source of truth for `paths.*`.** Every key below is one
 * the codebase actually reads; `src/__tests__/config/config-census.test.ts`
 * greps the source for `paths.<key>` reads and fails on any key not declared
 * here (CFG-0 gate 2). It used to be a hand-maintained duplicate, which drifted
 * (GATE-1, #599), and then `.passthrough()` and never parsed, which let a
 * deleted key (`entities_dir`, #634) be silently ignored (#640).
 *
 * `.strict()` — an unknown key is an error naming it.
 *
 * Every key has exactly ONE default, declared here (PATH-0, #642). No reader
 * carries its own fallback literal: the CLI, the `.mjs` helpers and the prompts
 * all read the resolved block (`DEFAULT_CODEGEN_CONFIG` when there is no file).
 *
 * Static defaults (`.default()` below):
 * - `backend_src` = `src`: backend source root (ADR-037 consumer layout).
 * - `frontend_src` = `apps/frontend/src`: frontend source root (init locates the
 *   frontend `package.json` from its parent).
 * - `entities` = `entities`: where entity YAML is read from (`entities-dir.ts`).
 * - `events_dir` = `events`, `jobs_dir` = `definitions/jobs`, `providers` =
 *   `definitions/providers`: definition roots for the events, jobs (RFC-0005)
 *   and integration-provider (RFC-0001) loaders.
 *
 * Derived from the resolved `backend_src` by {@link resolvePathDefaults} when
 * absent:
 * - `generated` = `<backend_src>/generated`: codegen-owned cross-entity barrels.
 * - `subsystems` = `<backend_src>/shared/subsystems`: subsystem runtime root.
 * - `modules_dir` = `<backend_src>/modules`: `auth-integrations` vendor target.
 * - `orchestration_src` = `<backend_src>/orchestration` (ADR-032 / O-6).
 */
export const PathsConfigSchema = z
  .object({
    backend_src: z.string().min(1).default("src"),
    frontend_src: z.string().min(1).default("apps/frontend/src"),
    entities: z.string().min(1).default("entities"),
    events_dir: z.string().min(1).default("events"),
    jobs_dir: z.string().min(1).default("definitions/jobs"),
    providers: z.string().min(1).default("definitions/providers"),
    subsystems: z.string().min(1).optional(),
    modules_dir: z.string().min(1).optional(),
    orchestration_src: z.string().min(1).optional(),
    generated: z.string().min(1).optional(),
  })
  .strict();

/** The `paths` block as written. */
export type PathsConfigInput = z.input<typeof PathsConfigSchema>;

/** Fill the keys whose default is relative to `backend_src`. */
export function resolvePathDefaults(paths: z.output<typeof PathsConfigSchema>) {
  const root = paths.backend_src.replace(/\/+$/, "");
  const under = (child: string) => (root === "" || root === "." ? child : `${root}/${child}`);
  return {
    ...paths,
    generated: paths.generated ?? under("generated"),
    subsystems: paths.subsystems ?? under("shared/subsystems"),
    modules_dir: paths.modules_dir ?? under("modules"),
    orchestration_src: paths.orchestration_src ?? under("orchestration"),
  };
}

/** `paths` as every reader sees it: every key resolved. */
export const ResolvedPathsSchema = PathsConfigSchema.transform(resolvePathDefaults);

export type PathsConfig = z.output<typeof ResolvedPathsSchema>;

// ============================================================================
// Patterns Config (ADR-031, PATTERN-5)
// ============================================================================

/**
 * Patterns manifest — array of globs, relative to project root, that
 * `loadAppPatterns()` expands and dynamic-imports to discover app-defined
 * patterns. Library-shipped patterns (Base / Integrated / Activity / Knowledge
 * / Metadata) are pre-registered by the codegen package; consumers never
 * list them.
 *
 * Default (when the key is absent): `['src/patterns/*.pattern.ts']`.
 *
 * Example:
 * ```yaml
 * patterns:
 *   - src/patterns/*.pattern.ts
 *   - vendor/internal-patterns/*.pattern.ts
 * ```
 */
export const PatternsConfigSchema = z
  .array(z.string())
  .optional()
  .default(['src/patterns/*.pattern.ts']);

export type PatternsConfig = z.infer<typeof PatternsConfigSchema>;

// ============================================================================
// Runtime Mode (ADR-037)
// ============================================================================

/**
 * Which copy of the framework runtime the generated code imports from.
 *
 * - `package` (DEFAULT) — generated code imports the runtime from the npm
 *   package: `@pattern-stack/codegen/subsystems` and
 *   `@pattern-stack/codegen/runtime/*`. The consumer depends on the package;
 *   `project init` vendors nothing.
 * - `vendored` — generated code imports the runtime via the consumer's
 *   `@shared/*` tsconfig alias; `project init` copies the runtime closure into
 *   `src/shared/**` (ADR-035). Keeps a single drizzle-orm type identity in the
 *   consumer's module graph.
 *
 * ADR-037: the default is `package`. **Existing vendored projects must set
 * `runtime: vendored` explicitly** so the new default does not silently flip
 * them to package specifiers they can't resolve.
 */
export const RuntimeModeSchema = z.enum(['package', 'vendored']).default('package');

export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

// ============================================================================
// Frontend Config (ADR-038, FE-4)
// ============================================================================

/**
 * `frontend.auth` — the auth-header function the emitted Electric collections
 * and REST client wire in.
 *
 * `function`:
 * - **absent** → defaults to `'getAuthorizationHeader'` (the house default).
 * - **explicit `null`** → auth is DISABLED; the emitter writes no header lines.
 *
 * Zod `.default()` only fires on `undefined`, so an explicit `null` flows
 * through unchanged — this preserves the old `hasOwnProperty('function')`
 * "present-but-null disables" semantics without a separate sentinel.
 */
export const FrontendAuthConfigSchema = z
  .object({
    function: z.string().nullable().default('getAuthorizationHeader'),
  })
  .default({ function: 'getAuthorizationHeader' });

export type FrontendAuthConfig = z.infer<typeof FrontendAuthConfigSchema>;

/**
 * `frontend.sync` — global sync defaults + the Electric/REST emission knobs the
 * collection + api builders consume. Per-entity `sync:` (entity YAML) overrides
 * `mode`; everything else here is global.
 *
 * - `mode` — global default sync mode (`api` | `electric`). Per-entity `sync:`
 *   wins. Default `electric`. (`offline` is deferred — see the spec OQ-6.)
 * - `shapeUrl` — Electric shape base path. Default `/v1/shape`.
 * - `useTableParam` — emit the `params: { table }` shape-URL form. Default true.
 * - `columnMapper` — Electric column-mapper fn name, or `null` to emit none.
 *   Default `snakeCamelMapper`.
 * - `columnMapperNeedsCall` — call the mapper (`fn()`) vs reference it (`fn`).
 *   Default true.
 * - `apiBaseUrlImport` — when set, the api client imports `API_BASE_URL` from
 *   this module and uses it as baseURL. Default `null` (use `apiUrl`).
 * - `apiUrl` — REST base path used when no `apiBaseUrlImport`. Default `/api`.
 */
export const FrontendSyncConfigSchema = z
  .object({
    mode: z.enum(['api', 'electric']).default('electric'),
    shapeUrl: z.string().default('/v1/shape'),
    useTableParam: z.boolean().default(true),
    columnMapper: z.string().nullable().default('snakeCamelMapper'),
    columnMapperNeedsCall: z.boolean().default(true),
    apiBaseUrlImport: z.string().nullable().default(null),
    apiUrl: z.string().default('/api'),
  })
  .default({});

export type FrontendSyncConfig = z.infer<typeof FrontendSyncConfigSchema>;

/**
 * `frontend.catalog` — display grouping for the emitted providers catalog
 * (`generated/providers.ts`, emitted when `definitions/providers/` exists).
 *
 * `categories` is the ordered list of catalog groups; each provider joins a
 * group via its `display.category` (provider YAML). Providers whose category
 * matches no entry — or who declare none — still appear in the flat
 * `PROVIDERS` export, just not in `PROVIDER_CATALOG`.
 */
export const FrontendCatalogConfigSchema = z
	.object({
		categories: z
			.array(
				z
					.object({
						id: z.string(),
						name: z.string(),
						blurb: z.string().default(''),
					})
					.strict(),
			)
			.default([]),
	})
	.default({});

export type FrontendCatalogConfig = z.infer<typeof FrontendCatalogConfigSchema>;

/**
 * `frontend.fields` — field-meta inference knobs.
 *
 * `textareaThreshold`:
 * - **absent** → `500` (today's behavior; byte-identical emitter output).
 * - **explicit number** → custom cutoff; `maxLength` must *strictly exceed* it
 *   to produce `textarea` (same strict `>` semantics as the hardcoded value).
 * - **explicit `null`** → heuristic DISABLED; bounded strings always stay
 *   `text` unless the author sets `ui_type: textarea` explicitly.
 *
 * Follows the house present-but-null disables convention (same as
 * `auth.function`, `sync.columnMapper`): Zod `.default()` fires only on
 * `undefined`, so explicit `null` flows through unchanged.
 *
 * `.strict()` — an unknown key here is a stale-config error, matching the
 * rationale for `.strict()` on {@link FrontendConfigSchema}.
 */
export const FrontendFieldsConfigSchema = z
  .object({
    /**
     * String → textarea cutoff (strictly greater than). Absent or `undefined`
     * ⇒ 500. Explicit `null` ⇒ heuristic disabled (all bounded strings stay
     * `text` unless the author sets `ui_type: textarea`).
     */
    textareaThreshold: z.number().int().positive().nullable().default(500),
  })
  .strict()
  .default({});

export type FrontendFieldsConfig = z.infer<typeof FrontendFieldsConfigSchema>;

/**
 * The `frontend:` block in `codegen.config.yaml`.
 *
 * Gated entirely by `generate.frontend` — when that boolean is false the
 * emitter never runs and these knobs are inert. Validated always (defaults
 * applied even when the whole block is absent), like the `generate` block, so
 * the emitter can read a fully-populated config without per-key fallbacks.
 *
 * - `auth` — see {@link FrontendAuthConfigSchema}.
 * - `parsers` — Electric column-type → parser-fn source map. Default maps
 *   `timestamptz` to a `Date` constructor; consumers extend it per column type.
 * - `sync` — see {@link FrontendSyncConfigSchema}.
 * - `catalog` — see {@link FrontendCatalogConfigSchema}.
 * - `fields` — see {@link FrontendFieldsConfigSchema}.
 *
 * `.strict()` — the FE-1 mimicry knobs (`collections.schemaPrefix`, etc.) are
 * deleted with their templates; an unknown key here is a stale-config error,
 * not silent passthrough.
 */
export const FrontendConfigSchema = z
  .object({
    auth: FrontendAuthConfigSchema,
    parsers: z
      .record(z.string())
      .default({ timestamptz: '(date: string) => new Date(date)' }),
    sync: FrontendSyncConfigSchema,
    catalog: FrontendCatalogConfigSchema,
    fields: FrontendFieldsConfigSchema,
  })
  .strict()
  .default({});

export type FrontendConfig = z.infer<typeof FrontendConfigSchema>;

// ============================================================================
// Auth Config (ADR-043)
// ============================================================================

/**
 * The `auth:` block — closed-by-default data-plane authentication (ADR-043)
 * plus the auth subsystem's install knob.
 *
 * - `devAllowAnonymous` — read at bootstrap by the generated `main.ts`
 *   boot-fail check (ADR-043 §4; consumer runtime). When no `IUserContext` is
 *   bound under `AUTH_USER_CONTEXT` and entity HTTP controllers are exposed,
 *   the app refuses to serve — UNLESS this flag is `true`, which downgrades the
 *   hard failure to a loud warning so a bare scaffold can be run on localhost.
 *   It is named to announce the hazard: setting it ships an UNAUTHENTICATED
 *   data plane and must never be set in a non-localhost deployment.
 * - `redirect_uri_base` — OAuth redirect base baked into the auth subsystem
 *   install (`auth-scaffold-locals.ts`). Absent ⇒ `http://localhost:3000`.
 *
 * `.strict()` — an unknown key under `auth:` is a stale-config error, not a
 * silent passthrough. (The auth injector used to write `encryption_key`,
 * `oauth_state_store` and `enable_controller`, which nothing read; CFG-0
 * deleted them.)
 */
export const AuthConfigSchema = z
  .object({
    devAllowAnonymous: z.boolean().default(false),
    redirect_uri_base: z.string().optional(),
  })
  .strict()
  .default({});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// ============================================================================
// Locations (path + import pairs, src/config/locations.mjs)
// ============================================================================

/** One `locations.<name>` override — either half may be given. */
const LocationSchema = z
  .object({
    path: z.string().optional(),
    import: z.string().optional(),
  })
  .strict();

/**
 * Every location name the generator reads. `locations.mjs` holds the default for
 * each; a `locations.<name>` entry overrides it (shallow, per half). Readers:
 * `paths.mjs` (`BACKEND_LAYERS`, the `backend*` layer dirs), `prompt.js` /
 * `prompt-extension.js` and the entity templates (the rest), and the frontend
 * emitter (`dbEntities`, `frontendCollectionsAuth`, `frontendGenerated`).
 *
 * CFG-0 deleted the eight defaults nothing read (`backendSrc`, `frontendSrc`,
 * `frontendCollections`, `frontendStore`, `frontendStoreEntities`,
 * `frontendEntities`, `frontendEntityMetadata`, `trpcClient`) and the
 * "new location defined in config" branch: a name outside this list is an
 * error, not an unused entry.
 */
export const LOCATION_NAMES = [
  'dbEntities',
  'dbSchemaServer',
  'dbSchemaClient',
  'dbMigrations',
  'dbContextEngine',
  'frontendGenerated',
  'frontendCollectionsAuth',
  'backendDomain',
  'backendCommands',
  'backendQueries',
  'backendSchemas',
  'backendDrizzle',
  'backendRepositories',
  'backendDatabaseModule',
  'backendControllers',
  'backendModules',
  'backendConstants',
  'backendAuthGuard',
  'backendCurrentUserDecorator',
  'backendElectricService',
  'backendElectricModule',
] as const;

export type LocationName = (typeof LOCATION_NAMES)[number];

export const LocationsConfigSchema = z
  .object(
    Object.fromEntries(LOCATION_NAMES.map((name) => [name, LocationSchema.optional()])) as Record<
      LocationName,
      z.ZodOptional<typeof LocationSchema>
    >,
  )
  .strict();

export type LocationsConfig = z.infer<typeof LocationsConfigSchema>;

// ============================================================================
// `clean` pipeline knobs (#602 territory)
// ============================================================================

/**
 * `database.dialect` — read by `paths.mjs` › `getDatabaseDialect` into the
 * `databaseDialect` local of the `clean` pipeline's Drizzle templates
 * (`templates/entity/new/backend/database/`).
 */
export const DatabaseConfigSchema = z
  .object({
    dialect: z.enum(['postgres', 'sqlite']).default('postgres'),
  })
  .strict()
  .default({});

/**
 * `behaviors.strategy` — read by `templates/entity/new/prompt.js` (an entity's
 * own `behavior_strategy:` wins) into the `behaviorStrategy` local of the
 * `clean` pipeline's repository template.
 */
export const BehaviorsConfigSchema = z
  .object({
    strategy: z.enum(['base_class', 'inline']).default('inline'),
  })
  .strict()
  .default({});

// ============================================================================
// Dev (`codegen dev`)
// ============================================================================

/** `dev.port` — the app port `codegen dev` probes (`src/cli/commands/dev.ts`). */
export const DevConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
  })
  .strict();

// ============================================================================
// Subsystems (ADR-008 + ADR-037)
// ============================================================================

/**
 * Every subsystem name `codegen subsystem install` accepts — the `name`s of
 * `SUBSYSTEMS` in `src/cli/shared/subsystem-detect.ts` (a unit test asserts the
 * two agree).
 */
export const SUBSYSTEM_NAMES = [
  'events',
  'jobs',
  'cache',
  'storage',
  'integration',
  'bridge',
  'openapi-config',
  'observability',
  'auth',
  'auth-integrations',
] as const;

/**
 * `subsystems.install` — in `runtime: package` mode the install list IS the
 * record of installed subsystems (ADR-037). Written by
 * `subsystems-install-config.ts`; read by `subsystem-detect.ts`.
 */
export const SubsystemsConfigSchema = z
  .object({
    install: z.array(z.enum(SUBSYSTEM_NAMES)).optional(),
  })
  .strict();

/** `multi_tenant` + a `backend` enum — the shape every durable subsystem shares. */
const drizzleOrMemory = z.enum(['drizzle', 'memory']);

/**
 * `events:` — written by `templates/subsystem/events-config/`; read by
 * `subsystem-barrel-generator.ts` (`EventsModule.forRoot`), `subsystem-detect.ts`
 * (`backend`) and `events-scaffold-locals.ts` (`multi_tenant`).
 */
export const EventsConfigSchema = z
  .object({
    backend: drizzleOrMemory.optional(),
    multi_tenant: z.boolean().optional(),
    extensions: z
      .object({
        drizzle: z
          .object({
            /** LISTEN-NOTIFY-1 — `EventsModule.forRoot({ listenNotify })`. */
            listen_notify: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * One `jobs.pools.<name>` entry. Read by the jobs runtime's
 * `pool-config.loader.ts` (in the consumer's app), which merges it onto the
 * five framework pools and enforces the rest (a user pool needs `queue` +
 * `concurrency`; `reserved` is framework-only).
 */
const JobsPoolSchema = z
  .object({
    queue: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    reserved: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

/**
 * `jobs:` — written by `templates/subsystem/jobs-config/`; read by
 * `subsystem-barrel-generator.ts` (`JobsDomainModule` / `JobWorkerModule`
 * options), `jobs-scaffold-locals.ts`, `subsystem-detect.ts` (`backend`) and
 * the jobs runtime (`pools`).
 *
 * `pools` is the one open map: keyed by pool name, each value strict.
 */
export const JobsConfigSchema = z
  .object({
    backend: z.enum(['drizzle', 'memory', 'bullmq']).optional(),
    multi_tenant: z.boolean().optional(),
    worker_mode: z.enum(['embedded', 'standalone']).optional(),
    /** Embedded worker's explicit pool list (`JobWorkerModule.forRoot({ pools })`). */
    worker_pools: z.array(z.string()).optional(),
    /** Embedded worker drains every pool (`JobWorkerModule.forRoot({ allPools })`). */
    all_pools: z.boolean().optional(),
    pools: z.record(JobsPoolSchema).optional(),
    extensions: z
      .object({
        /** LISTEN-NOTIFY-1 / CLAIM-HB-1 knobs, camelCased into the module options. */
        drizzle: z
          .object({
            listen_notify: z.boolean().optional(),
            poll_interval_ms: z.number().int().positive().optional(),
            stale_threshold_ms: z.number().int().positive().optional(),
            stale_sweeper_interval_ms: z.number().int().positive().optional(),
            claim_heartbeat_interval_ms: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        /** BULLMQ-1 — passed verbatim as the runtime's `BullMqExtensionsConfig`. */
        bullmq: z
          .object({
            redis_url: z.string().optional(),
            queue_prefix: z.string().optional(),
            bull_board: z
              .object({
                enabled: z.boolean(),
                mount_path: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * `bridge:` — written by `templates/subsystem/bridge-config/`; read by
 * `subsystem-barrel-generator.ts`, `bridge-scaffold-locals.ts`,
 * `subsystem-detect.ts`.
 */
export const BridgeConfigSchema = z
  .object({
    backend: drizzleOrMemory.optional(),
    multi_tenant: z.boolean().optional(),
  })
  .strict();

/**
 * `integration:` — written by `templates/subsystem/integration-config/`; read
 * by `subsystem-barrel-generator.ts` (`IntegrationModule.forRoot`, including
 * `differ`), `integration-scaffold-locals.ts`, `subsystem-detect.ts`.
 */
export const IntegrationConfigSchema = z
  .object({
    backend: drizzleOrMemory.optional(),
    multi_tenant: z.boolean().optional(),
    /** DIFFER-UNIGNORE — field names added to / removed from the default ignore list. */
    differ: z
      .object({
        ignore: z.array(z.string()).optional(),
        unignore: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * `observability:` — written by `templates/subsystem/observability-config/`;
 * read by `subsystem-barrel-generator.ts`, which passes an enabled reporter
 * verbatim as `ObservabilityModuleOptions.reporters` (camelCase keys).
 */
export const ObservabilityConfigSchema = z
  .object({
    reporters: z
      .object({
        bridgeMetrics: z
          .object({
            enabled: z.boolean(),
            intervalMs: z.number().int().positive().optional(),
            windowHours: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * `openapi:` — written by `templates/subsystem/openapi-config/`; read at boot
 * by the generated `main.ts` (consumer runtime; `init-scaffold.ts`,
 * `project-upgrade-openapi.ts`).
 */
export const OpenApiConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    auth: z.enum(['bearer', 'none']).optional(),
  })
  .strict();

/** `cache:` — `backend` only, read by `subsystem-detect.ts`. */
export const CacheConfigSchema = z
  .object({ backend: drizzleOrMemory.optional() })
  .strict();

/** `storage:` — `backend` only, read by `subsystem-detect.ts`. */
export const StorageConfigSchema = z
  .object({ backend: z.enum(['local', 'memory']).optional() })
  .strict();

// ============================================================================
// The whole file
// ============================================================================

/**
 * `codegen.config.yaml`, whole. Parsed once per process by
 * `src/config/project-config.ts`; every reader — the CLI context, the `.mjs`
 * helpers, the hygen prompts — receives the parsed object and nothing reads the
 * raw YAML (CFG-0, #640).
 *
 * `.strict()` at the top level: an unknown block is an error naming it.
 * Blocks with defaults are always populated after parse; the subsystem blocks
 * stay absent until their subsystem is installed.
 */
export const CodegenConfigSchema = z
  .object({
    runtime: RuntimeModeSchema,
    paths: ResolvedPathsSchema.default({}),
    generate: GenerateConfigSchema.default({}),
    patterns: PatternsConfigSchema,
    naming: BackendNamingConfigSchema.default({}),
    locations: LocationsConfigSchema.optional(),
    frontend: FrontendConfigSchema,
    auth: AuthConfigSchema,
    database: DatabaseConfigSchema,
    behaviors: BehaviorsConfigSchema,
    dev: DevConfigSchema.optional(),
    subsystems: SubsystemsConfigSchema.optional(),
    events: EventsConfigSchema.optional(),
    jobs: JobsConfigSchema.optional(),
    bridge: BridgeConfigSchema.optional(),
    integration: IntegrationConfigSchema.optional(),
    observability: ObservabilityConfigSchema.optional(),
    openapi: OpenApiConfigSchema.optional(),
    cache: CacheConfigSchema.optional(),
    storage: StorageConfigSchema.optional(),
  })
  .strict();

/** The parsed file: defaults applied. */
export type CodegenConfig = z.infer<typeof CodegenConfigSchema>;
