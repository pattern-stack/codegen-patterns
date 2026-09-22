/**
 * The graph's edge vocabulary — one place that decides what an edge *is*, what
 * it looks like, and how the legend describes it.
 *
 * `GraphEdgeData.type` from the component library is a coarse three-value
 * renderer hint (`fk` | `junction` | `inline`); Studio needs the finer
 * distinction the model actually makes, so the semantic kind travels in
 * `StudioEdgeData.studioKind` alongside it.
 */
import type { GraphEdgeData } from '@pattern-stack/graph-components';

export type StudioEdgeKind = 'belongs_to' | 'has_many' | 'has_one' | 'junction' | 'role';

/** A library edge carrying Studio's finer classification. */
export interface StudioEdgeData extends GraphEdgeData {
  studioKind: StudioEdgeKind;
  /** The `roles:` entry this edge was derived from, when `studioKind` is `role`. */
  roleName?: string;
}

export interface EdgeKindStyle {
  kind: StudioEdgeKind;
  /** Legend text. */
  label: string;
  /** Longer legend description — what the edge means in the model. */
  description: string;
  color: string;
  /** SVG dash pattern, or `undefined` for a solid stroke. */
  dash?: string;
  width: number;
  /** Marker id rendered at the target end, or `null` for no arrowhead. */
  marker: string | null;
}

/**
 * Colours are literals rather than `--graph-*` custom properties because SVG
 * strokes are resolved by ReactFlow at render time and elkjs measures against
 * the same palette. They mirror the dark theme's edge colours.
 */
export const EDGE_KIND_STYLES: Record<StudioEdgeKind, EdgeKindStyle> = {
  belongs_to: {
    kind: 'belongs_to',
    label: 'belongs_to',
    description: 'Foreign key on the source entity',
    color: '#60a5fa',
    width: 1.75,
    marker: 'studio-arrow-belongs-to',
  },
  has_many: {
    kind: 'has_many',
    label: 'has_many',
    description: 'Inverse of a foreign key — many on the target',
    color: '#c084fc',
    dash: '7 4',
    width: 1.5,
    marker: 'studio-arrow-has-many',
  },
  has_one: {
    kind: 'has_one',
    label: 'has_one',
    description: 'Inverse of a foreign key — one on the target',
    color: '#c084fc',
    dash: '2 4',
    width: 1.5,
    marker: 'studio-arrow-has-many',
  },
  junction: {
    kind: 'junction',
    label: 'junction',
    description: 'Many-to-many through a junction table',
    color: '#34d399',
    width: 2.25,
    marker: null,
  },
  role: {
    kind: 'role',
    label: 'role',
    description: 'Named edge to an actor entity, derived from `roles:`',
    color: '#fbbf24',
    dash: '1 5',
    width: 2,
    marker: 'studio-arrow-role',
  },
};

/** Legend order — densest first, so the eye reads structure before decoration. */
export const EDGE_KIND_ORDER: StudioEdgeKind[] = [
  'belongs_to',
  'has_many',
  'has_one',
  'junction',
  'role',
];

export function edgeStyle(kind: StudioEdgeKind): EdgeKindStyle {
  return EDGE_KIND_STYLES[kind];
}

/** Every distinct marker the canvas has to define, with its colour. */
export const EDGE_MARKERS: { id: string; color: string }[] = Array.from(
  new Map(
    EDGE_KIND_ORDER.map((kind) => EDGE_KIND_STYLES[kind])
      .filter((s): s is EdgeKindStyle & { marker: string } => s.marker !== null)
      .map((s) => [s.marker, { id: s.marker, color: s.color }]),
  ).values(),
);
