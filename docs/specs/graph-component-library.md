# Graph Component Library Spec

> **Status:** Draft
> **Date:** 2026-04-15
> **Owner:** Doug

---

## Overview

A renderer-agnostic React component library for visualizing entity-relationship graphs, built on atomic design principles. Serves two use cases from the same components:

1. **Schema graph** — visualize codegen entity/relationship YAML definitions (the data model architecture)
2. **Instance graph** — visualize live entity records and their relationships (knowledge graph, like dealbrain)

The components are pure React with no rendering-engine dependency. Viewer applications compose them onto a ReactFlow canvas.

---

## Architecture

```
@pattern-stack/graph-components     ← pure React, renderer-agnostic
├── atoms/
├── molecules/
├── organisms/
├── hooks/
├── types/                          ← semantic data types (GraphNodeData, GraphEdgeData)
└── theme/

tools/schema-graph-viewer/          ← ReactFlow + elkjs DAG, consumes components
├── canvas/                         ← ReactFlow provider, custom edge renderers
├── layout/                         ← elkjs DAG layout
├── adapters/                       ← SchemaAdapter (DomainGraph → semantic types)
└── App.tsx

tools/instance-graph-viewer/        ← ReactFlow + force layout (future)
├── canvas/
├── layout/                         ← force-directed layout
├── adapters/                       ← InstanceAdapter (DB records → semantic types)
└── App.tsx
```

### Key principle

Components are **renderer-agnostic**. They export React components that can be placed anywhere — inside a ReactFlow custom node, in a sidebar panel, or in a standalone detail page. The viewer apps own the ReactFlow integration.

---

## Package: @pattern-stack/graph-components

### Location

`packages/graph-components/` within codegen-patterns (local package). Extract to npm later if needed.

### Dependencies

- `react` (peer)
- `tailwindcss` (peer, for utility classes + CSS variable theming)
- No ReactFlow, no elkjs, no layout libraries — this package is renderer-agnostic
- Edge rendering, layout, and canvas integration live in the viewer apps

### Atoms

Smallest visual building blocks. Stateless, purely presentational.

#### `Badge`
Pill-shaped label with color variants.
```ts
interface BadgeProps {
  label: string;
  variant: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' | 'muted';
  size?: 'sm' | 'md';
  icon?: ReactNode;
}
```
Use cases: family badge (`synced`, `activity`), cardinality (`1:N`), behavior (`timestamps`), flags (`temporal`, `sourced`).

#### `FieldRow`
Single field display with name, type, and optional indicators.
```ts
interface FieldRowProps {
  name: string;
  type?: string;           // "uuid", "string", "enum", etc.
  value?: string;          // For instance graph: actual field value
  badge?: 'pk' | 'fk' | 'required' | 'nullable' | 'unique' | 'indexed';
  muted?: boolean;         // De-emphasized (system fields like created_at)
}
```

#### `TypePill`
Relationship type tag with optional direction indicator.
```ts
interface TypePillProps {
  label: string;           // "employed_by", "champion"
  direction?: 'directed' | 'bidirectional' | 'inverse';
  active?: boolean;        // Highlighted state
  onClick?: () => void;
}
```

#### `Icon`
Entity/relationship/behavior icons. Uses a fixed icon set (not an icon library).
```ts
interface IconProps {
  name: 'entity' | 'relationship' | 'field' | 'key' | 'link'
      | 'temporal' | 'sourced' | 'behavior' | 'query'
      | 'person' | 'organization' | 'opportunity' | 'engagement';
  size?: 'sm' | 'md' | 'lg';
}
```

#### `DirectionIndicator`
Arrow showing from → to direction.
```ts
interface DirectionIndicatorProps {
  from: string;
  to: string;
  selfReferential?: boolean;
}
```

#### `Tooltip`
Hover-triggered detail popup.
```ts
interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}
```

### Molecules

Combinations of atoms for common patterns.

#### `NodeHeader`
Entity or relationship name with icon and optional badge.
```ts
interface NodeHeaderProps {
  icon: IconProps['name'];
  label: string;
  badge?: BadgeProps;
  subtitle?: string;       // e.g., table name, record count
  selected?: boolean;
}
```

