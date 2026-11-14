import type { GraphNodeData } from '@pattern-stack/graph-components';
import type { Node, Edge } from '@xyflow/react';
import type { StudioEdgeData } from '../graph/edge-kinds';

/**
 * Card geometry, for the layout only.
 *
 * The card itself is *not* given this height — ReactFlow measures the real DOM
 * and the card renders at its natural size. An estimate that came up short
 * would otherwise clip the last field row behind the behaviour badges, and no
 * arithmetic here can stay exact as the card's type and padding change. So the
 * estimate errs high: the layout reserves a little more room than the card
 * needs, which costs some whitespace and cannot cost a clipped card — and a
 * line's channel (below) always sits below the card it leaves.
 */
const HEADER = 38;
const JUNCTION_BAR = 24;
const FIELD_ROW = 18;
const BADGE_ROW = 30;
const FIELD_PAD = 12;
/** Mirrors `VISIBLE_FIELDS` in `../graph/SchemaNode`. */
const VISIBLE_FIELDS = 7;
/** The least vertical room one line's channel gets in a gap between rows (#890). */
const CHANNEL_STEP = 22;

export function estimateNodeSize(node: GraphNodeData): { width: number; height: number } {
  const isJunction = node.kind === 'relationship';
  const shown = Math.min(node.fields?.length ?? 0, VISIBLE_FIELDS);
  const overflow = (node.fields?.length ?? 0) > VISIBLE_FIELDS ? 1 : 0;
  const badges = (node.behaviors?.length ?? 0) + (node.flags?.length ?? 0) > 0 ? BADGE_ROW : 0;

  const height =
    HEADER +
    (isJunction ? JUNCTION_BAR : 0) +
    (shown > 0 ? FIELD_PAD + (shown + overflow) * FIELD_ROW : 0) +
    badges;

  return { width: isJunction ? 230 : 250, height: Math.max(height, 56) };
}

export interface LayoutOptions {
  /** The least gap between rows; a row with many lines below it gets more. */
  spacing?: number;
  /** Gap between siblings in a row. */
  nodeSpacing?: number;
  /** Gap between two trees side by side. */
  treeSpacing?: number;
}

export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
  /** Each drawn line's data as laid out — `edges[i].data`, typed. */
  lines: StudioEdgeData[];
}

/**
 * The spine forest: each node's spine parent, from the `spine` lines only.
 *
 * A secondary line never reaches here — that is the whole of "excluded from
 * ranking". A parent that would close a cycle is ignored (the adapter's
 * `chooseSpines` already prevents one; this keeps the layout total on any
 * input rather than recursing forever).
 */
export function spineParents(present: ReadonlySet<string>, edges: readonly StudioEdgeData[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const e of edges) {
    if (e.treeRole !== 'spine') continue;
    if (!present.has(e.parent) || !present.has(e.child) || e.parent === e.child) continue;
    if (parentOf.has(e.child)) continue;
    let up: string | undefined = e.parent;
    while (up != null && up !== e.child) up = parentOf.get(up);
    if (up === e.child) continue;
    parentOf.set(e.child, e.parent);
  }
  return parentOf;
}

/**
 * Lay the graph out as a tree (STUDIO-3).
 *
 * Every node hangs under its spine parent (`StudioEdgeData.treeRole`), so the
 * picture is a forest: roots on the top row, each child directly under its
 * parent, siblings side by side in node order, each parent centred over its
 * children. Rows are top-aligned. Only spine lines are read; a secondary line
 * can be added or removed without moving a card.
 *
 * Then each line gets its own channel (#890): the lines whose upper end is in
 * one row run their horizontal segments at distinct heights in the gap below
 * it, so no two share one bar and their labels do not stack. The longest
 * runs turn first, so a fan out of one parent does not cross itself.
 *
 * ReactFlow draws the lines; where each meets its cards comes from the
 * laid-out geometry (`../graph/edge-geometry`).
 */
