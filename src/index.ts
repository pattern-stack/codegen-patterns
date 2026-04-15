/**
 * Entity Codegen & Domain Analyzer
 *
 * A validation and analysis tool for entity YAML definitions.
 * Parses entities, builds a relationship graph, and detects issues.
 */

import { loadEntities, loadRelationships, resolveReferences, resolveRelationshipReferences } from './parser';
import { buildDomainGraph, checkConsistency, computeStatistics } from './analyzer';
import type { AnalysisResult, OutputFormat } from './analyzer/types';

/**
 * Analyze a domain from entity and relationship YAML files
 */
export async function analyzeDomain(
	entitiesDir: string,
	relationshipsDir?: string,
): Promise<AnalysisResult> {
	// Load and parse all entity files
	const { entities, issues: loadIssues } = loadEntities(entitiesDir);

	// Load relationship definitions (optional — directory may not exist)
	const { relationships: relationshipDefinitions, issues: relLoadIssues } =
		relationshipsDir
			? loadRelationships(relationshipsDir)
			: { relationships: [], issues: [] };

	// Resolve cross-entity references
	const resolveIssues = resolveReferences(entities);

	// Resolve relationship endpoint references
	const relResolveIssues = resolveRelationshipReferences(
		relationshipDefinitions,
		entities,
	);

	// Build relationship graph (includes both inline and first-class relationships)
	const graph = buildDomainGraph(entities, relationshipDefinitions);

	// Check consistency
	const consistencyIssues = checkConsistency(graph);

	// Compute statistics
	const statistics = computeStatistics(graph);

	// Combine all issues
	const allIssues = [
		...loadIssues,
		...relLoadIssues,
		...resolveIssues,
		...relResolveIssues,
		...consistencyIssues,
	];

	// Determine validity (only errors make it invalid)
	const hasErrors = allIssues.some((i) => i.severity === 'error');

	return {
		isValid: !hasErrors,
		entities,
		relationshipDefinitions,
		graph,
		issues: allIssues,
		statistics,
	};
}

/**
 * Validate entity files without full analysis
 * Returns true if all files parse successfully
 */
export function validateEntities(entitiesDir: string): {
	valid: boolean;
	errors: string[];
} {
	const { entities, issues } = loadEntities(entitiesDir);
	const errors = issues
		.filter((i) => i.severity === 'error')
		.map((i) => i.message);

	return {
		valid: errors.length === 0,
		errors,
	};
}

// Re-export types
export * from './analyzer/types';

// Re-export parser utilities
export { loadEntities, loadRelationships, loadEntityFromYaml, loadRelationshipFromYaml } from './parser';

// Re-export analyzer utilities
export {
	buildDomainGraph,
	getRelatedEntities,
	findOrphanEntities,
	findCircularDependencies,
	checkConsistency,
	computeStatistics,
} from './analyzer';

// Re-export formatters
export {
	formatConsole,
	formatJson,
	formatMarkdown,
	formatMermaidGraph,
} from './formatters';
