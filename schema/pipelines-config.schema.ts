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
   * Examples: 'dealbrain', 'tanstack-electric'
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
 *     preset: dealbrain
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
