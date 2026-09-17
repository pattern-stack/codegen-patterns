import { z } from "zod";

/**
 * Codegen Configuration Schemas
 *
 * Zod schemas for the survivable `codegen.config.yaml` blocks:
 * `generate`, `paths`, `patterns`, `frontend`, and the ADR-037 runtime mode.
 * The dead `pipelines:` block (validated but never consumed) was deleted in
 * ADR-038 FE-1 — `generate.frontend` is the single frontend gate. The
 * surviving `frontend:` knobs are consumed by the whole-set frontend emitter
 * (`src/emitters/frontend/`, ADR-038 FE-2/FE-3); FE-4 validates them here.
 *
 * (Renamed in FE-4 from the FE-1 "pipelines-config" filename — a misnomer;
 * nothing pipelines-shaped survives. `generate.frontend` is the single gate.)
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
 *   was the v0.2 dogfood bug).
 * - `frontend`: whether to emit the frontend pipeline at all. Defaults to
 *   `false` so backend-only projects don't get a half-built frontend tree.
 *
 * Additional untyped keys are permitted (passthrough) so the many template
 * toggles already read directly off `generate.*` in `prompt.js` keep working
 * without each needing a schema entry here.
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
  })
  .passthrough();

export type GenerateConfig = z.infer<typeof GenerateConfigSchema>;

// ============================================================================
// Paths Config
// ============================================================================

/**
 * Filesystem path configuration for the `paths` block.
 *
 * **This is the single source of truth for `paths.*`.** The CLI's
 * `CodegenConfig['paths']` (`src/cli/shared/context.ts`) is derived from it via
 * `z.input<>`, so a key added here is typed everywhere it is read. It used to be
 * a hand-maintained duplicate, which drifted: `jobs_dir` was added here for
 * RFC-0005 and never reached the interface, producing a TS2339 that no CI job
 * ran (GATE-1, #599). Every key below is one the codebase actually reads —
 * adding a reader without declaring it here is the defect to avoid.
 *
 * `.passthrough()` stays for genuinely unknown legacy keys.
 *
 * - `backend_src`: backend source root. Default `src` (`app/backend/src` under
 *   the `clean` architecture's own defaults).
 * - `frontend_src`: frontend source root (ADR-038 emitter).
 * - `entities` / `entities_dir`: where entity YAML is read from.
 * - `events_dir` / `jobs_dir` / `providers`: definition roots for the events,
 *   jobs (RFC-0005) and integration-provider (RFC-0001) loaders.
 * - `subsystems`: install root for vendored subsystem runtime files.
 * - `modules_dir`: vendor target for `auth-integrations` (#303).
 * - `orchestration_src`: orchestration emission root (ADR-032 Phase 3-2 / O-6).
 * - `generated`: directory where codegen-owned barrel files are written
 *   (modules.ts, schema.ts). Relative to project root. Default: `src/generated`.
 */
export const PathsConfigSchema = z
  .object({
    backend_src: z.string().optional(),
    frontend_src: z.string().optional(),
    entities: z.string().optional(),
    entities_dir: z.string().optional(),
    events_dir: z.string().optional(),
    jobs_dir: z.string().optional(),
    providers: z.string().optional(),
    subsystems: z.string().optional(),
    modules_dir: z.string().optional(),
    orchestration_src: z.string().optional(),
    generated: z.string().default("src/generated"),
  })
  .passthrough();

export type PathsConfig = z.infer<typeof PathsConfigSchema>;

/**
 * The `paths` block as it appears in raw, un-parsed YAML: same keys, but
 * defaulted ones are still optional. This is what the CLI holds — it reads
 * `codegen.config.yaml` directly rather than through `.parse()`.
 */
export type PathsConfigInput = z.input<typeof PathsConfigSchema>;

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
 * The `auth:` block — closed-by-default data-plane authentication (ADR-043).
 *
 * Today it carries a single knob, `devAllowAnonymous`, read at bootstrap by the
 * generated `main.ts` boot-fail check (ADR-043 §4). When no `IUserContext` is
 * bound under `AUTH_USER_CONTEXT` and entity HTTP controllers are exposed, the
 * app refuses to serve — UNLESS this flag is `true`, which downgrades the hard
 * failure to a loud warning so a bare scaffold can be run on localhost.
 *
 * It is named to announce the hazard: setting it ships an UNAUTHENTICATED data
 * plane and must never be set in a non-localhost deployment. A future hardening
 * (ADR-043 follow-up #3) may hard-refuse it on a non-loopback bind /
 * `NODE_ENV==='production'`.
 *
 * `.strict()` — an unknown key under `auth:` is a stale-config error, not a
 * silent passthrough.
 */
export const AuthConfigSchema = z
  .object({
    devAllowAnonymous: z.boolean().default(false),
  })
  .strict()
  .default({});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
