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
 *  - graph.edges                      → StudioEdgeData, classified by kind,
 *                                       one line per foreign key
 *  - each relationship definition      → a pair of junction edges through it
 */
import type { GraphNodeData } from '@pattern-stack/graph-components';
import type { SerializedDomainGraph } from '@studio-shared';
import { pairedLabel } from '../graph/edge-kinds';
import type { StudioEdgeData, StudioEdgeKind } from '../graph/edge-kinds';
import { RELATIONSHIPS_KEY, ROLES_KEY } from '../inspector/surface-kinds';

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

/**
 * The relation an inline edge draws, spelled as REL-1 spells its origin and
 * the derived surface keys `relations` — `<from>.relationships.<name>`, or
 * `<from>.roles.<role>` for a role-derived edge. Built from the edge's own
 * fields so nothing downstream ever has to take an id apart.
 */
export function relationIdOf(edge: SerializedEdge): string {
  const role = roleOf(edge.relationship);
  return role != null
    ? `${edge.from}.${ROLES_KEY}.${role}`
    : `${edge.from}.${RELATIONSHIPS_KEY}.${edge.relationship.name}`;
}

/** The library's coarse renderer hint for a Studio edge kind. */
function libraryType(kind: StudioEdgeKind): StudioEdgeData['type'] {
  if (kind === 'junction') return 'junction';
  if (kind === 'belongs_to' || kind === 'role') return 'fk';
  return 'inline';
}

/**
 * The foreign key an inline edge draws, as one string — `<holder>|<column>|<referenced>`.
 *
 * A `belongs_to` names the column on its own entity (`from`); its inverse
 * `has_many` / `has_one` names the same column on the entity it points at
 * (`to`). Keying on the column, not on the entity pair, is the point (#778):
 * two foreign keys onto one table are two relations and stay two lines.
 * `undefined` when the edge names no column — nothing to pair it on.
 */
function foreignKeyOf(edge: SerializedEdge): string | undefined {
  const column = edge.relationship.foreignKey;
  if (column == null || column === '') return undefined;
  return edge.relationship.type === 'belongs_to'
    ? `${edge.from}|${column}|${edge.to}`
    : `${edge.to}|${column}|${edge.from}`;
}

/**
 * Build edges from a serialized graph.
 *
 * Two families:
 * 1. Inline edges from `graph.edges` — belongs_to / has_many / has_one / role.
 * 2. Junction edges — each relationship definition becomes a node with an
 *    edge in from its `from` entity and an edge out to its `to` entity.
 *
 * **One line per foreign key (#778).** A `belongs_to` and the `has_many` /
 * `has_one` that inverts it are one relationship, so they draw as one line:
 * the `belongs_to`'s (FK holder → referenced entity), labelled with both ends
 * and carrying the inverse's id as `inverseRelationId`. They are paired on the
 * foreign key (`foreignKeyOf`), never on the entity pair. A `has_many` with no
 * matching `belongs_to` still draws on its own.
 *
 * An `N:M` edge whose relationship names a junction is skipped: the junction
 * node pair already expresses it, and keeping both draws the edge twice.
 *
 * **The canvas therefore counts differently from the API, on purpose.** One
 * first-class relationship is a single `N:M` entry in `graph.edges`, but a node
 * plus two edges here — because the relationship carries its own fields, types
 * and temporal/sourced flags, and a line has nowhere to put them — and an
 * inverse pair is two entries in `graph.edges` but one line here. A graph the
 * API reports as 3 entities and 5 edges (two `belongs_to`, their two inverse
 * `has_many`, one junction) draws as 4 nodes and 4 edges. That is not drift
 * between the two; do not "fix" it by keeping the skipped edge, by dropping the
 * junction node, or by drawing each inverse again.
 *
 * An inline edge carries `relationId`, the key the edge panel looks its
 * methods up by — for a paired line, the `belongs_to`'s, whose `inverseOf` the
 * panel follows to show the other side. A junction half carries none — it is
 * half of a pairing, not a declared relation — and the panel says so rather
 * than showing nothing.
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

  const inline = graph.edges.filter(
    (e) => !(e.cardinality === 'N:M' && junctionNames.has(e.relationship.name)),
  );

  // The inverse each `belongs_to` absorbs, found before anything is drawn so
  // the order the two halves arrive in does not matter.
  const owners = new Map<string, SerializedEdge>();
  for (const e of inline) {
    const fk = foreignKeyOf(e);
    if (e.relationship.type === 'belongs_to' && fk != null && !owners.has(fk)) owners.set(fk, e);
  }
  const inverses = new Map<SerializedEdge, SerializedEdge>();
  for (const e of inline) {
    if (e.relationship.type === 'belongs_to') continue;
    const fk = foreignKeyOf(e);
    const owner = fk != null ? owners.get(fk) : undefined;
    if (owner != null && !inverses.has(owner)) inverses.set(owner, e);
  }
  const absorbed = new Set(inverses.values());

  for (const e of inline) {
    if (absorbed.has(e)) continue;

    const kind = classifyEdge(e);
    const roleName = roleOf(e.relationship);
    const ownLabel = roleName ?? e.relationship.name;
    const inverse = inverses.get(e);
    // A `belongs_to` points at its parent; an unpaired inverse points away from it.
    const pointsAtParent = e.relationship.type === 'belongs_to';

    push({
      id: `${kind}-${e.from}-${e.relationship.name}-${e.to}`,
      source: e.from,
      target: e.to,
      parent: pointsAtParent ? e.to : e.from,
      child: pointsAtParent ? e.from : e.to,
      cardinality: e.cardinality,
      label: inverse ? pairedLabel(ownLabel, inverse.relationship.name) : ownLabel,
      type: libraryType(kind),
      bidirectional: e.bidirectional,
      studioKind: kind,
      roleName,
      relationId: relationIdOf(e),
      ...(inverse ? { inverseRelationId: relationIdOf(inverse) } : {}),
    });
  }

  for (const relDef of Object.values(graph.relationshipDefinitions)) {
    // The junction row holds both foreign keys, so it ranks below both ends.
    push({
      id: `junction-${relDef.from}-${relDef.name}`,
      source: relDef.from,
      target: relDef.name,
      parent: relDef.from,
      child: relDef.name,
      cardinality: '1:N',
      type: 'junction',
      studioKind: 'junction',
    });
    push({
      id: `junction-${relDef.name}-${relDef.to}`,
      source: relDef.name,
      target: relDef.to,
      parent: relDef.to,
      child: relDef.name,
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
