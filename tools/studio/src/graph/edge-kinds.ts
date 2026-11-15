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
import { cssColor } from '../theme/theme';
import type { ThemedColor } from '../theme/theme';

export type StudioEdgeKind = 'belongs_to' | 'has_many' | 'has_one' | 'junction' | 'role' | 'inherits';

/** A library edge carrying Studio's finer classification. */
export interface StudioEdgeData extends GraphEdgeData {
  studioKind: StudioEdgeKind;
  /** The `roles:` entry this edge was derived from, when `studioKind` is `role`. */
  roleName?: string;
  /**
   * The relation this line draws, as REL-1 spells its origin and the derived
   * surface keys it — `contact.relationships.account`. Set where the edge is
   * built (`adapters/schema-adapter.ts`), never parsed back out of `id`.
   * Absent on a junction's two halves: neither is a declared relation.
   */
  relationId?: string;
  /**
   * The inverse `has_many` / `has_one` this line also draws (#778). A
   * `belongs_to` and its inverse are one foreign key, so the canvas draws them
   * as one line — the `belongs_to`'s — and the inverse rides along here, keyed
   * the same way as `relationId`. Absent when nothing was paired.
   */
  inverseRelationId?: string;
  /**
   * The two ends for ranking only (#778): `parent` is the referenced entity,
   * `child` the one holding the foreign key. The layout ranks parents above
   * children; what is drawn — `source` → `target`, the arrowhead — is
   * unchanged. Set where the edge is built, because only the adapter knows
   * which way a given kind points.
   */
  parent: string;
  child: string;
  /**
   * The line's place in the tree (STUDIO-3, `spine.ts`): `spine` is the one
   * parent the child hangs under and the only kind of line the layout reads;
   * `secondary` is every other foreign key, drawn lighter and never ranked.
   */
  treeRole: TreeRole;
  /** Why — `spine: on_delete: cascade`, `secondary: chart's spine is catalog (…)`. Shown on the line. */
  treeReason: string;
  /**
   * The y of this line's horizontal run, in flow coordinates (#890): each line
   * between the same two rows gets its own channel, so no two share one bar.
   * Set by the layout; absent before it, or for a line between cards in one row.
   */
  channelY?: number;
}

export type TreeRole = 'spine' | 'secondary';

export interface TreeRoleStyle {
  role: TreeRole;
  /** Legend text. */
  label: string;
  description: string;
  /** Stroke opacity at rest — a secondary line sits back from the tree. */
  opacity: number;
  /** Multiplies the kind's stroke width. */
  widthScale: number;
  /** The label's opacity — a secondary line's label recedes with it. */
  labelOpacity: number;
}

/**
 * How a line's tree role modifies its kind's stroke. The colour stays the
 * kind's — a role changes weight, never hue — so this table holds no colour.
 */
export const TREE_ROLE_STYLES: Record<TreeRole, TreeRoleStyle> = {
  spine: {
    role: 'spine',
    label: 'spine',
    description: 'The parent this card hangs under — the only lines the layout reads',
    opacity: 0.85,
    widthScale: 1,
    labelOpacity: 1,
  },
  secondary: {
    role: 'secondary',
    label: 'secondary',
    description: 'Every other foreign key — drawn lighter, ignored by the layout',
    opacity: 0.38,
    widthScale: 0.7,
    labelOpacity: 0.7,
  },
};

export const TREE_ROLE_ORDER: TreeRole[] = ['spine', 'secondary'];

/**
 * The label of a line that draws a relation and its inverse — `account ⇄
 * contacts`: the `belongs_to` side's name first, then the inverse's.
 */
export function pairedLabel(own: string, inverse: string): string {
  return `${own} ⇄ ${inverse}`;
}

export interface EdgeKindStyle {
  kind: StudioEdgeKind;
  /** Legend text. */
  label: string;
  /** Longer legend description — what the edge means in the model. */
  description: string;
  /** Both themes' stroke, side by side — `edgeColor` turns it into one CSS value. */
  color: ThemedColor;
  /** SVG dash pattern, or `undefined` for a solid stroke. */
  dash?: string;
  width: number;
  /** Marker id rendered at the target end, or `null` for no arrowhead. */
  marker: string | null;
}

/**
 * Each kind carries its light and dark stroke together, so a theme is a column
 * of this table rather than a second table. Light takes the 600/700 step of the
 * dark theme's hue — the weight that holds 4.5:1 on the light canvas, where the
 * dark theme's 300/400s would wash out.
 */
export const EDGE_KIND_STYLES: Record<StudioEdgeKind, EdgeKindStyle> = {
  belongs_to: {
    kind: 'belongs_to',
    label: 'belongs_to',
    description: 'Foreign key on the source entity',
    color: { light: '#2563eb', dark: '#60a5fa' },
    width: 1.75,
    marker: 'studio-arrow-belongs-to',
  },
  has_many: {
    kind: 'has_many',
    label: 'has_many',
    description: 'Inverse of a foreign key — many on the target',
    color: { light: '#9333ea', dark: '#c084fc' },
    dash: '7 4',
    width: 1.5,
    marker: 'studio-arrow-has-many',
  },
  has_one: {
    kind: 'has_one',
    label: 'has_one',
    description: 'Inverse of a foreign key — one on the target',
    color: { light: '#9333ea', dark: '#c084fc' },
    dash: '2 4',
    width: 1.5,
    marker: 'studio-arrow-has-many',
  },
  junction: {
    kind: 'junction',
    label: 'junction',
    description: 'Many-to-many through a junction table',
    color: { light: '#047857', dark: '#34d399' },
    width: 2.25,
    marker: null,
  },
  role: {
    kind: 'role',
    label: 'role',
    description: 'Named edge to an actor entity, derived from `roles:`',
    color: { light: '#b45309', dark: '#fbbf24' },
    dash: '1 5',
    width: 2,
    marker: 'studio-arrow-role',
  },
  inherits: {
    kind: 'inherits',
    label: 'inherits',
    description: 'A child table joined 1:1 to its base on id (`inherits:`)',
    color: { light: '#be123c', dark: '#fb7185' },
    width: 2.75,
    marker: 'studio-arrow-inherits',
  },
};

/** Legend order — densest first, so the eye reads structure before decoration. */
export const EDGE_KIND_ORDER: StudioEdgeKind[] = [
  'belongs_to',
  'has_many',
  'has_one',
  'junction',
  'role',
  'inherits',
];

export function edgeStyle(kind: StudioEdgeKind): EdgeKindStyle {
  return EDGE_KIND_STYLES[kind];
}

/**
 * A kind's stroke as a CSS colour that follows the active theme on its own.
 * Apply it through `style`, not an SVG presentation attribute.
 */
export function edgeColor(style: EdgeKindStyle): string {
  return cssColor(style.color);
}

/** Every distinct marker the canvas has to define, with its colour. */
export const EDGE_MARKERS: { id: string; color: string }[] = Array.from(
  new Map(
    EDGE_KIND_ORDER.map((kind) => EDGE_KIND_STYLES[kind])
      .filter((s): s is EdgeKindStyle & { marker: string } => s.marker !== null)
      .map((s) => [s.marker, { id: s.marker, color: edgeColor(s) }]),
  ).values(),
);
