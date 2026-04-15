/**
 * Graph Builder
 *
 * Builds a domain graph from parsed entities, including nodes and edges.
 * Tracks bidirectional connections between entities.
 */

import type {
	ParsedEntity,
	ParsedRelationship,
	ParsedRelationshipDefinition,
	DomainGraph,
	RelationshipEdge,
	EntityNode,
} from './types';

/**
 * Infer cardinality from relationship type
 */
function inferCardinality(type: string): '1:1' | '1:N' | 'N:1' | 'N:M' {
	switch (type) {
		case 'belongs_to':
			return 'N:1';
		case 'has_many':
			return '1:N';
		case 'has_one':
			return '1:1';
		default:
			return '1:N';
	}
}

/**
 * Check if an edge already exists in the opposite direction
 */
function hasReverseEdge(
	edges: RelationshipEdge[],
	from: string,
	to: string
): RelationshipEdge | undefined {
	return edges.find((e) => e.from === to && e.to === from);
}

/**
 * Build a domain graph from parsed entities
 */
export function buildDomainGraph(
	entities: ParsedEntity[],
	relationshipDefinitions: ParsedRelationshipDefinition[] = [],
): DomainGraph {
	const entityMap = new Map<string, ParsedEntity>();
	const relDefMap = new Map<string, ParsedRelationshipDefinition>();
	const edges: RelationshipEdge[] = [];

	// Build entity map
	for (const entity of entities) {
		entityMap.set(entity.name, entity);
	}

	// Build relationship definition map
	for (const relDef of relationshipDefinitions) {
		relDefMap.set(relDef.name, relDef);
	}

	// Build edges from inline entity relationships (belongs_to, has_many, has_one)
	for (const entity of entities) {
		for (const [relName, rel] of entity.relationships) {
			if (!rel.resolved) continue;

			// Check if reverse edge already exists
			const reverseEdge = hasReverseEdge(edges, entity.name, rel.target);

			const edge: RelationshipEdge = {
				from: entity.name,
				to: rel.target,
				relationship: rel,
				cardinality: inferCardinality(rel.type),
				bidirectional: reverseEdge !== undefined,
			};

			// Mark reverse edge as bidirectional too
			if (reverseEdge) {
				reverseEdge.bidirectional = true;
			}

			edges.push(edge);
		}
	}

	// Build edges from first-class relationship definitions (junction entities)
	for (const relDef of relationshipDefinitions) {
		const fromExists = entityMap.has(relDef.from);
		const toExists = entityMap.has(relDef.to);

		if (fromExists && toExists) {
			// Create an N:M edge — junction tables are always many-to-many
			const edge: RelationshipEdge = {
				from: relDef.from,
				to: relDef.to,
				relationship: {
					name: relDef.name,
					type: 'has_many',
					target: relDef.to,
					foreignKey: relDef.fromColumn,
					resolved: true,
				},
				cardinality: 'N:M',
				bidirectional: relDef.types.some((t) => t.bidirectional),
			};

			edges.push(edge);
		}
	}

	return { entities: entityMap, relationshipDefinitions: relDefMap, edges };
}

/**
 * Get all entities related to a given entity within a specified depth
 */
export function getRelatedEntities(
	graph: DomainGraph,
	entityName: string,
	depth = 1
): Set<string> {
	const related = new Set<string>();
	const visited = new Set<string>();
	const queue: Array<{ name: string; currentDepth: number }> = [
		{ name: entityName, currentDepth: 0 },
	];

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) continue;

		const { name, currentDepth } = item;
		if (visited.has(name) || currentDepth > depth) continue;
		visited.add(name);

		for (const edge of graph.edges) {
			if (edge.from === name && !visited.has(edge.to)) {
				related.add(edge.to);
				queue.push({ name: edge.to, currentDepth: currentDepth + 1 });
			}
			if (edge.to === name && !visited.has(edge.from)) {
				related.add(edge.from);
				queue.push({ name: edge.from, currentDepth: currentDepth + 1 });
			}
		}
	}

	return related;
}

/**
 * Find entities with no relationships (orphans)
 */
export function findOrphanEntities(graph: DomainGraph): string[] {
	const orphans: string[] = [];
	for (const [name] of graph.entities) {
		const hasRelationship = graph.edges.some((e) => e.from === name || e.to === name);
		if (!hasRelationship) {
			orphans.push(name);
		}
	}
	return orphans;
}

/**
 * Find circular dependencies in the graph
 */
export function findCircularDependencies(graph: DomainGraph): string[][] {
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const recursionStack = new Set<string>();

	function dfs(node: string, path: string[]): void {
		visited.add(node);
		recursionStack.add(node);

		const outgoingEdges = graph.edges.filter((e) => e.from === node);
		for (const edge of outgoingEdges) {
			if (!visited.has(edge.to)) {
				dfs(edge.to, [...path, edge.to]);
			} else if (recursionStack.has(edge.to)) {
				// Found cycle
				const cycleStart = path.indexOf(edge.to);
				if (cycleStart !== -1) {
					cycles.push([...path.slice(cycleStart), edge.to]);
				} else {
					// The cycle starts at edge.to which is in the recursion stack
					cycles.push([...path, edge.to]);
				}
			}
		}

		recursionStack.delete(node);
	}

	for (const [name] of graph.entities) {
		if (!visited.has(name)) {
			dfs(name, [name]);
		}
	}

	// Deduplicate cycles (same cycle can be detected from different starting points)
	const uniqueCycles: string[][] = [];
	const seen = new Set<string>();

	for (const cycle of cycles) {
		// Normalize cycle by rotating to start with smallest element
		const minIndex = cycle.indexOf(
			cycle.reduce((min, val) => (val < min ? val : min), cycle[0])
		);
		const normalized = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
		const key = normalized.join('->');

		if (!seen.has(key)) {
			seen.add(key);
			uniqueCycles.push(cycle);
		}
	}

	return uniqueCycles;
}

/**
 * Build entity nodes for visualization
 */
export function buildEntityNodes(graph: DomainGraph): EntityNode[] {
	const nodes: EntityNode[] = [];
	for (const [name, entity] of graph.entities) {
		nodes.push({
			id: name,
			name: entity.name,
			entity,
		});
	}
	return nodes;
}
