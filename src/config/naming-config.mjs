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

import { projectConfig } from './config-loader.mjs';
import {
  DEFAULT_BACKEND_NAMING,
  resolveLayerNaming as resolveLayer,
} from '../schema/naming-config.schema.mjs';

/**
 * The naming configuration: the parsed `naming:` block, or the defaults when
 * the project has no config file.
 *
 * @returns {import('../schema/naming-config.schema.ts').BackendNamingConfig}
 */
export function getNamingConfig() {
  return projectConfig?.naming ?? DEFAULT_BACKEND_NAMING;
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

export { DEFAULT_BACKEND_NAMING };

export default {
  getNamingConfig,
  resolveLayerNaming,
  DEFAULT_BACKEND_NAMING,
};
