/**
 * Shared configuration loader for codegen
 *
 * Loads and caches codegen.config.yaml once, shared by all config modules.
 * Validates the `pipelines` block with Zod if present; passes all other
 * config through as-is for backward compatibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { PipelinesConfigSchema, type PipelinesConfig } from '../schema/pipelines-config.schema.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * Typed representation of the `pipelines` block.
 * Only this block is Zod-validated; the rest of the config is untyped.
 */
export interface ProjectConfig {
  pipelines?: PipelinesConfig;
  [key: string]: unknown;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Load project-specific codegen configuration from codegen.config.yaml.
 * Returns null if the config file doesn't exist (falls back to defaults).
 *
 * If a `pipelines` block is present it is parsed and validated through
 * PipelinesConfigSchema. A warning is printed on validation failure and
 * the raw value is preserved so nothing else breaks.
 */
function loadProjectConfig(cwd = process.cwd()): ProjectConfig | null {
  const configPath = path.resolve(cwd, 'codegen.config.yaml');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = yaml.parse(content) as Record<string, unknown>;

    // Validate the pipelines block if present
    if (raw && typeof raw === 'object' && 'pipelines' in raw && raw.pipelines != null) {
      const result = PipelinesConfigSchema.safeParse(raw.pipelines);
      if (result.success) {
        raw.pipelines = result.data;
      } else {
        console.warn(
          `Warning: codegen.config.yaml has an invalid "pipelines" block:\n` +
            result.error.issues
              .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
              .join('\n')
        );
        // Leave raw.pipelines as-is so callers still get something
      }
    }

    return raw as ProjectConfig;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Failed to load codegen.config.yaml: ${msg}`);
    return null;
  }
}

// Load project config once at module initialization
export const projectConfig: ProjectConfig | null = loadProjectConfig();

export default projectConfig;
