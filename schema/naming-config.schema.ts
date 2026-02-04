import { z } from "zod";

/**
 * Backend Naming Configuration Schema
 *
 * Defines composable dimensions for backend code generation naming conventions:
 * - fileCase: How file names are cased (kebab-case, camelCase, etc.)
 * - suffixStyle: How type suffixes are applied (.entity.ts vs Entity.ts)
 * - entityInclusion: When entity name appears in command/query files
 * - terminology: Type name mappings (command vs use-case)
 *
 * Supports per-layer overrides for domain, application, infrastructure, presentation.
 */

// ============================================================================
// File Case Options
// ============================================================================

/**
 * File case style for generated file names
 *
 * Examples for entity "deal_state":
 * - kebab-case: deal-state.entity.ts
 * - camelCase: dealState.entity.ts
 * - snake_case: deal_state.entity.ts
 * - PascalCase: DealState.entity.ts (typically with suffixed style)
 */
export const FileCaseSchema = z.enum([
  "kebab-case",
  "camelCase",
  "snake_case",
  "PascalCase",
]);

export type FileCase = z.infer<typeof FileCaseSchema>;

// ============================================================================
// Suffix Style Options
// ============================================================================

/**
 * Suffix style for generated file names
 *
 * Examples for entity "opportunity":
 * - dotted: opportunity.entity.ts (default, NestJS/Angular style)
 * - suffixed: OpportunityEntity.ts (C#/Java style, requires PascalCase)
 * - worded: opportunity-entity.ts (uses separator from fileCase)
 */
export const SuffixStyleSchema = z.enum(["dotted", "suffixed", "worded"]);

export type SuffixStyle = z.infer<typeof SuffixStyleSchema>;

// ============================================================================
// Entity Inclusion Options
// ============================================================================

/**
 * When to include entity name in command/query file names
 *
 * Controls file names in application layer:
 * - always: create-opportunity.command.ts (even in nested folders)
 * - never: create.command.ts (even in flat mode)
 * - flat-only: create.command.ts when nested, create-opportunity.command.ts when flat (default)
 */
export const EntityInclusionSchema = z.enum(["always", "never", "flat-only"]);

export type EntityInclusion = z.infer<typeof EntityInclusionSchema>;

// ============================================================================
// Terminology Configuration
// ============================================================================

/**
 * Type name terminology mappings
 *
 * Controls class names and file suffixes:
 * - command: 'command' → CreateOpportunityCommand, create.command.ts
 *            'use-case' → CreateOpportunityUseCase, create.use-case.ts
 * - query: 'query' → GetOpportunityByIdQuery
 *          'use-case' → GetOpportunityByIdUseCase
 */
export const TerminologySchema = z.object({
  command: z.enum(["command", "use-case"]).default("command"),
  query: z.enum(["query", "use-case"]).default("query"),
});

export type Terminology = z.infer<typeof TerminologySchema>;

// ============================================================================
// Layer-Specific Naming Configuration
// ============================================================================

/**
 * Per-layer naming overrides
 *
 * Each layer can override global defaults:
 * - domain: entities, repository interfaces
 * - application: commands/use-cases, queries, DTOs
 * - infrastructure: repository implementations, Drizzle schemas
 * - presentation: controllers, modules
 */
export const LayerNamingSchema = z.object({
  fileCase: FileCaseSchema.optional(),
  suffixStyle: SuffixStyleSchema.optional(),
  entityInclusion: EntityInclusionSchema.optional(),
  terminology: TerminologySchema.partial().optional(),
});

export type LayerNaming = z.infer<typeof LayerNamingSchema>;

// ============================================================================
// Layers Configuration
// ============================================================================

/**
 * Per-layer overrides container
 */
export const LayersConfigSchema = z.object({
  domain: LayerNamingSchema.optional(),
  application: LayerNamingSchema.optional(),
  infrastructure: LayerNamingSchema.optional(),
  presentation: LayerNamingSchema.optional(),
});

export type LayersConfig = z.infer<typeof LayersConfigSchema>;

// ============================================================================
// Full Backend Naming Configuration
// ============================================================================

/**
 * Complete backend naming configuration
 *
 * Global defaults apply to all layers unless overridden.
 * Defaults are chosen to match current hardcoded behavior for backward compatibility:
 * - fileCase: 'kebab-case' → opportunity.entity.ts
 * - suffixStyle: 'dotted' → .entity.ts, .repository.ts
 * - entityInclusion: 'flat-only' → create.command.ts (nested), create-opportunity.command.ts (flat)
 * - terminology: { command: 'command', query: 'query' }
 */
