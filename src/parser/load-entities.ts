/**
 * Entity Loader
 *
 * Loads and parses all YAML entity files from a directory.
 * Reuses existing yaml-loader and entity-definition schema from codegen.
 */

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EntityFamily } from '../analyzer/types.js';
import {
	loadEntityFromYaml,
	loadRelationshipFromYaml,
	type LoadResult,
	type LoadError,
	type RelationshipLoadResult,
	type RelationshipLoadError,
} from '../utils/yaml-loader';
import type {
	ParsedEntity,
	ParsedEvent,
	ParsedField,
	ParsedProviderSync,
	ParsedQuery,
	ParsedRelationship,
	ParsedRelationshipDefinition,
	ParsedSync,
	ParsedTypeDirection,
	AnalysisIssue,
} from '../analyzer/types';
import {
	deriveRelationshipFKColumns,
	deriveTableName,
	deriveUniqueConstraint,
	collectTypeNames,
	type RelationshipDefinition,
	type RelationshipTypes,
} from '../schema/relationship-definition.schema';

export interface LoadEntitiesResult {
	entities: ParsedEntity[];
	issues: AnalysisIssue[];
}

/**
 * Transform a loaded entity definition into a ParsedEntity
 */
function transformToEntity(result: LoadResult): ParsedEntity {
	const { definition, filePath } = result;

	// Search queries use a different shape (name/filters/search/paginate) and
	// are consumed directly by the codegen templates, not by the analyzer.
	// Narrow to the by-column variant here for ParsedQuery mapping.
	const queries: ParsedQuery[] | undefined = definition.queries
		?.filter((q): q is Extract<typeof q, { by: unknown }> => 'by' in q)
		.map((q) => ({
			by: q.by,
			unique: q.unique,
			select: q.select,
			order: q.order,
			limit: q.limit,
			via: q.via,
		}));

	const entity: ParsedEntity = {
		name: definition.entity.name,
		plural: definition.entity.plural,
		table: definition.entity.table,
		family: definition.entity.family as EntityFamily | undefined,
		folderStructure: definition.entity.folder_structure ?? 'nested',
		fields: new Map(),
		relationships: new Map(),
		behaviors: definition.behaviors.map((b) => (typeof b === 'string' ? b : b.name)),
		queries,
		sourcePath: filePath,
	};

	// Parse fields
	for (const [name, fieldDef] of Object.entries(definition.fields)) {
		const field: ParsedField = {
			name,
			type: fieldDef.type,
			required: fieldDef.required ?? false,
			nullable: fieldDef.nullable ?? false,
			unique: fieldDef.unique ?? false,
			index: fieldDef.index ?? false,
			foreignKey: fieldDef.foreign_key ? parseForeignKey(fieldDef.foreign_key) : undefined,
			choices: fieldDef.choices,
			constraints: {
				minLength: fieldDef.min_length,
				maxLength: fieldDef.max_length,
				min: fieldDef.min,
				max: fieldDef.max,
			},
			ui: {
				label: fieldDef.ui_label,
				type: fieldDef.ui_type,
				importance: fieldDef.ui_importance,
				group: fieldDef.ui_group,
				sortable: fieldDef.ui_sortable,
				filterable: fieldDef.ui_filterable,
				visible: fieldDef.ui_visible,
			},
		};
		entity.fields.set(name, field);
	}

	// Parse relationships
	if (definition.relationships) {
		for (const [name, relDef] of Object.entries(definition.relationships)) {
			const relationship: ParsedRelationship = {
				name,
				type: relDef.type,
				target: relDef.target,
				foreignKey: relDef.foreign_key,
				inverse: relDef.inverse,
				through: relDef.through,
				resolved: false,
			};
			entity.relationships.set(name, relationship);
		}
	}

	// Parse sync configuration
	if (definition.sync) {
		const syncDef = definition.sync;
		const parsedSync: ParsedSync = {
			electric: syncDef.electric ?? false,
		};

		if (syncDef.providers) {
			parsedSync.providers = {};
			for (const [providerName, providerDef] of Object.entries(syncDef.providers)) {
				const parsedProvider: ParsedProviderSync = {
					remoteEntity: providerDef.remote_entity,
					direction: providerDef.direction,
					cdc: providerDef.cdc ?? false,
				};
				if (providerDef.field_mapping) {
					parsedProvider.fieldMapping = providerDef.field_mapping;
				}
				if (providerDef.read_only_fields) {
					parsedProvider.readOnlyFields = providerDef.read_only_fields;
				}
				parsedSync.providers[providerName] = parsedProvider;
			}
		}

		entity.sync = parsedSync;
	}

	// Parse events
	if (definition.events) {
		entity.events = definition.events.map((ev): ParsedEvent => ({
			name: ev.name,
			queue: ev.queue,
			body: ev.body,
			generateHandler: ev.generate_handler,
		}));
	}

	return entity;
}

