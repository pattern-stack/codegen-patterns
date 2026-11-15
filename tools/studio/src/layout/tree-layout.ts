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

/** The aspect a layout is packed for when the canvas has not been measured: 16:10. */
export const DEFAULT_TARGET_ASPECT = 16 / 10;

export interface LayoutOptions {
  /** The least gap between rows; a row with many lines below it gets more. */
  spacing?: number;
  /** Gap between siblings in a row. */
  nodeSpacing?: number;
  /** Gap between two trees side by side in one row of blocks. */
  treeSpacing?: number;
  /** Gap between two rows of blocks (STUDIO-4). */
  blockRowSpacing?: number;
  /**
   * Width ÷ height the blocks are wrapped to (STUDIO-4) — the canvas
   * container's, measured by the caller. The layout never reads the DOM.
   */
  targetAspect?: number;
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

/** One disconnected tree, laid out on its own with its top-left card corner at (0, 0). */
interface Block {
  root: string;
  ids: string[];
  /** Each card's row in the block, and the block's own row tops, heights and gaps below. */
  depth: Map<string, number>;
  rowY: number[];
  rowHeight: number[];
  gap: number[];
  /** Each card's x within the block. */
  x: Map<string, number>;
  width: number;
  height: number;
}

/** A block's place on the canvas. */
interface Placed {
  block: Block;
  left: number;
  top: number;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Wrap blocks into rows for a canvas of `targetAspect` (STUDIO-4).
 *
 * The blocks keep the order they are given; each row is filled left to right
 * until the next block would pass a width limit, then a new row starts. Rows
 * are left-aligned and each block is top-aligned in its row. The limit is
 * chosen from every width a row can actually have (one block, or a run of
 * consecutive blocks with their gaps): the one whose box fit-to-view shows
 * largest on a canvas of that aspect — `min(aspect / width, 1 / height)`, the
 * zoom at a canvas height of 1. That is what makes cards legible: a box whose
 * aspect matches the canvas's is not enough if it is also bigger. A tie goes
 * to the box whose aspect is nearer the canvas's (on a log scale), then to the
 * narrower limit. One block is always one row.
 */
export function packBlocks(
  sizes: readonly { width: number; height: number }[],
  targetAspect: number,
  gapX: number,
  gapY: number,
): { left: number; top: number }[] {
  if (sizes.length === 0) return [];
  const target = Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : DEFAULT_TARGET_ASPECT;

  const pack = (limit: number) => {
    const at: { left: number; top: number }[] = [];
    let left = 0;
    let top = 0;
    let rowHeight = 0;
    let width = 0;
    for (const size of sizes) {
      if (left > 0 && left + size.width > limit) {
        top += rowHeight + gapY;
        left = 0;
        rowHeight = 0;
      }
      at.push({ left, top });
      width = Math.max(width, left + size.width);
      rowHeight = Math.max(rowHeight, size.height);
      left += size.width + gapX;
    }
    return { at, width, height: top + rowHeight };
  };

  const limits = new Set<number>();
  for (let i = 0; i < sizes.length; i++) {
    let run = -gapX;
    for (let j = i; j < sizes.length; j++) {
      run += sizes[j]!.width + gapX;
      limits.add(run);
    }
  }

  const EPS = 1e-9;
  let best: { at: { left: number; top: number }[]; zoom: number; skew: number } | null = null;
  for (const limit of [...limits].sort((a, b) => a - b)) {
    const packed = pack(limit);
    const width = Math.max(packed.width, 1);
    const height = Math.max(packed.height, 1);
    const zoom = Math.min(target / width, 1 / height);
    const skew = Math.abs(Math.log(width / height / target));
    const better =
      best == null ||
      zoom > best.zoom * (1 + EPS) ||
      (zoom >= best.zoom * (1 - EPS) && skew < best.skew - EPS);
    if (better) best = { at: packed.at, zoom, skew };
  }
  return best!.at;
}

/**
 * Dock each one-card tree under the card that references it (STUDIO-4).
 *
 * A block of exactly one card whose card is the parent end of a secondary
 * line from a card C in a block B of more than one card is not wrapped by
 * `packBlocks`: it becomes part of B, x-centred under C, its top at B's bottom
 * (B's lowest card) plus the normal row spacing — a row of its own below B's
 * rows — and B's footprint includes it. Its place relative to B is fixed, so
 * it is the same at every canvas width.
 *
 * - One referencer: if cards in several blocks reference it, it docks under
 *   the first secondary line in `lines` order — the order the adapter lists
 *   the edges in, which is the analyzer's: declaration order.
 * - No chains: it docks only under a card of a block of more than one card, so
 *   never under another one-card tree, docked or not; a one-card tree
 *   referenced only by one-card trees wraps as before.
 * - Two docked under one block whose spots would overlap keep their
 *   referencers' left-to-right order and are pushed apart just enough to clear
 *   by the sibling gap — each overlapping run centred on its members' spots.
 *   If that pushes one left of the block's edge, the whole block shifts right
 *   so its left edge stays at 0; nothing inside it moves relative to the rest.
 * - A multi-card tree that is the parent end of a secondary line is untouched
 *   (#778's narrowing): it wraps by its block's size and may sit below its child.
 *
 * This is the one place a secondary line places a card: adding or removing
 * such a line docks or undocks that one card. No other card moves within its
 * block; the referencing block's footprint grows, so the packing may change.
 */
function dockLoneTrees(
  trees: Block[],
  lines: readonly StudioEdgeData[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  spacing: number,
  nodeSpacing: number,
): Block[] {
  const blockOf = new Map<string, Block>();
  for (const b of trees) for (const id of b.ids) blockOf.set(id, b);

  // Each one-card tree's referencer: the first secondary line onto it from a
  // card in a block of more than one card.
  const referencer = new Map<string, string>();
  for (const e of lines) {
    if (e.treeRole !== 'secondary' || referencer.has(e.parent)) continue;
    const lone = blockOf.get(e.parent);
    const host = blockOf.get(e.child);
    if (lone == null || host == null || lone === host) continue;
    if (lone.ids.length !== 1 || host.ids.length < 2) continue;
    referencer.set(e.parent, e.child);
  }
  if (referencer.size === 0) return trees;

  const docked = new Map<Block, { id: string; want: number; width: number; height: number }[]>();
  for (const [id, by] of referencer) {
    const host = blockOf.get(by)!;
    const size = sizes.get(id)!;
    const want = host.x.get(by)! + sizes.get(by)!.width / 2 - size.width / 2;
    docked.set(host, [...(docked.get(host) ?? []), { id, want, ...size }]);
  }

  for (const [host, cards] of docked) {
    // Referencer order left to right; a tie keeps declaration order (stable sort).
    cards.sort((a, b) => a.want + a.width / 2 - (b.want + b.width / 2));
    // Push overlapping spots apart: merge each run that would overlap and
    // centre it on the mean of its members' wanted spots.
    const runs: { cards: typeof cards; left: number; width: number }[] = [];
    for (const c of cards) {
      runs.push({ cards: [c], left: c.want, width: c.width });
      while (runs.length > 1) {
        const prev = runs[runs.length - 2]!;
        const last = runs[runs.length - 1]!;
        if (prev.left + prev.width + nodeSpacing <= last.left) break;
        const merged = [...prev.cards, ...last.cards];
        let offset = 0;
        let sum = 0;
        for (const m of merged) {
          sum += m.want - offset;
          offset += m.width + nodeSpacing;
        }
        runs.splice(runs.length - 2, 2, {
          cards: merged,
          left: sum / merged.length,
          width: offset - nodeSpacing,
        });
      }
    }

    const top = host.height + spacing;
    const rowHeight = Math.max(...cards.map((c) => c.height));
    const row = host.rowY.length;
    host.rowY.push(top);
    host.rowHeight.push(rowHeight);
    host.gap.push(spacing);
    for (const r of runs) {
      let left = r.left;
      for (const c of r.cards) {
        host.ids.push(c.id);
        host.depth.set(c.id, row);
        host.x.set(c.id, left);
        left += c.width + nodeSpacing;
      }
    }
    const minX = Math.min(0, ...cards.map((c) => host.x.get(c.id)!));
    if (minX < 0) for (const [id, x] of host.x) host.x.set(id, x - minX);
    host.width = Math.max(...host.ids.map((id) => host.x.get(id)! + sizes.get(id)!.width));
    host.height = top + rowHeight;
  }

  const dockedIds = new Set(referencer.keys());
  return trees.filter((b) => !(b.ids.length === 1 && dockedIds.has(b.root)));
}

/**
 * Lay the graph out as a forest of tree blocks (STUDIO-3, STUDIO-4).
 *
 * Every node hangs under its spine parent (`StudioEdgeData.treeRole`), so the
 * picture is a forest. Each disconnected tree is laid out as its own block:
 * its root on the block's top row, each child directly under its parent,
 * siblings side by side in node order, each parent centred over its children,
 * rows top-aligned. Only spine lines are read; a secondary line can be added
 * or removed without moving a card — except that a one-card tree a secondary
 * line reaches docks under its referencer (`dockLoneTrees`).
 *
 * The blocks are then wrapped into rows that fit `targetAspect`
 * (`packBlocks`), biggest tree first — most cards, then the root's id — so a
 * model of several trees is not one long, short strip that fit-to-view shrinks
 * past reading.
 *
 * Then each line gets its own channel (#890): the lines whose upper end is in
 * one row of a block run their horizontal segments at distinct heights in the
 * gap below it, so no two share one bar and their labels do not stack. The
 * longest runs turn first, so a fan out of one parent does not cross itself.
 *
 * ReactFlow draws the lines; where each meets its cards comes from the
 * laid-out geometry (`../graph/edge-geometry`).
 */
export function treeLayout(
  graphNodes: GraphNodeData[],
  graphEdges: StudioEdgeData[],
  options: LayoutOptions = {},
): LayoutResult {
  const {
    spacing = 96,
    nodeSpacing = 46,
    treeSpacing = 92,
    blockRowSpacing = 2 * spacing,
    targetAspect = DEFAULT_TARGET_ASPECT,
  } = options;

  const sizes = new Map(graphNodes.map((n) => [n.id, estimateNodeSize(n)]));
  const present = new Set(graphNodes.map((n) => n.id));
  // A line to a node that is not on the canvas (filtered out, or a target the
  // analyzer could not resolve) has nothing to draw to.
  const drawable = graphEdges.filter((e) => present.has(e.source) && present.has(e.target));
  const spines = drawable.filter((e) => e.treeRole === 'spine');

  const parentOf = spineParents(present, drawable);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of graphNodes) {
    const parent = parentOf.get(n.id);
    if (parent == null) roots.push(n.id);
    else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), n.id]);
  }

  const layBlock = (root: string): Block => {
    // Rows.
    const ids: string[] = [];
    const depth = new Map<string, number>();
    const visit = (id: string, d: number) => {
      ids.push(id);
      depth.set(id, d);
      for (const c of childrenOf.get(id) ?? []) visit(c, d + 1);
    };
    visit(root, 0);
    const rows = Math.max(...depth.values()) + 1;

    const rowHeight = Array.from({ length: rows }, () => 0);
    for (const [id, d] of depth) rowHeight[d] = Math.max(rowHeight[d]!, sizes.get(id)!.height);

    // The gap below each row grows with the SPINE lines through it only —
    // sized by every line, a secondary line added or removed would move each
    // row below it. A spine line never leaves its block.
    const spinesBelow = Array.from({ length: rows }, () => 0);
    for (const e of spines) {
      const ds = depth.get(e.source);
      const dt = depth.get(e.target);
      if (ds != null && dt != null && ds !== dt) spinesBelow[Math.min(ds, dt)]!++;
    }
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
    const width = widthOf(root);
    place(root, 0);

    return { root, ids, depth, rowY, rowHeight, gap, x, width, height: rowY[rows - 1]! + rowHeight[rows - 1]! };
  };

  // Biggest tree first, then by root id: the order does not depend on the
  // order the analyzer happened to list the entities in. The size is the
  // tree's own card count — a docked card (below) does not reorder blocks.
  const trees = roots.map(layBlock).sort((a, b) => b.ids.length - a.ids.length || byId(a.root, b.root));
  const blocks = dockLoneTrees(trees, drawable, sizes, spacing, nodeSpacing);
  const at = packBlocks(blocks, targetAspect, treeSpacing, blockRowSpacing);
  const placed: Placed[] = blocks.map((block, i) => ({ block, ...at[i]! }));

  const where = new Map<string, Placed>();
  for (const p of placed) for (const id of p.block.ids) where.set(id, p);
  const cardX = (id: string) => where.get(id)!.left + where.get(id)!.block.x.get(id)!;
  const cardY = (id: string) => {
    const p = where.get(id)!;
    return p.top + p.block.rowY[p.block.depth.get(id)!]!;
  };

  // Channels. A line runs through the gap below its upper card's row, in that
  // card's block; two cards level with each other join side to side and need none.
  const centreX = (id: string) => cardX(id) + sizes.get(id)!.width / 2;
  const groups = new Map<string, { id: string; run: number; lowerX: number }[]>();
  const gapOf = new Map<string, { bottom: number; gap: number }>();
  for (const e of drawable) {
    if (cardY(e.source) === cardY(e.target)) continue;
    const upper = cardY(e.source) < cardY(e.target) ? e.source : e.target;
    const lower = upper === e.source ? e.target : e.source;
    const p = where.get(upper)!;
    const d = p.block.depth.get(upper)!;
    const key = `${p.block.root}\u0000${d}`;
    gapOf.set(key, { bottom: p.top + p.block.rowY[d]! + p.block.rowHeight[d]!, gap: p.block.gap[d]! });
    const line = { id: e.id, run: Math.abs(centreX(lower) - centreX(upper)), lowerX: centreX(lower) };
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const channelY = new Map<string, number>();
  for (const [key, lines] of groups) {
    const { bottom, gap } = gapOf.get(key)!;
    lines.sort((a, b) => b.run - a.run || a.lowerX - b.lowerX || byId(a.id, b.id));
    lines.forEach((l, i) => channelY.set(l.id, bottom + ((i + 1) * gap) / (lines.length + 1)));
  }

  const nodes: Node[] = graphNodes.map((n) => ({
    id: n.id,
    position: { x: cardX(n.id), y: cardY(n.id) },
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
