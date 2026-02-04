/**
 * Naming Configuration Loader
 *
 * Loads and validates backend naming configuration from codegen.config.yaml.
 * Provides defaults matching current hardcoded behavior for backward compatibility.
 *
 * Usage:
 *   import { getNamingConfig, resolveLayerNaming } from './naming-config.mjs';
 *
 *   const config = getNamingConfig();
 *   const domainNaming = resolveLayerNaming(config, 'domain');
 */

import { projectConfig } from './config-loader.mjs';
import {
  BackendNamingConfigSchema,
  DEFAULT_BACKEND_NAMING,
  resolveLayerNaming as resolveLayer,
} from '../schema/naming-config.schema.ts';

// ============================================================================
// Deep Merge Utility
// ============================================================================

/**
 * Check if value is a plain object (not array, null, or other types)
 */
function isPlainObject(obj) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

/**
 * Deep merge two objects, with source taking precedence
 *
 * - Recursively merges nested objects
 * - Source values override target values
 * - Handles null/undefined gracefully
 *
 * @param {object} target - Base object with defaults
 * @param {object} source - Override object (takes precedence)
 * @returns {object} Merged object
 */
function deepMerge(target, source) {
  if (source == null) return target;
  if (target == null) return source;

  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
        result[key] = deepMerge(targetValue, sourceValue);
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Load and validate naming configuration
 *
 * - Reads `naming` section from project config
 * - Deep merges with defaults for backward compatibility
 * - Validates against Zod schema
 * - Caches result for performance
 *
 * @returns {import('../schema/naming-config.schema.ts').BackendNamingConfig}
 */
function loadNamingConfig() {
  // Get naming section from project config (may be undefined)
  const rawConfig = projectConfig?.naming;

  // If no config, use defaults
  if (!rawConfig) {
    return BackendNamingConfigSchema.parse(DEFAULT_BACKEND_NAMING);
  }

  // Deep merge user config with defaults
  const merged = deepMerge(DEFAULT_BACKEND_NAMING, rawConfig);

  // Validate and return
  try {
    return BackendNamingConfigSchema.parse(merged);
  } catch (error) {
    console.error('Invalid naming configuration:');
    if (error.errors) {
      for (const err of error.errors) {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      }
    }
    throw new Error(
      `Failed to load naming configuration: ${error.message}\n` +
        'Check your codegen.config.yaml naming section.'
    );
  }
}

// ============================================================================
// Cached Configuration
// ============================================================================

// Load config once at module initialization
let _cachedConfig = null;

/**
 * Get the naming configuration
 *
 * Returns cached, validated config with all defaults applied.
 * First call loads and validates; subsequent calls return cached value.
 *
 * NOTE: Config is cached at first access. Changes to codegen.config.yaml
 * require restarting the CLI to take effect. Use clearNamingConfigCache()
 * in tests to reset the cache between test runs.
 *
 * @returns {import('../schema/naming-config.schema.ts').BackendNamingConfig}
 */
export function getNamingConfig() {
  if (_cachedConfig === null) {
    _cachedConfig = loadNamingConfig();
  }
  return _cachedConfig;
}

/**
 * Clear cached config (useful for testing)
 */
export function clearNamingConfigCache() {
  _cachedConfig = null;
}

// ============================================================================
// Layer Resolution
// ============================================================================

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
  const config = getNamingConfig();
  return resolveLayer(config, layer);
}

// ============================================================================
// Exports
// ============================================================================

export {
  DEFAULT_BACKEND_NAMING,
  deepMerge,
};

export default {
  getNamingConfig,
  resolveLayerNaming,
  clearNamingConfigCache,
  DEFAULT_BACKEND_NAMING,
};
