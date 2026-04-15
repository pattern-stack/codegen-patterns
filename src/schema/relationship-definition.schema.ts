import { z } from 'zod';

/**
 * Relationship Definition Schema
 *
 * Defines the YAML contract for first-class relationship entities — typed,
 * temporal, sourced junction tables between core entities.
 *
 * A relationship definition generates the same artifacts as an entity
 * (Drizzle schema, repository, DTOs, NestJS module, controller) but with
 * auto-generated FK columns, type enum, temporal fields, and source tracking.
 *
 * The relationship: block replaces entity: as the top-level discriminator.
 * The fields:, queries:, and behaviors: blocks reuse entity-definition schemas.
 *
 * See: docs/codegen-evolution-data-model/03-relationship-taxonomy.md
 * See: test/fixtures/relationships/ for examples
 */

// Re-use field and query schemas from entity-definition
// These are imported to avoid duplication — fields on a relationship
// work identically to fields on an entity.
import type { FieldDefinition, QueryDeclaration } from './entity-definition.schema.js';

// ============================================================================
// Relationship Type Definitions
// ============================================================================

/**
 * Direction metadata for a single relationship type.
 *
 * Required for self-referential relationships (person↔person, org↔org)
 * where direction can't be inferred from entity-type asymmetry.
 *
 * Three mutually exclusive modes:
 * - inverse: "from→to is called X, to→from is called Y"
 * - bidirectional: true — direction doesn't matter, query both sides
 * - directed: true — one-way, no inverse name (default if none specified)
 */
const TypeDirectionSchema = z
	.object({
		/** Name of the inverse type when viewed from the other direction */
		inverse: z.string().optional(),
		/** Both directions are equivalent — queries should check both FK columns */
		bidirectional: z.boolean().optional(),
		/** Explicitly directed, no named inverse (default behavior) */
		directed: z.boolean().optional(),
	})
	.refine(
		(data) => {
			const set = [data.inverse, data.bidirectional, data.directed].filter(
				(v) => v !== undefined,
			);
			return set.length === 1;
		},
		{
			message:
				'Exactly one of inverse, bidirectional, or directed must be specified',
		},
	);

export type TypeDirection = z.infer<typeof TypeDirectionSchema>;

/**
 * Relationship types can be declared in two forms:
 *
 * 1. Simple list — for cross-type relationships where direction is
 *    unambiguous from entity asymmetry:
 *    types: [employed_by, advises, board_member]
 *
 * 2. Object map — for self-referential or when types need direction metadata:
 *    types:
 *      reporting:
 *        inverse: management
 *      network:
 *        bidirectional: true
 *
 * The simple list is sugar for "all directed from→to, no inverses."
 */
const RelationshipTypesSchema = z.union([
	// Simple list: all types are directed from→to
	z.array(z.string().regex(/^[a-z][a-z0-9_]*$/, 'Type must be snake_case')),
	// Object map: each type has direction metadata
	z.record(
		z.string().regex(/^[a-z][a-z0-9_]*$/, 'Type key must be snake_case'),
		TypeDirectionSchema,
	),
]);

export type RelationshipTypes = z.infer<typeof RelationshipTypesSchema>;

// ============================================================================
// On-Delete Semantics (ADR-021)
// ============================================================================

const OnDeleteActionSchema = z
	.enum(['restrict', 'cascade', 'set_null', 'no_action'])
	.default('restrict');

export type OnDeleteAction = z.infer<typeof OnDeleteActionSchema>;

// ============================================================================
// Relationship Configuration Block
// ============================================================================

/**
 * The relationship: block — top-level config for a relationship definition.
 *
 * Establishes the two endpoints, type taxonomy, and behavioral flags.
 * Auto-generates FK columns, type enum, temporal fields, source tracking,
 * and timestamps based on configuration.
 */
