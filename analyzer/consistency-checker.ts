/**
 * Consistency Checker
 *
 * Performs various consistency checks on the domain model:
 * - Missing relationship targets
 * - Missing inverse relationships
 * - Missing indexes on filterable fields
 * - Orphan entities (no relationships)
 * - Circular dependencies
 * - Naming conventions
 * - Missing UI metadata
 */

import type { ParsedEntity, DomainGraph, AnalysisIssue } from './types';
import { findOrphanEntities, findCircularDependencies } from './graph-builder';

/**
 * Run all consistency checks on the domain graph
 */
export function checkConsistency(graph: DomainGraph): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	// Check each entity
	for (const [name, entity] of graph.entities) {
		issues.push(...checkEntityConsistency(entity));
		issues.push(...checkRelationshipConsistency(entity, graph));
		issues.push(...checkNamingConventions(entity));
		issues.push(...checkMissingIndexes(entity));
		issues.push(...checkUiMetadata(entity));
	}

	// Check graph-level issues
	issues.push(...checkOrphanEntities(graph));
	issues.push(...checkCircularReferences(graph));
	issues.push(...checkMissingInverses(graph));

	return issues;
}

/**
 * Check entity-level consistency
 */
function checkEntityConsistency(entity: ParsedEntity): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	// Check for missing primary key
	if (!entity.fields.has('id')) {
		issues.push({
			severity: 'info',
			type: 'missing_id',
			entity: entity.name,
			message: 'Entity missing standard "id" field',
			suggestion: 'Add an "id" field with type "uuid"',
		});
	}

	// Check for missing timestamps
	const hasCreatedAt = entity.fields.has('created_at');
	const hasTimestampsBehavior = entity.behaviors.includes('timestamps');

	if (!hasCreatedAt && !hasTimestampsBehavior) {
		issues.push({
			severity: 'info',
			type: 'missing_timestamps',
			entity: entity.name,
			message: 'Entity missing "created_at" field and "timestamps" behavior',
			suggestion: 'Add "timestamps" to behaviors or add created_at/updated_at fields',
		});
	}

	return issues;
}

/**
 * Check relationship consistency
 */
function checkRelationshipConsistency(
	entity: ParsedEntity,
	graph: DomainGraph
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	for (const [relName, rel] of entity.relationships) {
		// Check for belongs_to without matching foreign key field
		if (rel.type === 'belongs_to') {
			const fkField = entity.fields.get(rel.foreignKey);
			if (!fkField) {
				issues.push({
					severity: 'warning',
					type: 'missing_fk_field',
					entity: entity.name,
					field: relName,
					message: `Relationship "${relName}" references foreign key "${rel.foreignKey}" but field doesn't exist`,
					suggestion: `Add field "${rel.foreignKey}" with foreign_key reference`,
				});
			}
		}

		// Check for has_many relationships - target should have the FK field
		if (rel.type === 'has_many' || rel.type === 'has_one') {
			const targetEntity = graph.entities.get(rel.target);
			if (targetEntity) {
				const targetFkField = targetEntity.fields.get(rel.foreignKey);
				if (!targetFkField) {
					issues.push({
						severity: 'warning',
						type: 'missing_target_fk',
						entity: entity.name,
						field: relName,
						message: `Relationship "${relName}" expects foreign key "${rel.foreignKey}" on "${rel.target}" but field doesn't exist`,
						suggestion: `Add field "${rel.foreignKey}" to "${rel.target}" entity`,
					});
				}
			}
		}
	}

	return issues;
}

/**
 * Check naming conventions
 */
function checkNamingConventions(entity: ParsedEntity): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	// Entity name should be lowercase snake_case
	if (entity.name !== entity.name.toLowerCase()) {
		issues.push({
			severity: 'warning',
			type: 'naming_convention',
			entity: entity.name,
			message: 'Entity name should be lowercase',
			suggestion: `Use "${entity.name.toLowerCase()}"`,
		});
	}

	// Check field naming
	for (const [fieldName] of entity.fields) {
		if (fieldName !== fieldName.toLowerCase()) {
			issues.push({
				severity: 'warning',
				type: 'naming_convention',
				entity: entity.name,
				field: fieldName,
				message: 'Field name should be snake_case',
				suggestion: `Use "${toSnakeCase(fieldName)}"`,
			});
		}
	}

	// Check relationship naming
	for (const [relName] of entity.relationships) {
		if (relName !== relName.toLowerCase()) {
			issues.push({
				severity: 'warning',
				type: 'naming_convention',
				entity: entity.name,
				field: relName,
				message: 'Relationship name should be snake_case',
				suggestion: `Use "${toSnakeCase(relName)}"`,
			});
		}
	}

	return issues;
}