export const BackendNamingConfigSchema = z.object({
  // Global defaults
  fileCase: FileCaseSchema.default("kebab-case"),
  suffixStyle: SuffixStyleSchema.default("dotted"),
  entityInclusion: EntityInclusionSchema.default("flat-only"),
  terminology: TerminologySchema.default({
    command: "command",
    query: "query",
  }),

  // Per-layer overrides
  layers: LayersConfigSchema.optional(),
});

export type BackendNamingConfig = z.infer<typeof BackendNamingConfigSchema>;

// ============================================================================
// Resolved Layer Configuration (all fields required)
// ============================================================================

/**
 * Fully resolved naming config for a specific layer
 * All fields are required (no optionals) after merging with defaults
 */
export interface ResolvedLayerNaming {
  fileCase: FileCase;
  suffixStyle: SuffixStyle;
  entityInclusion: EntityInclusion;
  terminology: Required<Terminology>;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parse and validate backend naming configuration
 * @throws ZodError if validation fails
 */
export function validateBackendNamingConfig(
  data: unknown
): BackendNamingConfig {
  return BackendNamingConfigSchema.parse(data);
}

/**
 * Safely validate backend naming configuration
 * @returns Object with success flag and either data or error
 */
export function safeValidateBackendNamingConfig(data: unknown): {
  success: boolean;
  data?: BackendNamingConfig;
  error?: z.ZodError;
} {
  const result = BackendNamingConfigSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ============================================================================
// Resolution Helpers
// ============================================================================

/**
 * Resolve effective naming config for a specific layer
 *
 * Merges layer-specific overrides with global defaults.
 * Returns fully resolved config with no optional fields.
 *
 * @param config - Full naming config with global defaults and layer overrides
 * @param layer - Layer to resolve config for
 * @returns Resolved config with all fields defined
 */
export function resolveLayerNaming(
  config: BackendNamingConfig,
  layer: "domain" | "application" | "infrastructure" | "presentation"
): ResolvedLayerNaming {
  const layerConfig = config.layers?.[layer];

  return {
    fileCase: layerConfig?.fileCase ?? config.fileCase,
    suffixStyle: layerConfig?.suffixStyle ?? config.suffixStyle,
    entityInclusion: layerConfig?.entityInclusion ?? config.entityInclusion,
    terminology: {
      command: layerConfig?.terminology?.command ?? config.terminology.command,
      query: layerConfig?.terminology?.query ?? config.terminology.query,
    },
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default naming configuration
 *
 * Preserves current hardcoded behavior for backward compatibility:
 * - kebab-case file names with dotted suffixes
 * - Entity name included only in flat mode
 * - Command/Query terminology (not UseCase)
 */
export const DEFAULT_BACKEND_NAMING: BackendNamingConfig = {
  fileCase: "kebab-case",
  suffixStyle: "dotted",
  entityInclusion: "flat-only",
  terminology: {
    command: "command",
    query: "query",
  },
};

// ============================================================================
// File Type Identifiers
// ============================================================================

/**
 * Backend file types that can be generated
 */
export const FileTypeSchema = z.enum([
  "entity",
  "repositoryInterface",
  "repository",
  "command",
  "query",
  "dto",
  "controller",
  "module",
  "schema",
]);

export type FileType = z.infer<typeof FileTypeSchema>;

/**
 * Suffix mappings for each file type
 *
 * Used by computeFileName() to apply correct suffix based on style:
 * - dotted: prepends dot (e.g., ".entity")
 * - suffixed: appends directly (e.g., "Entity")
 * - worded: uses separator (e.g., "-entity" for kebab-case)
 */
export const FILE_TYPE_SUFFIXES: Record<
  FileType,
  { dotted: string; suffixed: string; word: string }
> = {
  entity: { dotted: ".entity", suffixed: "Entity", word: "entity" },
  repositoryInterface: {
    dotted: ".repository.interface",
    suffixed: "RepositoryInterface",
    word: "repository-interface",
  },
  repository: { dotted: ".repository", suffixed: "Repository", word: "repository" },
  command: { dotted: ".command", suffixed: "Command", word: "command" },
  query: { dotted: ".query", suffixed: "Query", word: "query" },
  dto: { dotted: ".dto", suffixed: "Dto", word: "dto" },
  controller: { dotted: ".controller", suffixed: "Controller", word: "controller" },
  module: { dotted: ".module", suffixed: "Module", word: "module" },
  schema: { dotted: ".schema", suffixed: "Schema", word: "schema" },
};