#### `FieldList`
Scrollable/collapsible list of FieldRow atoms, grouped by category.
```ts
interface FieldListProps {
  fields: FieldRowProps[];
  groups?: { label: string; filter: (f: FieldRowProps) => boolean }[];
  maxVisible?: number;     // Collapse after N rows, show "+X more"
  compact?: boolean;       // Reduced spacing for node rendering
}
```

#### `TypeBadgeRow`
Row of TypePill atoms for relationship types.
```ts
interface TypeBadgeRowProps {
  types: TypePillProps[];
  maxVisible?: number;     // Collapse after N, show "+X more"
}
```

#### `BehaviorBadgeRow`
Row of Badge atoms for entity behaviors.
```ts
interface BehaviorBadgeRowProps {
  behaviors: string[];     // ["timestamps", "soft_delete", "user_tracking"]
}
```

#### `SearchFilterBar`
Text search + toggle filters.
```ts
interface SearchFilterBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  filters: { key: string; label: string; active: boolean; count?: number }[];
  onFilterToggle: (key: string) => void;
}
```

### Organisms

Complex, self-contained components.

#### `GraphNode`
The primary node component. Renders an entity or relationship as a card.
```ts
interface GraphNodeProps<T = unknown> {
  data: GraphNodeData<T>;
  selected?: boolean;
  dimmed?: boolean;        // When another node is selected
  compact?: boolean;       // Reduced detail (zoomed out)
  onClick?: () => void;
  onHover?: (hovering: boolean) => void;
}
```
Internally composes: NodeHeader + FieldList + BehaviorBadgeRow (for entities) or NodeHeader + DirectionIndicator + TypeBadgeRow + FlagRow (for relationships).

Rendering varies by `data.kind`:
- `'entity'` → entity card with fields and behaviors
- `'relationship'` → junction card with from→to, types, flags
- `'record'` → instance card with field values (instance graph)

#### `DetailPanel`
Slide-out panel showing full node details when selected.
```ts
interface DetailPanelProps<T = unknown> {
  node: GraphNodeData<T> | null;
  onClose: () => void;
  width?: number;
}
```
Renders full field list (not collapsed), all types with direction metadata, queries, source file path (schema) or record metadata (instance).

#### `GraphLegend`
Color/shape legend overlay.
```ts
interface GraphLegendProps {
  items: { icon: IconProps['name']; label: string; color: string }[];
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
}
```

#### `StatusBar`
Bottom bar with graph statistics and warnings.
```ts
interface StatusBarProps {
  stats: { label: string; value: number | string }[];
  warnings?: string[];     // Orphan entities, circular deps
}
```

### Types

Two layers: **semantic data** (domain facts, renderer-agnostic) and **component props** (presentation). Adapters produce semantic data. Components map it to presentation internally.

```ts
/**
 * Semantic node data — domain facts, no presentation coupling.
 * This is what adapters produce. Components consume this and
 * internally decide how to render it (which atoms, which layout).
 *
 * T is the source-specific payload (ParsedEntity, DatabaseRecord, etc.)
 */
interface GraphNodeData<T = unknown> {
  id: string;
  label: string;
  subtitle?: string;
  kind: 'entity' | 'relationship' | 'record';

  // Visual grouping
  group?: string;          // family, entity type, category

  // Fields as domain data, not component props
  fields?: {
    name: string;
    type?: string;         // "uuid", "string", "enum"
    value?: string;        // Instance graph: actual value
    role?: 'pk' | 'fk' | 'required' | 'nullable';
    system?: boolean;      // created_at, updated_at — de-emphasized
  }[];

  // Behaviors / flags as strings, not Badge props
  behaviors?: string[];    // ["timestamps", "soft_delete"]
  flags?: string[];        // ["temporal", "sourced"]

  // Relationship-specific (semantic, not presentational)
  from?: string;
  to?: string;
  selfReferential?: boolean;
  types?: {
    name: string;
    direction?: 'directed' | 'bidirectional' | 'inverse';
    inverseName?: string;
  }[];

  // Counts
  fieldCount?: number;
  queryCount?: number;

  // Extensible metadata
  metadata?: Record<string, unknown>;

  // Source payload (for detail panel)
  source?: T;
}

/**
 * Semantic edge data — also domain facts, not renderer props.
 * The viewer app maps these to ReactFlow edges (or whatever renderer).
 */
interface GraphEdgeData {
  id: string;
  source: string;          // Node ID
  target: string;          // Node ID
  cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M';
  label?: string;
  type: 'fk' | 'junction' | 'inline';
  bidirectional?: boolean;
}
```

