/**
 * SchemaAdapter — maps the Studio server's `SerializedDomainGraph` to the
 * component library's `GraphNodeData` / `GraphEdgeData`.
 *
 * The domain types come from `@studio-shared`, which re-exports the analyzer's
 * own definitions: the viewer's habit of mirroring them locally is exactly the
 * drift this contract exists to prevent.
 *
 * Mappings:
 *  - SerializedEntity                 → GraphNodeData (kind: 'entity')
 *  - SerializedRelationshipDefinition → GraphNodeData (kind: 'relationship')
 *  - graph.edges                      → StudioEdgeData, classified by kind
 *  - each relationship definition      → a pair of junction edges through it
 */
import type { GraphNodeData } from '@pattern-stack/graph-components';
import type { SerializedDomainGraph } from '@studio-shared';
import type { StudioEdgeData, StudioEdgeKind } from '../graph/edge-kinds';

type Entities = SerializedDomainGraph['entities'];
type RelDefs = SerializedDomainGraph['relationshipDefinitions'];
export type SerializedEntity = Entities[string];
export type SerializedRelationshipDefinition = RelDefs[string];
type SerializedField = SerializedEntity['fields'][string];
type SerializedEdge = SerializedDomainGraph['edges'][number];

/**
 * `SerializedRelationship.role` (CAP-2) names the `roles:` entry a
 * relationship was derived from. An empty string is treated as absent — a role
 * with no name cannot label an edge.
 */
function roleOf(rel: SerializedEdge['relationship']): string | undefined {
  return rel.role !== undefined && rel.role !== '' ? rel.role : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function pascalCase(s: string): string {
  return s
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const SYSTEM_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'created_by',
  'updated_by',
]);

function fieldRole(f: SerializedField): 'pk' | 'fk' | 'required' | 'nullable' {
  if (f.name === 'id') return 'pk';
  if (f.foreignKey) return 'fk';
  if (f.required) return 'required';
  return 'nullable';
}

function toFields(fields: Record<string, SerializedField>): NonNullable<GraphNodeData['fields']> {
  return Object.values(fields).map((f) => ({
    name: f.name,
    type: f.type,
    role: fieldRole(f),
    system: SYSTEM_FIELDS.has(f.name),
  }));
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export function entityToNode(entity: SerializedEntity): GraphNodeData<SerializedEntity> {
  const fields = toFields(entity.fields);

  return {
    id: entity.name,
    label: pascalCase(entity.name),
    subtitle: entity.table,
    kind: 'entity',
    group: entity.pattern ?? entity.patterns?.[0] ?? 'Base',
    fields,
    behaviors: entity.behaviors,
    fieldCount: fields.length,
    queryCount: entity.queries?.length ?? 0,
    metadata: { source: entity.sourcePath },
    source: entity,
  };
}

export function relationshipToNode(
  rel: SerializedRelationshipDefinition,
): GraphNodeData<SerializedRelationshipDefinition> {
  const fields = toFields(rel.fields);
  const flags: string[] = [];
  if (rel.temporal) flags.push('temporal');
  if (rel.sourced) flags.push('sourced');
  if (rel.selfReferential) flags.push('self-referential');

  return {
    id: rel.name,
    label: pascalCase(rel.name),
    subtitle: rel.table,
    kind: 'relationship',
    from: rel.from,
    to: rel.to,
    selfReferential: rel.selfReferential,
    types: rel.types.map((t) => ({
      name: t.name,
      direction: t.bidirectional ? 'bidirectional' : t.directed ? 'directed' : undefined,
      inverseName: t.inverse,
    })),
    flags,
    fields,
    fieldCount: fields.length,
    queryCount: rel.queries?.length ?? 0,
    metadata: { source: rel.sourcePath },
    source: rel,
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * Classify one graph edge.
 *
 * A role-derived relationship is a `belongs_to` underneath, but the model's
 * reason for it is the role — so it gets its own kind and the plain
 * `belongs_to` styling is reserved for authored foreign keys.
 */
export function classifyEdge(edge: SerializedEdge): StudioEdgeKind {
  if (roleOf(edge.relationship)) return 'role';
  return edge.relationship.type;
}

/** The library's coarse renderer hint for a Studio edge kind. */
function libraryType(kind: StudioEdgeKind): StudioEdgeData['type'] {
  if (kind === 'junction') return 'junction';
  if (kind === 'belongs_to' || kind === 'role') return 'fk';
  return 'inline';
}

/**
 * Build edges from a serialized graph.
 *
 * Two families:
 * 1. Inline edges from `graph.edges` — belongs_to / has_many / has_one / role.
 * 2. Junction edges — each relationship definition becomes a node with an
 *    edge in from its `from` entity and an edge out to its `to` entity.
 *
 * An `N:M` edge whose relationship names a junction is skipped: the junction
 * node pair already expresses it, and keeping both draws the edge twice.
 */
export function buildEdges(graph: SerializedDomainGraph): StudioEdgeData[] {
  const edges: StudioEdgeData[] = [];
  const junctionNames = new Set(Object.keys(graph.relationshipDefinitions));
  const seen = new Set<string>();

  const push = (edge: StudioEdgeData) => {
    // Two entities can declare the two halves of one association; the id is
    // derived from the pair, so dedupe rather than stacking identical strokes.
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push(edge);
  };

  for (const e of graph.edges) {
    if (e.cardinality === 'N:M' && junctionNames.has(e.relationship.name)) continue;

    const kind = classifyEdge(e);
    const roleName = roleOf(e.relationship);

    push({
      id: `${kind}-${e.from}-${e.relationship.name}-${e.to}`,
      source: e.from,
      target: e.to,
      cardinality: e.cardinality,
      label: roleName ?? e.relationship.name,
      type: libraryType(kind),
      bidirectional: e.bidirectional,
      studioKind: kind,
      roleName,
    });
  }

  for (const relDef of Object.values(graph.relationshipDefinitions)) {
    push({
      id: `junction-${relDef.from}-${relDef.name}`,
      source: relDef.from,
      target: relDef.name,
      cardinality: '1:N',
      type: 'junction',
      studioKind: 'junction',
    });
    push({
      id: `junction-${relDef.name}-${relDef.to}`,
      source: relDef.name,
      target: relDef.to,
      cardinality: 'N:1',
      type: 'junction',
      studioKind: 'junction',
    });
  }

  return edges;
}

export interface AdaptedGraph {
  nodes: GraphNodeData[];
  edges: StudioEdgeData[];
}

/** Convert a serialized graph to the nodes and edges the canvas renders. */
export function adaptDomainGraph(graph: SerializedDomainGraph): AdaptedGraph {
  const nodes: GraphNodeData[] = [
    ...Object.values(graph.entities).map(entityToNode),
    ...Object.values(graph.relationshipDefinitions).map(relationshipToNode),
  ];

  return { nodes, edges: buildEdges(graph) };
}

/**
 * The YAML file a node was parsed from, project-relative where the analyzer
 * recorded it that way. The inspector uses it to open the right file.
 */
export function sourcePathOf(node: GraphNodeData): string | undefined {
  const source = node.metadata?.source;
  return typeof source === 'string' ? source : undefined;
}
