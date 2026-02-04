/**
 * Behavior Registry - Central registry for all entity behaviors
 *
 * Provides functions to:
 * - Get behavior definitions by name
 * - Validate behavior configurations
 * - Resolve fields added by behaviors
 */

import { softDeleteBehavior } from './soft-delete';
import { timestampsBehavior } from './timestamps';
import type {
	BehaviorConfig,
	BehaviorDefinition,
	BehaviorField,
	NormalizedBehaviorConfig,
	ResolvedBehaviors,
	ValidationResult,
} from './types';
import { userTrackingBehavior } from './user-tracking';

// ============================================================================
// Behavior Registry
// ============================================================================

const behaviorRegistry = new Map<string, BehaviorDefinition>([
	['timestamps', timestampsBehavior],
	['soft_delete', softDeleteBehavior],
	['user_tracking', userTrackingBehavior],
]);

/**
 * Get a behavior definition by name
 */
export function getBehavior(name: string): BehaviorDefinition | undefined {
	return behaviorRegistry.get(name);
}

/**
 * Get all registered behavior names
 */
export function getAllBehaviorNames(): string[] {
	return Array.from(behaviorRegistry.keys());
}

// ============================================================================
// Config Normalization
// ============================================================================

/**
 * Normalize a behavior config to always have name and options
 */
export function normalizeBehaviorConfig(
	config: BehaviorConfig,
): NormalizedBehaviorConfig {
	if (typeof config === 'string') {
		return { name: config, options: {} };
	}
	return { name: config.name, options: config.options ?? {} };
}

/**
 * Normalize an array of behavior configs
 */
export function normalizeBehaviorConfigs(
	configs: BehaviorConfig[],
): NormalizedBehaviorConfig[] {
	return configs.map(normalizeBehaviorConfig);
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a set of behavior configurations
 * Checks for unknown behaviors, missing dependencies, and conflicts
 */
export function validateBehaviors(configs: BehaviorConfig[]): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const normalized = normalizeBehaviorConfigs(configs);
	const enabledNames = new Set(normalized.map((c) => c.name));

	for (const config of normalized) {
		const behavior = getBehavior(config.name);

		// Check behavior exists
		if (!behavior) {
			errors.push(`Unknown behavior: '${config.name}'`);
			continue;
		}

		// Check dependencies
		if (behavior.requires) {
			for (const req of behavior.requires) {
				if (!enabledNames.has(req)) {
					errors.push(
						`Behavior '${config.name}' requires '${req}' which is not enabled`,
					);
				}
			}
		}

		// Check conflicts
		if (behavior.conflicts) {
			for (const conflict of behavior.conflicts) {
				if (enabledNames.has(conflict)) {
					errors.push(
						`Behavior '${config.name}' conflicts with '${conflict}'`,
					);
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

// ============================================================================
// Field Resolution
// ============================================================================

/**
 * Get all fields added by a set of behaviors
 */
export function resolveBehaviorFields(
	configs: BehaviorConfig[],
): BehaviorField[] {
	const normalized = normalizeBehaviorConfigs(configs);
	const fields: BehaviorField[] = [];
	const addedFieldNames = new Set<string>();

	for (const config of normalized) {
		const behavior = getBehavior(config.name);
		if (!behavior) continue;

		for (const field of behavior.fields) {
			// Avoid duplicate fields if multiple behaviors add the same field
			if (!addedFieldNames.has(field.name)) {
				fields.push(field);
				addedFieldNames.add(field.name);
			}
		}
	}

	return fields;
}

/**
 * Get all Drizzle imports needed by a set of behaviors
 */
export function resolveBehaviorDrizzleImports(
	configs: BehaviorConfig[],
): string[] {
	const normalized = normalizeBehaviorConfigs(configs);
	const imports = new Set<string>();

	for (const config of normalized) {
		const behavior = getBehavior(config.name);
		if (!behavior) continue;

		for (const imp of behavior.drizzleImports) {
			imports.add(imp);
		}
	}

	return Array.from(imports).sort();
}

// ============================================================================
// Full Resolution
// ============================================================================

/**
 * Resolve all behavior data for templates
 */
export function resolveBehaviors(configs: BehaviorConfig[]): ResolvedBehaviors {
	const normalized = normalizeBehaviorConfigs(configs);
	const fields = resolveBehaviorFields(configs);
	const drizzleImports = resolveBehaviorDrizzleImports(configs);

	const enabledNames = new Set(normalized.map((c) => c.name));

	const hasTimestamps = enabledNames.has('timestamps');
	const hasSoftDelete = enabledNames.has('soft_delete');
	const hasUserTracking = enabledNames.has('user_tracking');

	return {
		configs: normalized,
		fields,
		drizzleImports,
		repositoryConfig: {
			timestamps: hasTimestamps,
			softDelete: hasSoftDelete,
			userTracking: hasUserTracking,
			versionable: false, // Future behavior
		},
		hasBehaviors: normalized.length > 0,
		hasTimestamps,
		hasSoftDelete,
		hasUserTracking,
	};
}

// ============================================================================
// Exports
// ============================================================================

export type {
	BehaviorConfig,
	BehaviorDefinition,
	BehaviorField,
	NormalizedBehaviorConfig,
	ResolvedBehaviors,
	ValidationResult,
} from './types';

export { timestampsBehavior } from './timestamps';
export { softDeleteBehavior } from './soft-delete';
export { userTrackingBehavior } from './user-tracking';
