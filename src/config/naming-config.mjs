/**
 * Naming Configuration
 *
 * The `naming:` block of `codegen.config.yaml`, parsed, validated and defaulted
 * once by `project-config.ts` against `BackendNamingConfigSchema` (CFG-0). An
 * invalid or unknown naming key has already failed there, naming the key.
 *
 * Usage:
 *   import { getNamingConfig, resolveLayerNaming } from './naming-config.mjs';
 *
 *   const config = getNamingConfig();
 *   const domainNaming = resolveLayerNaming('domain');
 */

import { resolvedConfig } from './config-loader.mjs';
import { resolveLayerNaming as resolveLayer } from '../schema/naming-config.schema.mjs';

/**
 * The naming configuration: the parsed `naming:` block, or the schema's
 * defaults when the project has no config file (`DEFAULT_CODEGEN_CONFIG`).
 *
 * @returns {import('../schema/naming-config.schema.ts').BackendNamingConfig}
 */
export function getNamingConfig() {
  return resolvedConfig.naming;
}

/**
 * Resolve effective naming config for a specific layer
 *
 * Merges layer-specific overrides with global defaults.
 * Returns fully resolved config with no optional fields.
 *
 * @param {'domain' | 'application' | 'infrastructure' | 'presentation'} layer
 * @returns {import('../schema/naming-config.schema.ts').ResolvedLayerNaming}
 */
export function resolveLayerNaming(layer) {
  return resolveLayer(getNamingConfig(), layer);
}

export default {
  getNamingConfig,
  resolveLayerNaming,
};