/**
 * Parse a foreign key string (e.g., "accounts.id") into table and column
 */
function parseForeignKey(fk: string): { table: string; column: string } {
	const [table, column] = fk.split('.');
	return { table, column: column ?? 'id' };
}

/**
 * Convert a load error to an analysis issue
 */
function loadErrorToIssue(error: LoadError): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	issues.push({
		severity: 'error',
		type: 'parse_error',
		message: error.error,
		path: error.filePath,
	});

	if (error.details) {
		for (const detail of error.details) {
			issues.push({
				severity: 'error',
				type: 'schema_error',
				message: detail,
				path: error.filePath,
			});
		}
	}

	return issues;
}

/**
 * Load all entity YAML files from a directory
 */
export function loadEntities(entitiesDir: string): LoadEntitiesResult {
	const entities: ParsedEntity[] = [];
	const issues: AnalysisIssue[] = [];

	const resolvedDir = resolve(entitiesDir);

	// Get all YAML files
	let files: string[];
	try {
		files = readdirSync(resolvedDir)
			.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
			.map((f) => join(resolvedDir, f));
	} catch (err) {
		issues.push({
			severity: 'error',
			type: 'parse_error',
			message: `Failed to read directory: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { entities, issues };
	}

	if (files.length === 0) {
		issues.push({
			severity: 'warning',
			type: 'no_files',
			message: `No YAML files found in directory: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { entities, issues };
	}

	// Load each file
	for (const filePath of files) {
		const result = loadEntityFromYaml(filePath);

		if (result.success) {
			entities.push(transformToEntity(result));
		} else {
			issues.push(...loadErrorToIssue(result));
		}
	}

	return { entities, issues };
}

/**
 * Resolve cross-entity references
 */
export function resolveReferences(entities: ParsedEntity[]): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];
	const entityMap = new Map<string, ParsedEntity>();

	// Build entity map by name
	for (const entity of entities) {
		if (entityMap.has(entity.name)) {
			issues.push({
				severity: 'error',
				type: 'duplicate_entity',
				entity: entity.name,
				message: `Duplicate entity name: ${entity.name}`,
				path: entity.sourcePath,
			});
		}
		entityMap.set(entity.name, entity);
	}

	// Resolve relationships
	for (const entity of entities) {
		for (const [relName, rel] of entity.relationships) {
			const targetEntity = entityMap.get(rel.target);
			if (targetEntity) {
				rel.resolved = true;
			} else {
				issues.push({
					severity: 'error',
					type: 'missing_target',
					entity: entity.name,
					field: relName,
					message: `Relationship '${relName}' references unknown entity '${rel.target}'`,
					path: entity.sourcePath,
					suggestion: `Define entity '${rel.target}' or fix the target name`,
				});
			}
		}

		// Check foreign key references
		for (const [fieldName, field] of entity.fields) {
			if (field.foreignKey) {
				const targetTable = field.foreignKey.table;
				const targetEntity = Array.from(entityMap.values()).find(
					(e) => e.table === targetTable
				);
				if (!targetEntity) {
					issues.push({
						severity: 'warning',
						type: 'missing_fk_target',
						entity: entity.name,
						field: fieldName,
						message: `Foreign key references unknown table '${targetTable}'`,
						path: entity.sourcePath,
						suggestion: `Define entity with table '${targetTable}' or fix the foreign_key reference`,
					});
				}
			}
		}
	}

	return issues;
}

// ============================================================================
// Relationship Loading
// ============================================================================

export interface LoadRelationshipsResult {
	relationships: ParsedRelationshipDefinition[];
	issues: AnalysisIssue[];
}

/**
 * Transform a loaded relationship definition into a ParsedRelationshipDefinition.
 *
 * This resolves all auto-generated fields: FK columns, type directions,
 * temporal/sourced fields, unique constraints.
 */
