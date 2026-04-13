import { z } from 'zod';

/**
 * Relationship Types Schema
 *
 * Defines the DSL for configuring valid entity relationships in the Context Engine.
 * This schema validates the relationship_types.yaml file and generates TypeScript
 * types for runtime validation.
 */

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Valid entity types that can participate in relationships
 */
export const EntityTypeSchema = z.enum([
	'person',
	'organization',
	'opportunity',
	'engagement',
]);

export type EntityType = z.infer<typeof EntityTypeSchema>;

/**
 * All valid entity types as a constant array
 */
export const ENTITY_TYPES = EntityTypeSchema.options;

// ============================================================================
// Relationship Direction
// ============================================================================

/**
 * Direction of the relationship:
 * - directed: from → to (e.g., person works_at organization)
 * - bidirectional: both directions equivalent (e.g., person works_with person)
 */
export const RelationshipDirectionSchema = z.enum(['directed', 'bidirectional']);

export type RelationshipDirection = z.infer<typeof RelationshipDirectionSchema>;

// ============================================================================
// Metadata Schema Property
// ============================================================================

/**
 * Schema for metadata properties that can be attached to relationships
 */
const MetadataPropertySchema = z.object({
	type: z.enum(['string', 'number', 'boolean', 'json']),
	choices: z.array(z.string()).optional(),
	description: z.string().optional(),
	required: z.boolean().optional(),
});

export type MetadataProperty = z.infer<typeof MetadataPropertySchema>;

// ============================================================================
// Relationship Type Definition
// ============================================================================

/**
 * Definition of a single relationship type
 */
export const RelationshipTypeDefSchema = z.object({
	// Which entity types can be on the "from" side
	from: z.array(EntityTypeSchema).min(1),
	// Which entity types can be on the "to" side
	to: z.array(EntityTypeSchema).min(1),
	// Direction of the relationship
	direction: RelationshipDirectionSchema,
	// Whether the relationship tracks temporal validity (valid_from/valid_to)
	temporal: z.boolean().default(true),
	// Human-readable description
	description: z.string().optional(),
	// Optional metadata schema for additional relationship properties
	metadata_schema: z.record(MetadataPropertySchema).optional(),
});

export type RelationshipTypeDef = z.infer<typeof RelationshipTypeDefSchema>;

// ============================================================================
// Relationship Types Configuration
// ============================================================================

/**
 * Full relationship types configuration file schema
 */
export const RelationshipTypesConfigSchema = z.object({
	// List of valid entity types (for documentation/validation)
	entity_types: z.array(EntityTypeSchema).optional(),
	// Map of relationship type name to definition
	relationship_types: z.record(RelationshipTypeDefSchema),
});

export type RelationshipTypesConfig = z.infer<
	typeof RelationshipTypesConfigSchema
>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate a relationship types configuration
 */
export function validateRelationshipTypesConfig(
	data: unknown,
): RelationshipTypesConfig {
	return RelationshipTypesConfigSchema.parse(data);
}

/**
 * Safe validation that returns success/error instead of throwing
 */
export function safeValidateRelationshipTypesConfig(data: unknown): {
	success: boolean;
	data?: RelationshipTypesConfig;
	error?: z.ZodError;
} {
	const result = RelationshipTypesConfigSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}

// ============================================================================
// Runtime Validation Utilities
// ============================================================================

/**
 * Check if a relationship type is valid for the given from/to entity types
 */
export function isValidRelationship(
	config: RelationshipTypesConfig,
	relationshipType: string,
	fromType: EntityType,
	toType: EntityType,
): boolean {
	const typeDef = config.relationship_types[relationshipType];
	if (!typeDef) return false;

	return typeDef.from.includes(fromType) && typeDef.to.includes(toType);
}

/**
 * Get all valid relationship types for a given from entity type
 */
export function getValidRelationshipTypesFrom(
	config: RelationshipTypesConfig,
	fromType: EntityType,
): string[] {
	return Object.entries(config.relationship_types)
		.filter(([_, def]) => def.from.includes(fromType))
		.map(([name]) => name);
}

/**
 * Get all valid relationship types for a given to entity type
 */
export function getValidRelationshipTypesTo(
	config: RelationshipTypesConfig,
	toType: EntityType,
): string[] {
	return Object.entries(config.relationship_types)
		.filter(([_, def]) => def.to.includes(toType))
		.map(([name]) => name);
}

/**
 * Get the relationship type definition or throw if not found
 */
export function getRelationshipTypeDef(
	config: RelationshipTypesConfig,
	relationshipType: string,
): RelationshipTypeDef {
	const def = config.relationship_types[relationshipType];
	if (!def) {
		throw new Error(`Unknown relationship type: ${relationshipType}`);
	}
	return def;
}
