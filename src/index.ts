/**
 * Entity Codegen & Domain Analyzer
 *
 * A validation and analysis tool for entity YAML definitions.
 * Parses entities, builds a relationship graph, and detects issues.
 */

import { loadEntities, loadRelationships, resolveReferences, resolveRelationshipReferences } from './parser';
import { buildDomainGraph, checkConsistency, computeStatistics } from './analyzer';
import {
	validatePatternComposition,
	validatePatternProject,
} from './patterns/validate-composition.js';
import { validateOrchestrationProject } from './patterns/validate-orchestration.js';
import {
	getAllOrchestrationPatterns,
	getAllPatternNames,
} from './patterns/registry.js';
import type { AnalysisResult, OutputFormat } from './analyzer/types';

/**
 * Options for `analyzeDomain`. All fields are optional and additive — omitting
 * them keeps the analyzer's behavior identical to pre-PATTERN-4 callers.
 */
export interface AnalyzeDomainOptions {
	/**
	 * Path to the relationships directory. Equivalent to the legacy second
	 * positional argument — preserved for call-site compatibility.
	 */
	relationshipsDir?: string;
	/**
	 * Selected backend architecture from `codegen.config.yaml
	 * generate.architecture`. When provided, enables the PATTERN-4 project-level
	 * check (plan Risk 4) that warns when `pattern:` is declared but the
	 * selected architecture does not yet consume patterns (e.g. `clean`).
	 */
	architecture?: string;
}

/**
 * Analyze a domain from entity and relationship YAML files.
 *
 * The signature accepts either the legacy `(entitiesDir, relationshipsDir)`
 * shape or the newer `(entitiesDir, options)` object form. Existing callers
 * keep working unchanged; pattern-aware callers pass
 * `{ architecture, relationshipsDir }` to opt into the Risk-4 project-level
 * warning surface.
 */
export async function analyzeDomain(
	entitiesDir: string,
	relationshipsOrOptions?: string | AnalyzeDomainOptions,
): Promise<AnalysisResult> {
	const opts: AnalyzeDomainOptions =
		typeof relationshipsOrOptions === 'string'
			? { relationshipsDir: relationshipsOrOptions }
			: relationshipsOrOptions ?? {};
	const relationshipsDir = opts.relationshipsDir;

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

	// PATTERN-4 — pattern composition check. Runs AFTER resolveReferences()
	// (per ADR-031 §3) so entity fields + behaviors are known; the
	// per-entity validator detects column conflicts, unknown patterns, and
	// config-schema failures, and the project-level validator covers plan
	// Risk 4 (warn when `pattern:` is declared under an architecture that
	// does not yet consume patterns).
	const patternIssues = entities.flatMap((e) => validatePatternComposition(e));
	const patternProjectIssues = validatePatternProject({
		entities,
		architecture: opts.architecture,
	});

	// ADR-032 Phase 3-1 — orchestration pattern project-level validator.
	// Compares orchestration names against the domain name set (cross-kind
	// collision is a hard error), and walks each orchestration pattern's
	// registry shape for malformed entries, duplicate keys, and co-keyed
	// keyType drift.
	const orchestrationProjectIssues = validateOrchestrationProject({
		orchestrationPatterns: getAllOrchestrationPatterns(),
		domainPatternNames: getAllPatternNames(),
	});

	// Compute statistics
	const statistics = computeStatistics(graph);

	// Combine all issues
	const allIssues = [
		...loadIssues,
		...relLoadIssues,
		...resolveIssues,
		...relResolveIssues,
		...consistencyIssues,
		...patternIssues,
		...patternProjectIssues,
		...orchestrationProjectIssues,
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


// Re-export patterns surface (definePattern + library patterns + registry).
// Importing this barrel has the side effect of pre-registering the five
// library-shipped patterns (Base / Synced / Activity / Knowledge / Metadata).
export * from './patterns';
