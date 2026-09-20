import { z } from "zod";
import { poolOverrideIssues } from "../../runtime/subsystems/jobs/pool-config.js";

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
 * resolved by bun), so it may import only `zod`, other shipped schema files,
 * and pure shipped runtime modules (`runtime/subsystems/jobs/pool-config.ts`,
 * whose pool rules `jobs.pools` runs — CFG-1).
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
 * - `frontend`: whether to emit the frontend pipeline at all. Defaults to
 *   `false` so backend-only projects don't get a half-built frontend tree.
 *   Readers: `paths.mjs`, `entity.ts`.
 * - `semantic`: whether to emit the semantic model (SEM-1, ADR-045). It
 *   replaced `analytics: none | cube`, which is now rejected by name.
 *
 * There is no backend-architecture key: backend is the only backend
 * pipeline (ARCH-0, #677). `architecture` and the `clean` pipeline's
 * `drizzleSchema` / `commands` / `queries` / `dtos` toggles were deleted with
 * it, so each is an unknown-key error.
 *
 * `.strict()` (CFG-0) — the frontend toggles deleted in FE-3 and the
 * never-consumed `schemaServer` / `schemaClient` / `electricMigrations` are
 * errors, not silent passthrough.
 */
export const GenerateConfigSchema = z
  .object({
    /**
     * Whether to emit the frontend pipeline (collections, hooks, entity metadata).
     * Default: false — backend-only projects opt out by default.
     */
    frontend: z.boolean().default(false),
    /**
     * Whether to emit the semantic model — the declared `AggregateModel` the
     * semantic-query layer runs against, built from the `role` / `agg` /
     * `aggs` / `additivity` / `time` field tags and the entity `analytics:`
     * block (SEM-1, ADR-045). Default false, mirroring `frontend`.
     *
     * Declared here by SEM-1; the emitter it gates lands in SEM-2, so nothing
     * reads it yet.
     */
    semantic: z.boolean().default(false),
    /**
     * Removed by SEM-1 (ADR-045). Declared so the error names the key and its
     * replacement: `.strict()` alone reports an unrecognized key with no path,
     * which is exactly the silent-drift class CFG-0 and SEM-1 both closed.
     */
    analytics: z
      .never({
        invalid_type_error:
          "'generate.analytics' was removed by SEM-1 (ADR-045) — use 'generate.semantic: true' to emit the semantic model",
      })
      .optional(),
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
 * - `modules_dir` = `<backend_src>/modules`: the backend entity module
 *   tree (every emitter that locates an entity module reads it, PATH-1) and the
 *   `auth-integrations` vendor target; the `@modules/*` alias points at it.
 * - `orchestration_src` = `<backend_src>/orchestration` (ADR-032 / O-6).
 *
 * There is no `subsystems` key (PATH-1, #645): the vendored runtime is
 * reachable only through `@shared/*` → `<backend_src>/shared`, so the
 * subsystems root is `<backend_src>/shared/subsystems`, derived in
 * `project-layout.ts`.
 */
export const PathsConfigSchema = z
  .object({
    backend_src: z.string().min(1).default("src"),
    frontend_src: z.string().min(1).default("apps/frontend/src"),
    entities: z.string().min(1).default("entities"),
    events_dir: z.string().min(1).default("events"),
    jobs_dir: z.string().min(1).default("definitions/jobs"),
    providers: z.string().min(1).default("definitions/providers"),
    modules_dir: z.string().min(1).optional(),
    orchestration_src: z.string().min(1).optional(),
    generated: z.string().min(1).optional(),
  })
  .strict();

/** The `paths` block as written. */
export type PathsConfigInput = z.input<typeof PathsConfigSchema>;

/** `<backend_src>/<child>`, with `.` / empty `backend_src` giving `<child>`. */
function underBackendSrc(backendSrc: string, child: string): string {
  const root = backendSrc.replace(/\/+$/, "");
  return root === "" || root === "." ? child : `${root}/${child}`;
}

/** Fill the keys whose default is relative to `backend_src`. */
export function resolvePathDefaults(paths: z.output<typeof PathsConfigSchema>) {
  const under = (child: string) => underBackendSrc(paths.backend_src, child);
  return {
    ...paths,
    generated: paths.generated ?? under("generated"),
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
 * Default (when the key is absent): `['<backend_src>/patterns/*.pattern.ts']`,
 * filled by {@link resolveConfigDefaults} from the resolved `paths.backend_src`
 * (PATH-1, #645). An explicit `patterns: []` means "no app patterns".
 *
 * Example:
 * ```yaml
 * patterns:
 *   - src/patterns/*.pattern.ts
 *   - vendor/internal-patterns/*.pattern.ts
 * ```
 */
export const PatternsConfigSchema = z.array(z.string()).optional();

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
 * - `devAllowAnonymous` — emitted into `<generated>/app-config.ts`
 *   (`authConfig`, CFG-1) and read by the generated `main.ts` boot-fail check
 *   (ADR-043 §4). When no `IUserContext` is
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
// Locations (path + import pairs — the frontend emitter's roots)
// ============================================================================

/** One `locations.<name>` override — either half may be given. */
const LocationSchema = z
  .object({
    path: z.string().optional(),
    import: z.string().optional(),
  })
  .strict();

/**
 * Every location name the generator reads — all three are the frontend
 * emitter's (`src/emitters/frontend/load-context.ts`, which resolves them from
 * the raw config against the defaults it declares). A `locations.<name>` entry
 * overrides a default shallowly, per half.
 *
 * CFG-0 deleted the eight defaults nothing read. ARCH-1 (#682) deleted the next
 * eighteen: the 14 `backend*` layer dirs, whose only reader was `paths.mjs`'s
 * `BACKEND_LAYERS` / `getImportPaths` feeding the deleted `clean` pipeline's
 * templates, and `dbSchemaServer` / `dbSchemaClient` / `dbMigrations` /
 * `dbContextEngine`, which nothing read at all. A name outside this list is an
 * error, not an unused entry.
 */
export const LOCATION_NAMES = [
  'dbEntities',
  'frontendGenerated',
  'frontendCollectionsAuth',
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
 * One `jobs.pools.<name>` entry. Emitted by the generator into
 * `<generated>/app-config.ts` (`jobPools`, CFG-1) and handed to
 * `JobsDomainModule.forRoot({ pools })`, which merges it onto the five
 * framework pools. The pool rules (a framework pool's `queue`/`reserved` are
 * fixed; a user pool needs `queue` + `concurrency`; `reserved` is
 * framework-only) are the runtime's `poolOverrideIssues`, run on the whole map
 * below — so they fail here, at generation, naming the key.
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
 *
 * `worker_mode` defaults to `embedded` (JOBS-1, #659) — declared once, here;
 * the jobs composer reads the parsed value. It is what the jobs-config
 * injector writes on a fresh install, so a hand-written block that omits the
 * key gets the same topology `subsystem install jobs` would have given it.
 *
 * JOBS-0 (#656): `backend: memory` with a standalone worker is rejected — a
 * separate worker process cannot share the in-memory job store.
 */
export const JobsConfigSchema = z
  .object({
    backend: z.enum(['drizzle', 'memory', 'bullmq']).optional(),
    multi_tenant: z.boolean().optional(),
    worker_mode: z.enum(['embedded', 'standalone']).default('embedded'),
    /** Embedded worker's explicit pool list (`JobWorkerModule.forRoot({ pools })`). */
    worker_pools: z.array(z.string()).optional(),
    /** Embedded worker drains every pool (`JobWorkerModule.forRoot({ allPools })`). */
    all_pools: z.boolean().optional(),
    pools: z
      .record(JobsPoolSchema)
      .superRefine((pools, ctx) => {
        for (const issue of poolOverrideIssues(pools)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
        }
      })
      .optional(),
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
  .strict()
  .superRefine((jobs, ctx) => {
    if (jobs.backend === 'memory' && jobs.worker_mode === 'standalone') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['worker_mode'],
        message:
          '`jobs.backend: memory` cannot run a standalone worker (`jobs.worker_mode: standalone`) — a separate ' +
          'process cannot share the in-memory job store. Set `jobs.worker_mode: embedded`, or use ' +
          '`jobs.backend: drizzle` / `bullmq`.',
      });
    }
  });

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
 * `openapi:` — written by `templates/subsystem/openapi-config/`; parsed with
 * its defaults and emitted into `<generated>/app-config.ts` (`openapiConfig`,
 * CFG-1) by `app-config-generator.ts`, which the generated `main.ts` (and the
 * `project upgrade-openapi` block) import. The defaults live here, once.
 */
export const OpenApiConfigSchema = z
  .object({
    /** Master switch: `false` ⇒ no `/docs`, no `<path>-json`. */
    enabled: z.boolean().default(false),
    /** Swagger UI mount point; the JSON document is served at `<path>-json`. */
    path: z.string().default('/docs'),
    title: z.string().default('API'),
    version: z.string().default('0.0.0'),
    description: z.string().optional(),
    /** `bearer` ⇒ `DocumentBuilder.addBearerAuth()`. */
    auth: z.enum(['bearer', 'none']).default('bearer'),
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
 *
 * The object itself — its `.shape` is what the census and the loader's
 * unknown-key hint read. {@link CodegenConfigSchema} adds the defaults that
 * depend on another block.
 */
export const CodegenConfigObjectSchema = z
  .object({
    runtime: RuntimeModeSchema,
    paths: ResolvedPathsSchema.default({}),
    generate: GenerateConfigSchema.default({}),
    patterns: PatternsConfigSchema,
    locations: LocationsConfigSchema.optional(),
    frontend: FrontendConfigSchema,
    auth: AuthConfigSchema,
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

/**
 * Fill the top-level defaults that derive from another block: `patterns`
 * from the resolved `paths.backend_src` (PATH-1, #645).
 */
export function resolveConfigDefaults(config: z.output<typeof CodegenConfigObjectSchema>) {
  return {
    ...config,
    patterns: config.patterns ?? [underBackendSrc(config.paths.backend_src, "patterns/*.pattern.ts")],
  };
}

/** `codegen.config.yaml` as every reader sees it: every default resolved. */
export const CodegenConfigSchema = CodegenConfigObjectSchema.transform(resolveConfigDefaults);

/** The parsed file: defaults applied. */
export type CodegenConfig = z.infer<typeof CodegenConfigSchema>;
