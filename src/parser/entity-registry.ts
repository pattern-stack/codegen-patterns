/**
 * Cross-Entity Naming Registry (ADR-038, FE-1)
 *
 * Loads every entity YAML under a directory and exposes an authoritative
 * name → naming-record map so FK target names (file, plural, class, collection
 * var) are resolved against the TARGET entity's own YAML rather than re-derived
 * by pluralizing strings at emit time. Mirrors the pts generator's
 * `_resolve_relationship_targets`: no plural is ever inferred — `plural` is read
 * straight from `entity.plural`.
 *
 * Tolerant of invalid files: malformed YAMLs are reported as `AnalysisIssue`s
 * (same shape as `loadEntities`) rather than thrown, so one bad file does not
 * sink the whole set.
 */

import { resolve } from 'node:path';
import { findYamlFiles } from '../utils/find-yaml-files';
import { loadEntityFromYaml, type LoadError } from '../utils/yaml-loader';
import type { AnalysisIssue } from '../analyzer/types';

export interface EntityRegistryEntry {
	name: string; // 'deal_state'
	plural: string; // authoritative, from YAML entity.plural
	table: string;
	className: string; // 'DealState'  (pascal of name)
	classNamePlural: string;
	camelName: string; // 'dealState'
	pluralCamelName: string;
	sync: 'api' | 'electric' | null; // null → inherit global frontend.sync.mode
	frontend: boolean; // entity.frontend — false ⇒ excluded from all frontend emit (backend unaffected)
}

export interface LoadEntityRegistryResult {
	registry: Map<string, EntityRegistryEntry>; // keyed by entity name
	issues: AnalysisIssue[]; // invalid YAMLs reported, not thrown
}

// snake_case → camelCase / PascalCase, consistent with prompt.js helpers.
const camelCase = (s: string): string =>
	s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const pascalCase = (s: string): string => {
	const camel = camelCase(s);
	return camel.charAt(0).toUpperCase() + camel.slice(1);
};

/**
 * Convert a load error to analysis issues (mirrors `loadEntities`'
 * `loadErrorToIssue`).
 */
function loadErrorToIssue(error: LoadError): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [
		{
			severity: 'error',
			type: 'parse_error',
			message: error.error,
			path: error.filePath,
		},
	];

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
 * Load the cross-entity naming registry from a directory of entity YAMLs.
 *
 * @param entitiesDir Directory to walk recursively for `*.yaml`/`*.yml`.
 * @returns A name-keyed registry plus any issues encountered (missing dir,
 *   malformed files). Never throws.
 */
export function loadEntityRegistry(entitiesDir: string): LoadEntityRegistryResult {
	const registry = new Map<string, EntityRegistryEntry>();
	const issues: AnalysisIssue[] = [];

	const resolvedDir = resolve(entitiesDir);

	let files: string[];
	try {
		files = findYamlFiles(resolvedDir);
	} catch {
		issues.push({
			severity: 'error',
			type: 'parse_error',
			message: `Failed to read directory: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { registry, issues };
	}

	for (const filePath of files) {
		const result = loadEntityFromYaml(filePath);

		if (!result.success) {
			issues.push(...loadErrorToIssue(result));
			continue;
		}

		const { entity } = result.definition;
		registry.set(entity.name, {
			name: entity.name,
			plural: entity.plural, // authoritative — never derived
			table: entity.table,
			className: pascalCase(entity.name),
			classNamePlural: pascalCase(entity.plural),
			camelName: camelCase(entity.name),
			pluralCamelName: camelCase(entity.plural),
			sync: entity.sync ?? null,
			// `entity.frontend` carries a Zod `.default(true)`, so a validated
			// definition always has it; `?? true` guards an unvalidated/partial entity.
			frontend: entity.frontend ?? true,
		});
	}

	return { registry, issues };
}