function transformToRelationshipDefinition(
	result: RelationshipLoadResult,
): ParsedRelationshipDefinition {
	const { definition, filePath } = result;
	const config = definition.relationship;

	const { fromColumn, toColumn } = deriveRelationshipFKColumns(config);
	const table = deriveTableName(config);
	const uniqueOn = deriveUniqueConstraint(config);

	// Resolve type directions
	const types = resolveTypeDirections(config.types);

	// Parse custom fields
	const fields = new Map<string, ParsedField>();
	if (definition.fields) {
		for (const [name, fieldDef] of Object.entries(definition.fields)) {
			const field: ParsedField = {
				name,
				type: fieldDef.type,
				required: fieldDef.required ?? false,
				nullable: fieldDef.nullable ?? false,
				unique: fieldDef.unique ?? false,
				index: fieldDef.index ?? false,
				foreignKey: fieldDef.foreign_key
					? parseForeignKey(fieldDef.foreign_key)
					: undefined,
				choices: fieldDef.choices,
				constraints: {
					minLength: fieldDef.min_length,
					maxLength: fieldDef.max_length,
					min: fieldDef.min,
					max: fieldDef.max,
				},
				ui: {
					label: fieldDef.ui_label,
					type: fieldDef.ui_type,
					importance: fieldDef.ui_importance,
					group: fieldDef.ui_group,
					sortable: fieldDef.ui_sortable,
					filterable: fieldDef.ui_filterable,
					visible: fieldDef.ui_visible,
				},
			};
			fields.set(name, field);
		}
	}

	// Parse queries
	// Relationship queries here: same filtering rationale as entity queries.
	const queries: ParsedQuery[] | undefined = definition.queries
		?.filter((q): q is Extract<typeof q, { by: unknown }> => 'by' in q)
		.map((q) => ({
			by: q.by,
			unique: q.unique,
			select: q.select,
			order: q.order,
			limit: q.limit,
		}));

	return {
		name: config.name,
		table,
		from: config.from,
		to: config.to,
		selfReferential: config.from === config.to,
		fromColumn,
		toColumn,
		types,
		hasTypes: types.length > 0,
		temporal: config.temporal,
		sourced: config.sourced,
		onDeleteFrom: config.on_delete_from ?? 'restrict',
		onDeleteTo: config.on_delete_to ?? 'restrict',
		uniqueOn,
		fields,
		queries,
		sourcePath: filePath,
	};
}

/**
 * Resolve type directions from the YAML types: block.
 *
 * Simple list → all directed, no inverses.
 * Object map → each type has explicit direction metadata.
 */
function resolveTypeDirections(
	types: RelationshipTypes | undefined,
): ParsedTypeDirection[] {
	if (!types) return [];

	if (Array.isArray(types)) {
		// Simple list: all directed from→to
		return types.map((name) => ({
			name,
			bidirectional: false,
			directed: true,
		}));
	}

	// Object map: resolve each type's direction
	return Object.entries(types).map(([name, dir]) => {
		const direction = dir as { inverse?: string; bidirectional?: boolean; directed?: boolean };
		return {
			name,
			inverse: direction.inverse,
			bidirectional: direction.bidirectional ?? false,
			directed: direction.directed ?? (!direction.bidirectional && !direction.inverse),
		};
	});
}

/**
 * Load all relationship YAML files from a directory
 */
export function loadRelationships(
	relationshipsDir: string,
): LoadRelationshipsResult {
	const relationships: ParsedRelationshipDefinition[] = [];
	const issues: AnalysisIssue[] = [];

	const resolvedDir = resolve(relationshipsDir);

	let files: string[];
	try {
		files = readdirSync(resolvedDir)
			.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
			.map((f) => join(resolvedDir, f));
	} catch {
		// Directory doesn't exist — not an error, relationships are optional
		return { relationships, issues };
	}

	if (files.length === 0) {
		return { relationships, issues };
	}

	for (const filePath of files) {
		const result = loadRelationshipFromYaml(filePath);

		if (result.success) {
			relationships.push(transformToRelationshipDefinition(result));
		} else {
			issues.push(...loadErrorToIssue(result as unknown as LoadError));
		}
	}

	return { relationships, issues };
}

/**
 * Resolve cross-references between relationship definitions and entities.
 * Validates that from/to entities exist.
 */
export function resolveRelationshipReferences(
	relationshipDefs: ParsedRelationshipDefinition[],
	entities: ParsedEntity[],
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];
	const entityNames = new Set(entities.map((e) => e.name));

	for (const relDef of relationshipDefs) {
		if (!entityNames.has(relDef.from)) {
			issues.push({
				severity: 'warning',
				type: 'missing_relationship_endpoint',
				entity: relDef.name,
				message: `Relationship '${relDef.name}' references unknown 'from' entity '${relDef.from}'`,
				path: relDef.sourcePath,
				suggestion: `Define entity '${relDef.from}' or fix the 'from' value`,
			});
		}

		if (!entityNames.has(relDef.to)) {
			issues.push({
				severity: 'warning',
				type: 'missing_relationship_endpoint',
				entity: relDef.name,
				message: `Relationship '${relDef.name}' references unknown 'to' entity '${relDef.to}'`,
				path: relDef.sourcePath,
				suggestion: `Define entity '${relDef.to}' or fix the 'to' value`,
			});
		}

		// Check for duplicate relationship names
		const dupes = relationshipDefs.filter((r) => r.name === relDef.name);
		if (dupes.length > 1) {
			issues.push({
				severity: 'error',
				type: 'duplicate_relationship',
				entity: relDef.name,
				message: `Duplicate relationship name: ${relDef.name}`,
				path: relDef.sourcePath,
			});
		}
	}

	return issues;
}

export { loadEntityFromYaml } from '../utils/yaml-loader';
export { loadRelationshipFromYaml } from '../utils/yaml-loader';