/**
 * Check for missing indexes on filterable fields
 */
function checkMissingIndexes(entity: ParsedEntity): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	for (const [fieldName, field] of entity.fields) {
		// Check if field is marked as filterable but has no index
		if (field.ui.filterable && !field.index && !field.unique) {
			issues.push({
				severity: 'warning',
				type: 'missing_index',
				entity: entity.name,
				field: fieldName,
				message: `Field "${fieldName}" is filterable but has no index`,
				suggestion: 'Add "index: true" to improve query performance',
			});
		}

		// Foreign key fields should typically have an index
		if (field.foreignKey && !field.index && !field.unique) {
			issues.push({
				severity: 'info',
				type: 'missing_fk_index',
				entity: entity.name,
				field: fieldName,
				message: `Foreign key field "${fieldName}" has no index`,
				suggestion: 'Add "index: true" for better join performance',
			});
		}
	}

	return issues;
}

/**
 * Check for missing UI metadata
 */
function checkUiMetadata(entity: ParsedEntity): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	// System fields that don't need UI metadata
	const systemFields = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'tenant_id']);

	for (const [fieldName, field] of entity.fields) {
		if (systemFields.has(fieldName)) continue;

		const hasAnyUiMeta =
			field.ui.label !== undefined ||
			field.ui.type !== undefined ||
			field.ui.group !== undefined;

		if (!hasAnyUiMeta) {
			issues.push({
				severity: 'info',
				type: 'missing_ui_metadata',
				entity: entity.name,
				field: fieldName,
				message: `Field "${fieldName}" has no UI metadata`,
				suggestion: 'Add ui_label, ui_type, ui_group for better admin panel display',
			});
		}
	}

	return issues;
}

/**
 * Check for orphan entities
 */
function checkOrphanEntities(graph: DomainGraph): AnalysisIssue[] {
	const orphans = findOrphanEntities(graph);
	return orphans.map((name) => ({
		severity: 'info' as const,
		type: 'orphan_entity',
		entity: name,
		message: `Entity "${name}" has no relationships to other entities`,
		suggestion: 'Consider if this entity should be related to others',
	}));
}

/**
 * Check for circular references
 */
function checkCircularReferences(graph: DomainGraph): AnalysisIssue[] {
	const cycles = findCircularDependencies(graph);
	return cycles.map((cycle) => ({
		severity: 'info' as const,
		type: 'circular_dependency',
		entity: cycle[0],
		message: `Circular reference detected: ${cycle.join(' -> ')}`,
		suggestion: 'Verify this is intentional (e.g., self-referential hierarchy)',
	}));
}

/**
 * Check for missing inverse relationships
 */
function checkMissingInverses(graph: DomainGraph): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	for (const edge of graph.edges) {
		const { from, to, relationship } = edge;
		const targetEntity = graph.entities.get(to);
		if (!targetEntity) continue;

		// Check if target has an inverse relationship back to source
		const hasInverse = Array.from(targetEntity.relationships.values()).some(
			(rel) => rel.target === from
		);

		// belongs_to relationships typically don't need explicit inverses
		// (the has_many on the other side serves as the inverse)
		if (!hasInverse && relationship.type !== 'belongs_to') {
			issues.push({
				severity: 'info',
				type: 'missing_inverse',
				entity: from,
				field: relationship.name,
				message: `Relationship "${relationship.name}" to "${to}" has no inverse defined on target`,
				suggestion: `Add inverse relationship on "${to}" pointing back to "${from}"`,
			});
		}
	}

	return issues;
}

/**
 * Convert string to snake_case
 */
function toSnakeCase(str: string): string {
	return str
		.replace(/([A-Z])/g, '_$1')
		.toLowerCase()
		.replace(/^_/, '');
}
