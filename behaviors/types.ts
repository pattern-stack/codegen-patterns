/**
 * Behavior Types - Type definitions for entity behaviors
 *
 * Behaviors are declarative patterns that add cross-cutting concerns
 * to entities (timestamps, soft delete, user tracking, etc.)
 */

import type { FieldType } from '../schema/entity-definition.schema';

// ============================================================================
// Behavior Field
// ============================================================================

/**
 * A field added by a behavior
 */
export interface BehaviorField {
	/** Field name (snake_case for DB column) */
	name: string;
	/** Field name in camelCase for TypeScript */
	camelName: string;
	/** YAML/TypeScript field type */
	type: FieldType;
	/** TypeScript type string */
	tsType: string;
	/** Drizzle column type */
	drizzleType: string;
	/** Drizzle imports needed for this field */
	drizzleImports: string[];
	/** Zod schema string */
	zodType: string;
	/** Whether field allows NULL */
	nullable: boolean;
	/** Default value (if any) */
	default?: unknown;
	/** Whether this is a FK reference */
	foreignKey?: string;
	/** UI metadata */
	ui?: {
		label: string;
		type: string;
		importance: 'primary' | 'secondary' | 'tertiary';
		group: string;
		visible: boolean;
	};
}

// ============================================================================
// Behavior Options
// ============================================================================

/**
 * Options passed to a behavior from YAML
 */
export interface BehaviorOptions {
	[key: string]: unknown;
}

// ============================================================================
// Behavior Configuration (from YAML)
// ============================================================================

/**
 * Behavior config as parsed from entity YAML
 * Can be a simple string or an object with options
 */
export type BehaviorConfig =
	| string
	| {
			name: string;
			options?: BehaviorOptions;
	  };

/**
 * Normalized behavior config (always has name and options)
 */
export interface NormalizedBehaviorConfig {
	name: string;
	options: BehaviorOptions;
}

// ============================================================================
// Behavior Definition
// ============================================================================

/**
 * Definition of a behavior's capabilities and requirements
 */
export interface BehaviorDefinition {
	/** Unique behavior name */
	name: string;

	/** Human-readable description */
	description: string;

	/** Fields added by this behavior */
	fields: BehaviorField[];

	/** Drizzle imports needed */
	drizzleImports: string[];

	/** Other behaviors this depends on */
	requires?: string[];

	/** Behaviors that conflict with this one */
	conflicts?: string[];

	/** Base class methods enabled by this behavior */
	methods?: string[];

	/** Behavior config key for BaseRepository (e.g., 'timestamps') */
	configKey: string;
}

// ============================================================================
// Validation Result
// ============================================================================

/**
 * Result of validating a set of behaviors
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

// ============================================================================
// Resolved Behaviors
// ============================================================================

/**
 * Resolved behavior data for templates
 */
export interface ResolvedBehaviors {
	/** All behavior configs normalized */
	configs: NormalizedBehaviorConfig[];

	/** All fields added by behaviors */
	fields: BehaviorField[];

	/** All Drizzle imports needed */
	drizzleImports: string[];

	/** Config object for BaseRepository behaviors property */
	repositoryConfig: {
		timestamps: boolean;
		softDelete: boolean;
		userTracking: boolean;
		versionable: boolean;
	};

	/** Whether any behaviors are enabled */
	hasBehaviors: boolean;

	/** Individual behavior flags */
	hasTimestamps: boolean;
	hasSoftDelete: boolean;
	hasUserTracking: boolean;
}