const RelationshipConfigSchema = z
	.object({
		/** Relationship name (snake_case). Used for class/file naming. */
		name: z.string().regex(
			/^[a-z][a-z0-9_]*$/,
			'Relationship name must be snake_case',
		),

		/** Database table name. Defaults to {name}s if not specified. */
		table: z
			.string()
			.regex(/^[a-z][a-z0-9_]*$/, 'Table must be snake_case')
			.optional(),

		/** The "from" entity — generates {entity}_id FK column (subject). */
		from: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Entity name must be snake_case'),

		/** The "to" entity — generates {entity}_id FK column (object). */
		to: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Entity name must be snake_case'),

		/**
		 * Relationship subtypes. Optional — omit for untyped junctions.
		 * When present, generates a `type` enum column on the junction table.
		 *
		 * Simple list: all types are directed (from→to). Use for cross-type
		 * relationships where entity asymmetry makes direction obvious.
		 *
		 * Object map: each type declares its own direction metadata.
		 * Required for self-referential relationships (from === to).
		 */
		types: RelationshipTypesSchema.optional(),

		/**
		 * Generate temporal validity fields: valid_from (date), valid_to (date?),
		 * is_current (boolean, denormalized for query performance).
		 * Default: true
		 */
		temporal: z.boolean().default(true),

		/**
		 * Generate source tracking fields: source (enum), confidence (decimal 0-1).
		 * Default: true
		 */
		sourced: z.boolean().default(true),

		/** on_delete action for the "from" endpoint FK. Default: restrict */
		on_delete_from: OnDeleteActionSchema.optional(),

		/** on_delete action for the "to" endpoint FK. Default: restrict */
		on_delete_to: OnDeleteActionSchema.optional(),

		/**
		 * Override the default unique constraint columns.
		 *
		 * Defaults:
		 * - Typed: [from_id, to_id, type]
		 * - Typed + temporal: [from_id, to_id, type, valid_from]
		 * - Untyped: [from_id, to_id]
		 *
		 * Use this when the default doesn't fit — e.g., allowing multiple
		 * relationships of the same type between the same entities at different times.
		 */
		unique_on: z.array(z.string()).optional(),
	})
	.strict();

export type RelationshipConfig = z.infer<typeof RelationshipConfigSchema>;

// ============================================================================
// Query Declaration (reuse from entity-definition)
// ============================================================================

/**
 * Same query declaration syntax as entities.
 * FK field names in `by:` use the auto-generated names:
 * - Cross-type: {entity}_id (e.g., person_id, organization_id)
 * - Self-referential: from_{entity}_id, to_{entity}_id
 */
const RelationshipQuerySchema = z.object({
	by: z.array(z.string()).min(1),
	unique: z.boolean().optional(),
	select: z.array(z.string()).optional(),
	order: z.string().optional(),
	limit: z.boolean().optional(),
});

// ============================================================================
// Field Definition (reuse from entity-definition)
// ============================================================================

// We import the type but need to re-reference the schema inline for Zod parsing.
// The actual FieldDefinitionSchema is defined in entity-definition.schema.ts.
// For now, we use z.record(z.string(), z.any()) and validate fields
// through the shared FieldDefinitionSchema at parse time.
//
// TODO: Extract FieldDefinitionSchema to a shared module so both
// entity-definition and relationship-definition can import it directly.

// ============================================================================
// Full Relationship Definition
// ============================================================================

/**
 * Complete relationship definition — the top-level shape of a relationship YAML file.
 *
 * Example (minimal):
 *   relationship:
 *     name: engagement_opportunity
 *     from: engagement
 *     to: opportunity
 *
 * Example (full):
 *   relationship:
 *     name: person_organization
 *     table: person_organizations
 *     from: person
 *     to: organization
 *     types: [employed_by, advises, board_member]
 *     temporal: true
 *     sourced: true
 *   fields:
 *     role_title:
 *       type: string
 *       nullable: true
 *   queries:
 *     - by: [person_id]
 */
export const RelationshipDefinitionSchema = z
	.object({
		/** Relationship configuration block */
		relationship: RelationshipConfigSchema,

		/**
		 * Additional fields beyond auto-generated ones.
		 * These describe the relationship, not either endpoint entity.
		 * Uses the same field definition schema as entity fields.
		 */
		fields: z.record(z.string(), z.any()).optional(),

		/** Declarative queries — same syntax as entity queries. */
		queries: z.array(RelationshipQuerySchema).optional(),
	})
	.strict()
	.refine(
		(data) => {
			// Self-referential relationships with types MUST use the object map form
			// so that direction metadata (inverse/bidirectional/directed) is explicit.
			if (data.relationship.from === data.relationship.to && data.relationship.types) {
				return !Array.isArray(data.relationship.types);
			}
			return true;
		},
		{
			message:
				'Self-referential relationships must use the object map form for types ' +
				'(with inverse/bidirectional/directed metadata), not a simple list',
			path: ['relationship', 'types'],
		},
	)
	.refine(
		(data) => {
			// Reject fields: keys that collide with auto-generated column names.
			// The reserved set is dynamic — depends on the relationship config.
			if (!data.fields) return true;

			const reserved = getReservedColumnNames(data.relationship);
			const collisions = Object.keys(data.fields).filter((key) =>
				reserved.has(key),
			);
			return collisions.length === 0;
		},
		{
			message:
				'fields: contains keys that collide with auto-generated columns. ' +
				'Reserved names depend on config (type, valid_from, valid_to, ' +
				'is_current, source, confidence, id, created_at, updated_at, and FK columns).',
			path: ['fields'],
		},
	);

