/**
 * Transitive Relationship Suggester
 *
 * Detects potential transitive relationships in the domain graph.
 * Uses BFS to find 2-3 hop paths through has_many relationships and
 * generates ready-to-paste YAML snippets for the entity definition files.
 */

import type {
	DomainGraph,
	ParsedEntity,
	ParsedRelationship,
	TransitiveSuggestion,
	TransitivePath,
	PathHop,
} from './types';

export interface SuggesterOptions {
	maxDepth?: number;
	excludeEntities?: string[];
	excludePatterns?: RegExp[];
}

const DEFAULT_OPTIONS: Required<SuggesterOptions> = {
	maxDepth: 3,
	excludeEntities: ['workspace', 'tenant'],
	excludePatterns: [/_audit$/, /_log$/, /_history$/],
};

interface BFSNode {
	entity: string;
	depth: number;
	path: PathHop[];
	visited: Set<string>;
}

/**
 * Suggest transitive relationships based on graph analysis
 */
export function suggestTransitiveRelationships(
	graph: DomainGraph,
	options?: SuggesterOptions
): TransitiveSuggestion[] {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const suggestions: TransitiveSuggestion[] = [];

	// Process each entity as a potential source
	for (const [entityName, entity] of graph.entities) {
		if (shouldExcludeEntity(entityName, opts)) continue;

		const paths = findTransitivePaths(graph, entityName, opts);
		for (const path of paths) {
			suggestions.push(createSuggestion(path));
		}
	}

	return suggestions;
}

/**
 * Check if entity should be excluded from analysis
 */
function shouldExcludeEntity(
	entityName: string,
	opts: Required<SuggesterOptions>
): boolean {
	// Check exclude list
	if (opts.excludeEntities.includes(entityName)) {
		return true;
	}

	// Check exclude patterns
	for (const pattern of opts.excludePatterns) {
		if (pattern.test(entityName)) {
			return true;
		}
	}

	return false;
}

/**
 * Find all valid transitive paths from a source entity using BFS
 */
function findTransitivePaths(
	graph: DomainGraph,
	sourceEntity: string,
	opts: Required<SuggesterOptions>
): TransitivePath[] {
	const paths: TransitivePath[] = [];
	const sourceEntityData = graph.entities.get(sourceEntity);
	if (!sourceEntityData) return paths;

	const queue: BFSNode[] = [
		{
			entity: sourceEntity,
			depth: 0,
			path: [],
			visited: new Set([sourceEntity]),
		},
	];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		const { entity, depth, path, visited } = current;

		// Don't go beyond max depth
		if (depth >= opts.maxDepth) continue;

		const currentEntity = graph.entities.get(entity);
		if (!currentEntity) continue;

		// Explore has_many and has_one relationships
		for (const [relName, rel] of currentEntity.relationships) {
			// Skip if already has a through defined
			if (rel.through) continue;

			// Only follow has_many and has_one relationships
			if (rel.type !== 'has_many' && rel.type !== 'has_one') continue;

			const target = rel.target;

			// Skip excluded entities
			if (shouldExcludeEntity(target, opts)) continue;

			// Avoid cycles
			if (visited.has(target)) continue;

			const newPath: PathHop[] = [
				...path,
				{
					via: entity,
					relationship: relName,
					foreignKey: rel.foreignKey,
				},
			];

			// If we're at depth 2 or more, we have a valid transitive path
			if (depth >= 1) {
				// Check if a direct relationship already exists
				if (!hasDirectRelationship(sourceEntityData, target)) {
					const transitivePath = buildTransitivePath(
						sourceEntity,
						target,
						newPath
					);
					if (transitivePath) {
						paths.push(transitivePath);
					}
				}
			}

			// Continue searching deeper
			if (depth + 1 < opts.maxDepth) {
				queue.push({
					entity: target,
					depth: depth + 1,
					path: newPath,
					visited: new Set([...visited, target]),
				});
			}
		}
	}

	return paths;
}

/**
 * Check if a direct relationship already exists between source and target
 */
function hasDirectRelationship(
	sourceEntity: ParsedEntity,
	targetName: string
): boolean {
	for (const rel of sourceEntity.relationships.values()) {
		if (rel.target === targetName && !rel.through) {
			return true;
		}
	}
	return false;
}

/**
 * Build a TransitivePath from BFS result
 */
function buildTransitivePath(
	source: string,
	target: string,
	hops: PathHop[]
): TransitivePath | null {
	if (hops.length === 0) return null;

	// Build through path: "relationships.nested_relationship"
	const throughPath = hops.map((hop) => hop.relationship).join('.');

	// Generate semantic name
	const suggestedName = generateSemanticName(source, target, hops);

	// Generate YAML snippet
	const yamlSnippet = generateYamlSnippet(suggestedName, target, throughPath);

	return {
		source,
		target,
		hops,
		suggestedName,
		throughPath,
		yamlSnippet,
	};
}

/**
 * Generate a semantic relationship name
 * Examples:
 * - user -> meetings -> action_items = "meeting_action_items"
 * - user -> owned_opportunities -> updates = "owned_opportunity_updates"
 */
function generateSemanticName(
	source: string,
	target: string,
	hops: PathHop[]
): string {
	// Use the first hop relationship name as a prefix
	const firstHop = hops[0].relationship;

	// For simple 2-hop paths, combine first relationship with target
	if (hops.length === 2) {
		// Handle pluralization
		const prefix = firstHop.replace(/s$/, ''); // singular form
		return `${prefix}_${target}`;
	}

	// For 3-hop paths, combine all meaningful parts
	const parts = [firstHop.replace(/s$/, ''), target];
	return parts.join('_');
}

/**
 * Generate ready-to-paste YAML snippet
 */
function generateYamlSnippet(
	name: string,
	target: string,
	throughPath: string
): string {
	return `  ${name}:
    type: has_many
    target: ${target}
    through: "${throughPath}"`;
}

/**
 * Create a TransitiveSuggestion from a TransitivePath
 */
function createSuggestion(path: TransitivePath): TransitiveSuggestion {
	const pathDescription = [path.source, ...path.hops.map((h) => h.via), path.target]
		.join(' -> ');

	return {
		severity: 'info',
		type: 'transitive_suggestion',
		entity: path.source,
		message: `Potential transitive relationship: ${pathDescription}`,
		suggestion: `Add "${path.suggestedName}" relationship via "${path.throughPath}"`,
		path,
	};
}
