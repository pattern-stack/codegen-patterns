/**
 * SchemaAdapter — maps DomainGraph types to GraphNodeData/GraphEdgeData.
 *
 * This is the bridge between the codegen analyzer output and the
 * graph component library's semantic types.
 *
 * Mappings:
 *  - ParsedEntity          → GraphNodeData (kind: 'entity')
 *  - ParsedRelationshipDef → GraphNodeData (kind: 'relationship')
 *  - Inline belongs_to/has_many → GraphEdgeData (type: 'inline')
 *  - Junction from/to      → GraphEdgeData (type: 'junction')
 */
import type { GraphNodeData, GraphEdgeData } from '@pattern-stack/graph-components';

// -- Domain types (mirrored from src/analyzer/types.ts for the viewer)
// The viewer receives serialized JSON, so Maps become arrays/objects.

export interface SerializedField {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  foreignKey?: { table: string; column: string };
  choices?: string[];
}

export interface SerializedRelationship {
  name: string;
  type: 'belongs_to' | 'has_many' | 'has_one';
  target: string;
  foreignKey: string;
  inverse?: string;
  through?: string;
  resolved: boolean;
}

export interface SerializedQuery {
  by: string[];
  unique?: boolean;
  select?: string[];
  order?: string;
  limit?: boolean;
  via?: string;
}

export interface SerializedEntity {
  name: string;
  plural: string;
  table: string;
  family?: string;
  fields: Record<string, SerializedField> | [string, SerializedField][];
  relationships: Record<string, SerializedRelationship> | [string, SerializedRelationship][];
  behaviors: string[];
  queries?: SerializedQuery[];
  sourcePath: string;
}

export interface SerializedTypeDirection {
  name: string;
  inverse?: string;
  bidirectional: boolean;
  directed: boolean;
}

export interface SerializedRelationshipDefinition {
  name: string;
  table: string;
  from: string;
  to: string;
  selfReferential: boolean;
  fromColumn: string;
  toColumn: string;
  types: SerializedTypeDirection[];
  hasTypes: boolean;
  temporal: boolean;
  sourced: boolean;
  onDeleteFrom: string;
  onDeleteTo: string;
  uniqueOn: string[];
  fields: Record<string, SerializedField> | [string, SerializedField][];
  queries?: SerializedQuery[];
  sourcePath: string;
}

export interface SerializedRelationshipEdge {
  from: string;
  to: string;
  relationship: SerializedRelationship;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  bidirectional: boolean;
}

export interface SerializedDomainGraph {
  entities: Record<string, SerializedEntity> | [string, SerializedEntity][];
  relationshipDefinitions: Record<string, SerializedRelationshipDefinition> | [string, SerializedRelationshipDefinition][];
  edges: SerializedRelationshipEdge[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pascalCase(s: string): string {
  return s
    .split(/[_\-\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toFieldEntries(
  fields: Record<string, SerializedField> | [string, SerializedField][],
): [string, SerializedField][] {
  if (Array.isArray(fields)) return fields;
  return Object.entries(fields);
}

function fieldRole(f: SerializedField): 'pk' | 'fk' | 'required' | 'nullable' {
  if (f.name === 'id') return 'pk';
  if (f.foreignKey) return 'fk';
  if (f.required) return 'required';
  return 'nullable';
}

function isSystemField(name: string): boolean {
  return ['id', 'created_at', 'updated_at', 'deleted_at', 'created_by', 'updated_by'].includes(name);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function entityToNode(entity: SerializedEntity): GraphNodeData<SerializedEntity> {
  const fieldEntries = toFieldEntries(entity.fields);

  return {
    id: entity.name,
    label: pascalCase(entity.name),
    subtitle: entity.table,
    kind: 'entity',
    group: entity.family ?? 'base',
    fields: fieldEntries.map(([, f]) => ({
      name: f.name,
      type: f.type,
      role: fieldRole(f),
      system: isSystemField(f.name),
    })),
    behaviors: entity.behaviors,
    fieldCount: fieldEntries.length,
    queryCount: entity.queries?.length ?? 0,
    source: entity,
  };
}

export function relationshipToNode(
  rel: SerializedRelationshipDefinition,
): GraphNodeData<SerializedRelationshipDefinition> {
  const fieldEntries = toFieldEntries(rel.fields);
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
    fields: fieldEntries.map(([, f]) => ({
      name: f.name,
      type: f.type,
      role: fieldRole(f),
      system: isSystemField(f.name),
    })),
    fieldCount: fieldEntries.length,
    queryCount: rel.queries?.length ?? 0,
    source: rel,
  };
}

/**
 * Build edges from a serialized DomainGraph.
 *
 * Two kinds of edges:
 * 1. Inline edges (from DomainGraph.edges) — direct belongs_to/has_many/has_one
 * 2. Junction edges — for each relationship definition, create entity→junction and junction→entity
 */
export function buildEdges(
  graph: SerializedDomainGraph,
): GraphEdgeData[] {
  const edges: GraphEdgeData[] = [];

  const relDefs = Array.isArray(graph.relationshipDefinitions)
    ? new Map(graph.relationshipDefinitions)
    : new Map(Object.entries(graph.relationshipDefinitions));

  // Collect relationship def names to avoid duplicating them as inline edges
  const junctionNames = new Set(relDefs.keys());

  // 1. Inline edges from the graph's edge list
  for (const e of graph.edges) {
    // Skip edges that correspond to junction relationships — we model those differently
    if (e.cardinality === 'N:M' && junctionNames.has(e.relationship.name)) {
      continue;
    }

    edges.push({
      id: `inline-${e.from}-${e.relationship.name}-${e.to}`,
      source: e.from,
      target: e.to,
      cardinality: e.cardinality,
      label: e.relationship.name,
      type: 'inline',
      bidirectional: e.bidirectional,
    });
  }

  // 2. Junction edges: entity ← junction → entity
  for (const [, relDef] of relDefs) {
    // From-entity → junction node
    edges.push({
      id: `junction-${relDef.from}-${relDef.name}`,
      source: relDef.from,
      target: relDef.name,
      cardinality: '1:N',
      type: 'junction',
    });

    // Junction node → to-entity
    edges.push({
      id: `junction-${relDef.name}-${relDef.to}`,
      source: relDef.name,
      target: relDef.to,
      cardinality: 'N:1',
      type: 'junction',
    });
  }

  return edges;
}

/**
 * Convert a serialized DomainGraph to GraphNodeData[] and GraphEdgeData[].
 * This is the main entry point for the SchemaAdapter.
 */
export function adaptDomainGraph(graph: SerializedDomainGraph): {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
} {
  const entities = Array.isArray(graph.entities)
    ? graph.entities
    : Object.entries(graph.entities);

  const relDefs = Array.isArray(graph.relationshipDefinitions)
    ? graph.relationshipDefinitions
    : Object.entries(graph.relationshipDefinitions);

  const nodes: GraphNodeData[] = [
    ...entities.map(([, entity]) => entityToNode(entity)),
    ...relDefs.map(([, relDef]) => relationshipToNode(relDef)),
  ];

  const edges = buildEdges(graph);

  return { nodes, edges };
}