### Hooks

#### `useGraphData<T>(raw: T[], adapter: GraphAdapter<T>)`
Transforms raw domain data into GraphNodeData[] and GraphEdgeData[].

```ts
interface GraphAdapter<T> {
  toNodes(data: T[]): GraphNodeData<T>[];
  toEdges(data: T[]): GraphEdgeData[];
}
```

#### `useGraphSelection(nodeId: string | null)`
Returns `{ selectedNode, connectedNodeIds, connectedEdgeIds, isConnected(id) }`.
Used by GraphNode/GraphEdge to determine `selected`/`dimmed` state.

#### `useGraphFilter(nodes, edges, options)`
Filters nodes/edges by text query and toggle filters. Returns filtered sets.

### What lives in the viewer, NOT the component library

These are renderer-specific and belong in `tools/schema-graph-viewer/` (or instance viewer):

- **Edge rendering** — path geometry, handles, and labels are tied to the canvas layer (ReactFlow)
- **Layout algorithms** — elkjs (DAG) and force-directed positioning depend on the viewport model
- **Canvas infrastructure** — ReactFlowProvider, MiniMap, Controls, Background
- **Adapters** — SchemaAdapter and InstanceAdapter are consumer-specific

### Theme

CSS variable-based theming.

```ts
interface GraphTheme {
  // Node colors by kind
  entityColor: string;
  relationshipColor: string;
  recordColor: string;

  // Group colors (mapped to family/entity type)
  groupColors: Record<string, string>;

  // Badge variants
  badgeColors: Record<BadgeProps['variant'], { bg: string; text: string; border: string }>;

  // Edge colors
  edgeFk: string;
  edgeJunction: string;
  edgeInline: string;

  // Surface
  nodeBg: string;
  nodeBorder: string;
  nodeSelectedBorder: string;
  panelBg: string;

  // Typography
  fontFamily: string;
  fontSize: { sm: string; md: string; lg: string };
}
```

Shipped with `light` and `dark` presets. Consumers can override via CSS variables.

---

## Viewer: Schema Graph (tools/schema-graph-viewer/)

First consumer. Visualizes codegen YAML definitions.

### Dependencies
- `@pattern-stack/graph-components` (local)
- `@xyflow/react`
- `elkjs`
- `vite` + `react` + `tailwindcss`

### Data flow
```
CLI: codegen project graph
  → analyzeDomain(entitiesDir, relationshipsDir)
  → serialize DomainGraph to JSON
  → write to temp file or serve via tiny HTTP server
  → open browser to schema-graph-viewer

Viewer:
  → fetch graph.json
  → SchemaAdapter maps DomainGraph → GraphNodeData[] + GraphEdgeData[]
  → elkLayout positions nodes (left-to-right DAG)
  → ReactFlow renders with custom GraphNode/GraphEdge components
```

### SchemaAdapter

```ts
// Maps ParsedEntity → GraphNodeData<ParsedEntity>
function entityToNode(entity: ParsedEntity): GraphNodeData<ParsedEntity> {
  return {
    id: entity.name,
    label: pascalCase(entity.name),
    subtitle: entity.table,
    kind: 'entity',
    group: entity.family ?? 'base',
    fields: Array.from(entity.fields.values()).map(fieldToFieldRow),
    badges: entity.behaviors.map(b => ({ label: b, variant: 'muted' })),
    fieldCount: entity.fields.size,
    queryCount: entity.queries?.length ?? 0,
    source: entity,
  };
}

// Maps ParsedRelationshipDefinition → GraphNodeData<ParsedRelationshipDefinition>
function relationshipToNode(rel: ParsedRelationshipDefinition): GraphNodeData<...> {
  return {
    id: rel.name,
    label: pascalCase(rel.name),
    subtitle: rel.table,
    kind: 'relationship',
    from: rel.from,
    to: rel.to,
    direction: { from: rel.from, to: rel.to, selfReferential: rel.selfReferential },
    temporal: rel.temporal,
    sourced: rel.sourced,
    tags: rel.types.map(t => ({ label: t.name, direction: ... })),
    fieldCount: rel.fields.size,
    queryCount: rel.queries?.length ?? 0,
    source: rel,
  };
}

// Maps edges: entity→junction→entity for relationship defs, entity→entity for inline rels
```

