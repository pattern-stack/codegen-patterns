/**
 * Config Loader - Loads and parses codegen.config.yaml
 *
 * Provides global configuration for code generation including
 * behavior strategy (base_class vs inline).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ============================================================================
// Config Schema
// ============================================================================

const BehaviorStrategySchema = z.enum(['base_class', 'inline']);

export type BehaviorStrategy = z.infer<typeof BehaviorStrategySchema>;

const BehaviorsConfigSchema = z.object({
	strategy: BehaviorStrategySchema.default('base_class'),
});

const CodegenConfigSchema = z.object({
	behaviors: BehaviorsConfigSchema.optional().default({ strategy: 'base_class' }),
});

export type CodegenConfig = z.infer<typeof CodegenConfigSchema>;

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: CodegenConfig = {
	behaviors: {
		strategy: 'base_class',
	},
};

// ============================================================================
// Config Loader
// ============================================================================

/**
 * Load codegen configuration from codegen.config.yaml
 * Falls back to defaults if file not found or invalid
 *
 * @param cwd - Working directory to search from (default: process.cwd())
 * @returns Parsed and validated config
 */
export function loadCodegenConfig(cwd: string = process.cwd()): CodegenConfig {
	const configPath = resolve(cwd, 'codegen.config.yaml');

	// Return defaults if no config file
	if (!existsSync(configPath)) {
		return DEFAULT_CONFIG;
	}

	try {
		const content = readFileSync(configPath, 'utf-8');
		const parsed = parseYaml(content);
		const result = CodegenConfigSchema.safeParse(parsed);

		if (result.success) {
			return result.data;
		}

		// Log validation errors but use defaults
		console.warn(
			`Warning: Invalid codegen.config.yaml, using defaults. Errors:`,
		);
		for (const error of result.error.errors) {
			console.warn(`  - ${error.path.join('.')}: ${error.message}`);
		}
		return DEFAULT_CONFIG;
	} catch (error) {
		// Log parse errors but use defaults
		console.warn(
			`Warning: Failed to parse codegen.config.yaml, using defaults.`,
		);
		if (error instanceof Error) {
			console.warn(`  ${error.message}`);
		}
		return DEFAULT_CONFIG;
	}
}

/**
 * Get the behavior strategy for an entity
 * Per-entity override takes precedence over global config
 *
 * @param entityOverride - Per-entity behavior_strategy (from YAML)
 * @param globalConfig - Global codegen config
 * @returns Resolved behavior strategy
 */
export function resolveBehaviorStrategy(
	entityOverride?: string,
	globalConfig?: CodegenConfig,
): BehaviorStrategy {
	// Per-entity override takes precedence
	if (entityOverride) {
		const result = BehaviorStrategySchema.safeParse(entityOverride);
		if (result.success) {
			return result.data;
		}
	}

	// Fall back to global config
	return globalConfig?.behaviors?.strategy ?? DEFAULT_CONFIG.behaviors.strategy;
}