export function treeLayout(
  graphNodes: GraphNodeData[],
  graphEdges: StudioEdgeData[],
  options: LayoutOptions = {},
): LayoutResult {
  const { spacing = 96, nodeSpacing = 46, treeSpacing = 92 } = options;

  const sizes = new Map(graphNodes.map((n) => [n.id, estimateNodeSize(n)]));
  const present = new Set(graphNodes.map((n) => n.id));
  // A line to a node that is not on the canvas (filtered out, or a target the
  // analyzer could not resolve) has nothing to draw to.
  const drawable = graphEdges.filter((e) => present.has(e.source) && present.has(e.target));

  const parentOf = spineParents(present, drawable);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of graphNodes) {
    const parent = parentOf.get(n.id);
    if (parent == null) roots.push(n.id);
    else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), n.id]);
  }

  // Rows.
  const depth = new Map<string, number>();
  const visit = (id: string, d: number) => {
    depth.set(id, d);
    for (const c of childrenOf.get(id) ?? []) visit(c, d + 1);
  };
  for (const r of roots) visit(r, 0);
  const rows = Math.max(0, ...depth.values()) + 1;

  const rowHeight = Array.from({ length: rows }, () => 0);
  for (const [id, d] of depth) rowHeight[d] = Math.max(rowHeight[d]!, sizes.get(id)!.height);

  // The lines that run through the gap below each row: their upper end is in it.
  // The gap grows with the SPINE lines through it only — sized by every line, a
  // secondary line added or removed would move each row below it.
  const upperRow = (e: StudioEdgeData) => Math.min(depth.get(e.source)!, depth.get(e.target)!);
  const spansRows = (e: StudioEdgeData) => depth.get(e.source) !== depth.get(e.target);
  const spinesBelow = Array.from({ length: rows }, () => 0);
  for (const e of drawable) if (e.treeRole === 'spine' && spansRows(e)) spinesBelow[upperRow(e)]!++;
  const gap = spinesBelow.map((n) => Math.max(spacing, (n + 1) * CHANNEL_STEP));

  const rowY: number[] = [];
  let y = 0;
  for (let d = 0; d < rows; d++) {
    rowY.push(y);
    y += rowHeight[d]! + gap[d]!;
  }

  // Columns: a subtree is as wide as its card or its children side by side.
  const span = new Map<string, number>();
  const widthOf = (id: string): number => {
    const kids = childrenOf.get(id) ?? [];
    const kidsWidth = kids.reduce((sum, c) => sum + widthOf(c), 0) + nodeSpacing * Math.max(0, kids.length - 1);
    const w = Math.max(sizes.get(id)!.width, kidsWidth);
    span.set(id, w);
    return w;
  };
  const x = new Map<string, number>();
  const place = (id: string, left: number) => {
    const w = span.get(id)!;
    x.set(id, left + (w - sizes.get(id)!.width) / 2);
    const kids = childrenOf.get(id) ?? [];
    const kidsWidth = kids.reduce((sum, c) => sum + span.get(c)!, 0) + nodeSpacing * Math.max(0, kids.length - 1);
    let cursor = left + (w - kidsWidth) / 2;
    for (const c of kids) {
      place(c, cursor);
      cursor += span.get(c)! + nodeSpacing;
    }
  };
  let left = 0;
  for (const r of roots) {
    widthOf(r);
    place(r, left);
    left += span.get(r)! + treeSpacing;
  }

  // Channels.
  const centreX = (id: string) => x.get(id)! + sizes.get(id)!.width / 2;
  const channelY = new Map<string, number>();
  for (let d = 0; d < rows; d++) {
    const lines = drawable
      .filter((e) => spansRows(e) && upperRow(e) === d)
      .map((e) => {
        const upper = depth.get(e.source) === d ? e.source : e.target;
        const lower = upper === e.source ? e.target : e.source;
        return { id: e.id, run: Math.abs(centreX(lower) - centreX(upper)), lowerX: centreX(lower) };
      })
      .sort((a, b) => b.run - a.run || a.lowerX - b.lowerX || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const bottom = rowY[d]! + rowHeight[d]!;
    lines.forEach((l, i) => channelY.set(l.id, bottom + ((i + 1) * gap[d]!) / (lines.length + 1)));
  }

  const nodes: Node[] = graphNodes.map((n) => ({
    id: n.id,
    position: { x: x.get(n.id)!, y: rowY[depth.get(n.id)!]! },
    data: { ...n },
    type: 'schemaNode',
    // Width only. Height is left to the card so its content is never clipped
    // by an estimate that drifted from the markup.
    style: { width: sizes.get(n.id)!.width },
  }));

  const lines: StudioEdgeData[] = drawable.map((e) => {
    const channel = channelY.get(e.id);
    return channel != null ? { ...e, channelY: channel } : e;
  });
  const edges: Edge[] = lines.map((data) => ({
    id: data.id,
    source: data.source,
    target: data.target,
    type: 'schemaEdge',
    data: { ...data },
  }));

  return { nodes, edges, lines };
}
