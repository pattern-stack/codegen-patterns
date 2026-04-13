/**
 * JSON Formatter
 *
 * Machine-readable JSON output for the domain analysis results.
 */

import type { AnalysisResult, ParsedEntity, DomainGraph } from '../analyzer/types';

/**
 * Helper to convert Maps to plain objects for JSON serialization
 */
function mapToObject<K extends string, V>(map: Map<K, V>): Record<K, V> {
	const obj = {} as Record<K, V>;
	for (const [key, value] of map) {
		obj[key] = value;
	}
	return obj;
}

/**
 * Convert ParsedEntity to a JSON-serializable format
 */
function serializeEntity(entity: ParsedEntity): Record<string, unknown> {
	return {
		name: entity.name,
		plural: entity.plural,
		table: entity.table,
		folderStructure: entity.folderStructure,
		fields: mapToObject(entity.fields),
		relationships: mapToObject(entity.relationships),
		behaviors: entity.behaviors,
		sourcePath: entity.sourcePath,
	};
}

/**
 * Convert DomainGraph to a JSON-serializable format
 */
function serializeGraph(graph: DomainGraph): Record<string, unknown> {
	const entities: Record<string, unknown> = {};
	for (const [name, entity] of graph.entities) {
		entities[name] = serializeEntity(entity);
	}

	return {
		entities,
		edges: graph.edges,
	};
}

/**
 * Format analysis result as JSON string
 */
export function formatJson(result: AnalysisResult, pretty = true): string {
	const output = {
		isValid: result.isValid,
		summary: {
			entities: result.statistics.totalEntities,
			fields: result.statistics.totalFields,
			relationships: result.statistics.totalRelationships,
			errors: result.issues.filter((i) => i.severity === 'error').length,
			warnings: result.issues.filter((i) => i.severity === 'warning').length,
			info: result.issues.filter((i) => i.severity === 'info').length,
		},
		entities: result.entities.map(serializeEntity),
		graph: serializeGraph(result.graph),
		issues: result.issues,
		statistics: result.statistics,
		timestamp: new Date().toISOString(),
	};

	return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Format only statistics as JSON
 */
export function formatStatsJson(result: AnalysisResult, pretty = true): string {
	const output = {
		statistics: result.statistics,
		isValid: result.isValid,
		issueCount: {
			errors: result.issues.filter((i) => i.severity === 'error').length,
			warnings: result.issues.filter((i) => i.severity === 'warning').length,
			info: result.issues.filter((i) => i.severity === 'info').length,
		},
		timestamp: new Date().toISOString(),
	};

	return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Format only issues as JSON
 */
export function formatIssuesJson(result: AnalysisResult, pretty = true): string {
	const output = {
		isValid: result.isValid,
		issues: result.issues,
		timestamp: new Date().toISOString(),
	};

	return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}
