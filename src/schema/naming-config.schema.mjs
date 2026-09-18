/**
 * naming-config.schema.mjs
 *
 * Pure-JS mirror of naming-config.schema.ts's resolver and suffix table, for the
 * hygen-side `.mjs` helpers. Neither validation nor defaults are mirrored: the
 * `naming:` block is validated and defaulted once, by the Zod schema, in
 * `src/config/project-config.ts` (CFG-0, PATH-0).
 *
 * Keep in sync with naming-config.schema.ts.
 */

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
  resolveLayerNaming,
  FILE_TYPE_SUFFIXES,
};
