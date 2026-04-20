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

/**
 * Topologically sort entities so that any entity declaring `belongs_to: X`
 * appears AFTER X in the result. This makes generators that branch on
 * "does the related entity's domain file already exist?" deterministic —
 * by the time a dependent entity is generated, all its targets have been.
 *
 * Why this matters: `templates/entity/new/prompt.js` calls `checkEntityExists`
 * for each `belongs_to` target and emits one of two distinct branches based on
 * the answer. Without a topo sort, the per-fixture generation order is
 * filesystem-dependent (`readdirSync`) and the generated code becomes
 * non-deterministic. The baseline test specifically depends on this order.
 *
 * Cycles in the `belongs_to` graph (e.g. self-referential parent FKs, or
 * mutually-dependent entities) are broken arbitrarily — affected entities
 * are emitted in their original input order after all acyclic dependencies
 * have been placed. The cycle is also returned alongside the sorted list so
 * the caller can warn or fail. Self-references (entity depends on itself)
 * are NOT cycles for sort purposes — an entity is always considered to
 * satisfy its own dependency.
 */
export function topoSortEntities(
	entities: ParsedEntity[],
	graph: DomainGraph,
): { sorted: ParsedEntity[]; cycles: string[][] } {
	// Build a "depends on" map: entity → set of entities it must come AFTER.
	// belongs_to is the only relationship type that imposes a generation-order
	// dependency — has_many and has_one do not (the inverse side is informed
	// by belongs_to on the other entity).
	const dependsOn = new Map<string, Set<string>>();
	for (const entity of entities) {
		dependsOn.set(entity.name, new Set());
	}
	for (const entity of entities) {
		for (const rel of entity.relationships.values()) {
			if (rel.type !== 'belongs_to') continue;
			if (!rel.resolved) continue;
			if (rel.target === entity.name) continue; // self-reference is not a dependency
			if (!dependsOn.has(rel.target)) continue; // target not in input set
			dependsOn.get(entity.name)!.add(rel.target);
		}
	}

	// Kahn's algorithm: repeatedly emit entities whose dependencies are all
	// satisfied. Tie-break alphabetically so the output is stable across
	// platforms (readdirSync order varies).
	const sorted: ParsedEntity[] = [];
	const remaining = new Map<string, ParsedEntity>();
	for (const e of entities) remaining.set(e.name, e);

	while (remaining.size > 0) {
		const ready = [...remaining.keys()]
			.filter((name) => {
				const deps = dependsOn.get(name)!;
				for (const dep of deps) if (remaining.has(dep)) return false;
				return true;
			})
			.sort();
		if (ready.length === 0) break; // remaining entities form a cycle
		for (const name of ready) {
			sorted.push(remaining.get(name)!);
			remaining.delete(name);
		}
	}

	// Anything still in `remaining` is part of one or more cycles — append in
	// alphabetical order so the result is still deterministic.
	const stuck = [...remaining.keys()].sort();
	for (const name of stuck) sorted.push(remaining.get(name)!);

	const cycles = findCircularDependencies(graph).filter((cycle) =>
		// Only surface cycles that involve belongs_to (the kind that affect
		// generation order). findCircularDependencies considers all edge
		// types; a has_many <-> belongs_to pair shows as a cycle there but
		// does NOT block topo sort here.
		cycle.length > 1 && cycle.some((name) => stuck.includes(name)),
	);

	return { sorted, cycles };
}
