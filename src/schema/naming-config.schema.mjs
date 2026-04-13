/**
 * naming-config.schema.mjs
 *
 * Pure-JS mirror of naming-config.schema.ts for use in hygen (Node.js) context.
 * No Zod, no TypeScript — only plain-object constants and functions.
 *
 * Keep in sync with naming-config.schema.ts.
 */

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_BACKEND_NAMING = {
  fileCase: 'kebab-case',
  suffixStyle: 'dotted',
  entityInclusion: 'flat-only',
  terminology: {
    command: 'command',
    query: 'query',
  },
};

// ============================================================================
// Validation (plain JS — no Zod)
// ============================================================================

const VALID_FILE_CASES = ['kebab-case', 'camelCase', 'snake_case', 'PascalCase'];
const VALID_SUFFIX_STYLES = ['dotted', 'suffixed', 'worded'];
const VALID_ENTITY_INCLUSIONS = ['always', 'never', 'flat-only'];
const VALID_COMMAND_TERMS = ['command', 'use-case'];
const VALID_QUERY_TERMS = ['query', 'use-case'];

/**
 * Validate and parse a backend naming config object.
 * Applies defaults for missing fields.
 * Throws on invalid values.
 */
export const BackendNamingConfigSchema = {
  parse(data) {
    const fc = data?.fileCase ?? DEFAULT_BACKEND_NAMING.fileCase;
    const ss = data?.suffixStyle ?? DEFAULT_BACKEND_NAMING.suffixStyle;
    const ei = data?.entityInclusion ?? DEFAULT_BACKEND_NAMING.entityInclusion;
    const tc = data?.terminology?.command ?? DEFAULT_BACKEND_NAMING.terminology.command;
    const tq = data?.terminology?.query ?? DEFAULT_BACKEND_NAMING.terminology.query;

    if (!VALID_FILE_CASES.includes(fc)) {
      throw new Error(`Invalid fileCase: ${fc}. Must be one of: ${VALID_FILE_CASES.join(', ')}`);
    }
    if (!VALID_SUFFIX_STYLES.includes(ss)) {
      throw new Error(`Invalid suffixStyle: ${ss}. Must be one of: ${VALID_SUFFIX_STYLES.join(', ')}`);
    }
    if (!VALID_ENTITY_INCLUSIONS.includes(ei)) {
      throw new Error(`Invalid entityInclusion: ${ei}. Must be one of: ${VALID_ENTITY_INCLUSIONS.join(', ')}`);
    }
    if (!VALID_COMMAND_TERMS.includes(tc)) {
      throw new Error(`Invalid terminology.command: ${tc}. Must be one of: ${VALID_COMMAND_TERMS.join(', ')}`);
    }
    if (!VALID_QUERY_TERMS.includes(tq)) {
      throw new Error(`Invalid terminology.query: ${tq}. Must be one of: ${VALID_QUERY_TERMS.join(', ')}`);
    }

    return {
      fileCase: fc,
      suffixStyle: ss,
      entityInclusion: ei,
      terminology: { command: tc, query: tq },
      layers: data?.layers ?? undefined,
    };
  },
};

// ============================================================================
// Resolution Helper
// ============================================================================

/**
 * Resolve effective naming config for a specific layer.
 * Merges layer-specific overrides with global defaults.
 */
export function resolveLayerNaming(config, layer) {
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
// File Type Suffixes
// ============================================================================

export const FILE_TYPE_SUFFIXES = {
  entity: { dotted: '.entity', suffixed: 'Entity', word: 'entity' },
  repositoryInterface: {
    dotted: '.repository.interface',
    suffixed: 'RepositoryInterface',
    word: 'repository-interface',
  },
  repository: { dotted: '.repository', suffixed: 'Repository', word: 'repository' },
  command: { dotted: '.command', suffixed: 'Command', word: 'command' },
  query: { dotted: '.query', suffixed: 'Query', word: 'query' },
  dto: { dotted: '.dto', suffixed: 'Dto', word: 'dto' },
  controller: { dotted: '.controller', suffixed: 'Controller', word: 'controller' },
  module: { dotted: '.module', suffixed: 'Module', word: 'module' },
  schema: { dotted: '.schema', suffixed: 'Schema', word: 'schema' },
};

export default {
  DEFAULT_BACKEND_NAMING,
  BackendNamingConfigSchema,
  resolveLayerNaming,
  FILE_TYPE_SUFFIXES,
};