export type RelationshipDefinition = z.infer<
	typeof RelationshipDefinitionSchema
>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateRelationshipDefinition(
	data: unknown,
): RelationshipDefinition {
	return RelationshipDefinitionSchema.parse(data);
}

export function safeValidateRelationshipDefinition(data: unknown): {
	success: boolean;
	data?: RelationshipDefinition;
	error?: z.ZodError;
} {
	const result = RelationshipDefinitionSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}

// ============================================================================
// Reserved Column Names
// ============================================================================

/**
 * Returns the set of column names that are auto-generated for a relationship
 * and therefore cannot be used as custom field names.
 *
 * The set is dynamic — it depends on the relationship config:
 * - Always: id, created_at, updated_at, and both FK columns
 * - If types: present → type
 * - If temporal: true → valid_from, valid_to, is_current
 * - If sourced: true → source, confidence
 */
export function getReservedColumnNames(config: RelationshipConfig): Set<string> {
	const { fromColumn, toColumn } = deriveRelationshipFKColumns(config);
	const reserved = new Set([
		'id',
		'created_at',
		'updated_at',
		fromColumn,
		toColumn,
	]);

	if (config.types) {
		reserved.add('type');
	}
	if (config.temporal) {
		reserved.add('valid_from');
		reserved.add('valid_to');
		reserved.add('is_current');
	}
	if (config.sourced) {
		reserved.add('source');
		reserved.add('confidence');
	}

	return reserved;
}

// ============================================================================
// Auto-Generated Field Helpers
// ============================================================================

/**
 * Derives the FK column names for a relationship.
 *
 * Cross-type (from !== to):
 *   from: person, to: organization → person_id, organization_id
 *
 * Self-referential (from === to):
 *   from: person, to: person → from_person_id, to_person_id
 */
export function deriveRelationshipFKColumns(config: RelationshipConfig): {
	fromColumn: string;
	toColumn: string;
} {
	if (config.from === config.to) {
		return {
			fromColumn: `from_${config.from}_id`,
			toColumn: `to_${config.to}_id`,
		};
	}
	return {
		fromColumn: `${config.from}_id`,
		toColumn: `${config.to}_id`,
	};
}

/**
 * Derives the default table name if not explicitly specified.
 * Uses the relationship name + 's' suffix.
 */
export function deriveTableName(config: RelationshipConfig): string {
	return config.table ?? `${config.name}s`;
}

/**
 * Collects all type names from a types declaration.
 * Handles both simple list and object map forms.
 */
export function collectTypeNames(
	types: RelationshipTypes | undefined,
): string[] {
	if (!types) return [];
	if (Array.isArray(types)) return types;
	return Object.keys(types);
}

/**
 * Collects all inverse type names from a types declaration.
 * Only applicable for object map form with inverse metadata.
 */
export function collectInverseNames(
	types: RelationshipTypes | undefined,
): string[] {
	if (!types || Array.isArray(types)) return [];
	return Object.values(types)
		.map((dir) => (dir as TypeDirection & { inverse?: string }).inverse)
		.filter((v): v is string => v !== undefined);
}

/**
 * Determines the default unique constraint columns.
 *
 * Logic:
 * - Typed + temporal: [from_id, to_id, type, valid_from]
 * - Typed: [from_id, to_id, type]
 * - Untyped: [from_id, to_id]
 */
export function deriveUniqueConstraint(config: RelationshipConfig): string[] {
	if (config.unique_on) return config.unique_on;

	const { fromColumn, toColumn } = deriveRelationshipFKColumns(config);
	const columns = [fromColumn, toColumn];

	if (config.types) {
		columns.push('type');
	}
	if (config.temporal && config.types) {
		columns.push('valid_from');
	}

	return columns;
}
