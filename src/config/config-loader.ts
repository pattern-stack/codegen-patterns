/**
 * Shared configuration loader for codegen
 *
 * Loads and caches codegen.config.yaml once, shared by all config modules.
 * Validates the `generate`, `patterns`, and `runtime` blocks with Zod; passes
 * all other config through as-is.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import {
  GenerateConfigSchema,
  PatternsConfigSchema,
  RuntimeModeSchema,
  type GenerateConfig,
  type PatternsConfig,
  type RuntimeMode,
} from '../schema/pipelines-config.schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Typed representation of the Zod-validated config blocks (`generate`,
 * `patterns`, `runtime`). The rest of the config is untyped passthrough.
 */
export interface ProjectConfig {
  generate?: GenerateConfig;
  /**
   * Array of globs (relative to project root) that `loadAppPatterns()`
   * expands to discover app-defined patterns (ADR-031, PATTERN-5).
   * Absent ⇒ defaults to `['src/patterns/*.pattern.ts']`.
   */
  patterns?: PatternsConfig;
  /**
   * Which copy of the framework runtime generated code imports from (ADR-037).
   * `package` (default) ⇒ `@pattern-stack/codegen/*`; `vendored` ⇒ `@shared/*`.
   * Always populated after load (defaulted to `package` when the key is absent).
   */
  runtime?: RuntimeMode;
  [key: string]: unknown;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Load project-specific codegen configuration from codegen.config.yaml.
 * Returns null if the config file doesn't exist (falls back to defaults).
 *
 * The `generate`, `patterns`, and `runtime` blocks are validated through their
 * Zod schemas (defaults applied even when absent); a warning is printed on
 * validation failure and the raw value is preserved so nothing else breaks.
 */
function loadProjectConfig(cwd = process.cwd()): ProjectConfig | null {
  const configPath = path.resolve(cwd, 'codegen.config.yaml');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = yaml.parse(content) as Record<string, unknown>;

    // Validate the generate block (always — we want defaults applied even when absent)
    const rawGenerate = raw && typeof raw === 'object' && 'generate' in raw ? raw.generate : undefined;
    const generateResult = GenerateConfigSchema.safeParse(rawGenerate ?? {});
    if (generateResult.success) {
      raw.generate = generateResult.data;
    } else {
      console.warn(
        `Warning: codegen.config.yaml has an invalid "generate" block:\n` +
          generateResult.error.issues
            .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n')
      );
    }

    // Validate the patterns block (always — we want the default glob applied
    // even when the key is absent).
    const rawPatterns =
      raw && typeof raw === 'object' && 'patterns' in raw ? raw.patterns : undefined;
    const patternsResult = PatternsConfigSchema.safeParse(rawPatterns);
    if (patternsResult.success) {
      raw.patterns = patternsResult.data;
    } else {
      console.warn(
        `Warning: codegen.config.yaml has an invalid "patterns" block:\n` +
          patternsResult.error.issues
            .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n')
      );
    }

    // Validate the runtime mode (always — default to `package` when absent; ADR-037).
    const rawRuntime =
      raw && typeof raw === 'object' && 'runtime' in raw ? raw.runtime : undefined;
    const runtimeResult = RuntimeModeSchema.safeParse(rawRuntime);
    if (runtimeResult.success) {
      raw.runtime = runtimeResult.data;
    } else {
      console.warn(
        `Warning: codegen.config.yaml has an invalid "runtime" value ` +
          `(expected 'package' or 'vendored'); falling back to 'package'.`
      );
      raw.runtime = 'package';
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
