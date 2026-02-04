/**
 * Entity Loader
 *
 * Loads and parses all YAML entity files from a directory.
 * Reuses existing yaml-loader and entity-definition schema from codegen.
 */

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	loadEntityFromYaml,
	type LoadResult,
	type LoadError,
} from '../utils/yaml-loader';
import type { ParsedEntity, ParsedField, ParsedRelationship, AnalysisIssue } from '../analyzer/types';

export interface LoadEntitiesResult {
	entities: ParsedEntity[];
	issues: AnalysisIssue[];
}

/**
 * Transform a loaded entity definition into a ParsedEntity
 */
function transformToEntity(result: LoadResult): ParsedEntity {
	const { definition, filePath } = result;

	const entity: ParsedEntity = {
		name: definition.entity.name,
		plural: definition.entity.plural,
		table: definition.entity.table,
		folderStructure: definition.entity.folder_structure ?? 'nested',
		fields: new Map(),
		relationships: new Map(),
		behaviors: [],
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

export { loadEntityFromYaml } from '../utils/yaml-loader';
