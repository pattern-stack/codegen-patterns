import { z } from "zod";

/**
 * Pipelines Configuration Schema
 *
 * Defines which generation pipelines are enabled and how they are configured.
 * Each pipeline controls a distinct layer of generated output:
 * - backend: NestJS/Clean Architecture scaffolding
 * - frontend: Electric SQL collections, hooks, type metadata
 * - shared: Zod entity schemas in shared packages (e.g., packages/db)
 */

// ============================================================================
// Architecture Target
// ============================================================================

/**
 * Backend architecture pattern to generate code for
 *
 * - clean: Full Clean Architecture (domain + application + infrastructure + presentation)
 * - clean-lite: Clean Architecture without repository interfaces
 * - clean-lite-ps: Clean Architecture lite with PostgREST-style controllers
 * - vertical-slice: Feature-sliced architecture (all layers co-located per feature)
 */
export const ArchitectureTargetSchema = z.enum([
  "clean",
  "clean-lite",
  "clean-lite-ps",
  "vertical-slice",
]);

export type ArchitectureTarget = z.infer<typeof ArchitectureTargetSchema>;

// ============================================================================
// Backend Pipeline
// ============================================================================

/**
 * Backend pipeline configuration
 *
 * Controls NestJS / Clean Architecture code generation.
 */
export const BackendPipelineSchema = z.object({
  /** Whether the backend pipeline is active */
  enabled: z.boolean().default(true),
  /** Architecture pattern to generate. Defaults to 'clean'. */
  architecture: ArchitectureTargetSchema.optional().default("clean"),
});

export type BackendPipeline = z.infer<typeof BackendPipelineSchema>;

// ============================================================================
// Frontend Pipeline
// ============================================================================

/**
 * Frontend pipeline configuration
 *
 * Controls Electric SQL collection, hook, and metadata generation.
 */
export const FrontendPipelineSchema = z.object({
  /** Whether the frontend pipeline is active */
  enabled: z.boolean().default(true),
  /**
   * Named preset that collapses the ~12 individual frontend config knobs
   * into a single opinionated bundle. Resolved elsewhere in the codegen.
   * Examples: 'tanstack-electric'
   */
  preset: z.string().optional(),
});

export type FrontendPipeline = z.infer<typeof FrontendPipelineSchema>;

// ============================================================================
// Shared Pipeline
// ============================================================================

/**
 * Shared pipeline configuration
 *
 * Controls generation of Zod entity schemas in shared packages (packages/db).
 */
export const SharedPipelineSchema = z.object({
  /** Whether the shared pipeline is active */
  enabled: z.boolean().default(true),
});

export type SharedPipeline = z.infer<typeof SharedPipelineSchema>;

// ============================================================================
// Generate Config
// ============================================================================

/**
 * Top-level entity generation toggle schema.
 *
 * The `generate` block in `codegen.config.yaml` controls which pipelines the
 * entity generator walks and which coarse-grained outputs it produces. It is
 * intentionally narrower than the `pipelines` block — these are user-facing
 * switches, not pipeline-internal wiring.
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
 * Only keys used by the barrel/codegen machinery are validated here. Other
 * legacy `paths.*` keys flow through via `.passthrough()` so existing configs
 * keep working.
 *
 * - `generated`: directory where codegen-owned barrel files are written
 *   (modules.ts, schema.ts). Relative to project root. Default: `src/generated`.
 */
export const PathsConfigSchema = z
  .object({
    events_dir: z.string().optional(),
    generated: z.string().default("src/generated"),
  })
  .passthrough();

export type PathsConfig = z.infer<typeof PathsConfigSchema>;

// ============================================================================
// Top-Level Pipelines Config
// ============================================================================

/**
 * Complete pipelines configuration block
 *
 * All pipelines are optional — omitting a pipeline keeps the existing behavior
 * (no structured pipeline config, generation driven by individual toggles).
 *
 * Example in codegen.config.yaml:
 *
 * ```yaml
 * pipelines:
 *   backend:
 *     enabled: true
 *     architecture: clean-lite-ps
 *   frontend:
 *     enabled: true
 *     preset: tanstack-electric
 *   shared:
 *     enabled: true
 * ```
 */
export const PipelinesConfigSchema = z.object({
  backend: BackendPipelineSchema.optional(),
  frontend: FrontendPipelineSchema.optional(),
  shared: SharedPipelineSchema.optional(),
});

export type PipelinesConfig = z.infer<typeof PipelinesConfigSchema>;

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
// Validation Helpers
// ============================================================================

/**
 * Parse and validate a pipelines config block.
 * @throws ZodError if validation fails
 */
export function validatePipelinesConfig(data: unknown): PipelinesConfig {
  return PipelinesConfigSchema.parse(data);
}

/**
 * Safely validate a pipelines config block.
 * Returns { success: true, data } or { success: false, error }.
 */
export function safeValidatePipelinesConfig(data: unknown): {
  success: boolean;
  data?: PipelinesConfig;
  error?: z.ZodError;
} {
  const result = PipelinesConfigSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
