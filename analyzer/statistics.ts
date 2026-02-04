/**
 * Statistics
 *
 * Computes statistics about the domain model:
 * - Entity counts
 * - Field counts and type distribution
 * - Relationship counts and type distribution
 */

import type { ParsedEntity, DomainGraph, DomainStatistics } from './types';

/**
 * Compute domain statistics from the graph
 */
export function computeStatistics(graph: DomainGraph): DomainStatistics {
	const entities = Array.from(graph.entities.values());

	const fieldsByType: Record<string, number> = {};
	const relationshipsByType: Record<string, number> = {};
	let totalFields = 0;
	let totalRelationships = 0;
	let entitiesWithBehaviors = 0;

	for (const entity of entities) {
		totalFields += entity.fields.size;
		totalRelationships += entity.relationships.size;

		if (entity.behaviors.length > 0) {
			entitiesWithBehaviors++;
		}

		// Count fields by type
		for (const field of entity.fields.values()) {
			fieldsByType[field.type] = (fieldsByType[field.type] ?? 0) + 1;
		}

		// Count relationships by type
		for (const rel of entity.relationships.values()) {
			relationshipsByType[rel.type] = (relationshipsByType[rel.type] ?? 0) + 1;
		}
	}

	return {
		totalEntities: entities.length,
		totalFields,
		totalRelationships,
		fieldsByType,
		relationshipsByType,
		entitiesWithBehaviors,
		averageFieldsPerEntity: entities.length > 0 ? totalFields / entities.length : 0,
	};
}

/**
 * Get a breakdown of field properties
 */
export function getFieldBreakdown(graph: DomainGraph): {
	required: number;
	nullable: number;
	indexed: number;
	unique: number;
	withForeignKey: number;
	withConstraints: number;
} {
	let required = 0;
	let nullable = 0;
	let indexed = 0;
	let unique = 0;
	let withForeignKey = 0;
	let withConstraints = 0;

	for (const entity of graph.entities.values()) {
		for (const field of entity.fields.values()) {
			if (field.required) required++;
			if (field.nullable) nullable++;
			if (field.index) indexed++;
			if (field.unique) unique++;
			if (field.foreignKey) withForeignKey++;

			const hasConstraints =
				field.constraints.minLength !== undefined ||
				field.constraints.maxLength !== undefined ||
				field.constraints.min !== undefined ||
				field.constraints.max !== undefined;
			if (hasConstraints) withConstraints++;
		}
	}

	return { required, nullable, indexed, unique, withForeignKey, withConstraints };
}

/**
 * Get UI metadata coverage statistics
 */
export function getUiMetadataCoverage(graph: DomainGraph): {
	withLabel: number;
	withType: number;
	withGroup: number;
	withImportance: number;
	total: number;
} {
	let withLabel = 0;
	let withType = 0;
	let withGroup = 0;
	let withImportance = 0;
	let total = 0;

	for (const entity of graph.entities.values()) {
		for (const field of entity.fields.values()) {
			total++;
			if (field.ui.label) withLabel++;
			if (field.ui.type) withType++;
			if (field.ui.group) withGroup++;
			if (field.ui.importance) withImportance++;
		}
	}

	return { withLabel, withType, withGroup, withImportance, total };
}