---

## Viewer: Instance Graph (future, dealbrain)

Second consumer. Visualizes live entity records and their relationships.

### InstanceAdapter

```ts
// Maps a database record → GraphNodeData<Record>
function recordToNode(record: EntityRecord): GraphNodeData<EntityRecord> {
  return {
    id: record.id,
    label: record.displayName,    // "Alice Smith", "Acme Corp"
    subtitle: record.entityType,  // "person", "organization"
    kind: 'record',
    group: record.entityType,
    fields: Object.entries(record.fields).map(([k, v]) => ({
      name: k,
      value: String(v),
    })),
    source: record,
  };
}
```

Uses `forceLayout` instead of `elkLayout`. Same components, different layout and data source.

---

## Build & Tooling

### Package build
- `tsup` or Vite library mode for building `packages/graph-components/`
- Exports ESM + types
- Tailwind CSS as peer dependency (consumers include the plugin)

### Viewer build
- Vite dev server for development
- Static build for embedding / CLI usage

### Testing
- Vitest for unit tests (hooks, adapters, layout functions)
- Storybook for component development and visual review (optional, nice-to-have)

### Storybook (optional)
Each atom/molecule/organism gets a story with:
- Default state
- Selected/dimmed/compact variants
- Schema vs instance data examples
- Dark/light theme toggle

---

## Implementation Order

### Phase 1: Foundation
1. Set up `packages/graph-components/` with build tooling
2. Implement types (GraphNodeData, GraphEdgeData, GraphAdapter)
3. Implement theme (CSS variables, light/dark presets)
4. Implement atoms (Badge, FieldRow, TypePill, Icon, DirectionIndicator, Tooltip)

### Phase 2: Composition
5. Implement molecules (NodeHeader, FieldList, TypeBadgeRow, BehaviorBadgeRow, SearchFilterBar)
6. Implement organisms (GraphNode, GraphEdge, DetailPanel, GraphLegend, StatusBar)
7. Implement hooks (useGraphData, useGraphSelection, useGraphFilter)
8. Implement layout functions (elkLayout, forceLayout)

### Phase 3: Schema Viewer
9. Set up `tools/schema-graph-viewer/` with Vite + ReactFlow
10. Implement SchemaAdapter (DomainGraph → GraphNodeData/GraphEdgeData)
11. Wire up: CLI command → JSON export → viewer → ReactFlow canvas
12. End-to-end test with codegen fixtures

### Phase 4: Polish & Instance Viewer
13. Detail panel, legend, status bar integration
14. InstanceAdapter for dealbrain (separate project/PR)
15. Storybook (if desired)

---

## Scope & Extensibility

The component library and schema viewer support what exists in the codegen pipeline today: entities, inline relationships, and first-class relationship definitions. The evolution docs describe additional concepts (dimension sets, display system, entity store, history tables) that are not yet implemented in the pipeline.

**The types are designed to be extensible:**
- `GraphNodeData.kind` can be extended with `'dimension'`, `'history'`, `'system'` when those features land
- `GraphNodeData.metadata` is an open `Record<string, unknown>` for future domain-specific data
- `GraphNodeData.flags` and `GraphNodeData.behaviors` are string arrays, not closed enums

When dimension sets are added to the codegen pipeline, the schema adapter adds a new mapping function and the viewer gets new node types. The component library atoms (Badge, FieldRow, etc.) don't change.

---

## Open Questions

1. **Package location**: `packages/graph-components/` in codegen-patterns, or a separate repo under pattern-stack?
2. **Tailwind vs CSS modules**: Tailwind utilities + CSS variables, or CSS modules for full isolation?
3. **Storybook**: Include from day one, or add later?
4. **CLI integration**: `codegen project graph` as the command name? Or `codegen graph`?
5. **Data serving**: Write JSON to tmp file + open static HTML, or spawn a tiny dev server with hot reload?
