import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphNodeData } from '@pattern-stack/graph-components';
import type { Node, Edge } from '@xyflow/react';
import type { StudioEdgeData } from '../graph/edge-kinds';

const elk = new ELK();

/**
 * Card geometry, for elk only.
 *
 * The card itself is *not* given this height — ReactFlow measures the real DOM
 * and the card renders at its natural size. An estimate that came up short
 * would otherwise clip the last field row behind the behaviour badges, and no
 * arithmetic here can stay exact as the card's type and padding change. So the
 * estimate errs high: elk reserves a little more room than the card needs,
 * which costs some whitespace and cannot cost a clipped card.
 */
const HEADER = 38;
const JUNCTION_BAR = 24;
const FIELD_ROW = 18;
const BADGE_ROW = 30;
const FIELD_PAD = 12;
/** Mirrors `VISIBLE_FIELDS` in `../graph/SchemaNode`. */
const VISIBLE_FIELDS = 7;

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
  direction?: 'RIGHT' | 'DOWN';
  /** Gap between layers. */
  spacing?: number;
  /** Gap between siblings within a layer. */
  nodeSpacing?: number;
}

export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Position the graph with elk and hand ReactFlow the result.
 *
 * Falls back to a grid if elk throws: a readable-but-ugly graph beats a blank
 * canvas, and the caller has no better recovery than this one.
 */
export async function elkLayout(
  graphNodes: GraphNodeData[],
  graphEdges: StudioEdgeData[],
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  const { direction = 'RIGHT', spacing = 110, nodeSpacing = 46 } = options;

  const sizes = new Map(graphNodes.map((n) => [n.id, estimateNodeSize(n)]));
  const present = new Set(graphNodes.map((n) => n.id));
  // An edge to a node that is not on the canvas (filtered out, or a target the
  // analyzer could not resolve) would make elk throw rather than skip it.
  const drawable = graphEdges.filter((e) => present.has(e.source) && present.has(e.target));

  const toReactFlowNode = (n: GraphNodeData, x: number, y: number): Node => {
    const size = sizes.get(n.id)!;
    return {
      id: n.id,
      position: { x, y },
      data: n as unknown as Record<string, unknown>,
      type: 'schemaNode',
      // Width only. Height is left to the card so its content is never clipped
      // by an estimate that drifted from the markup.
      style: { width: size.width },
    };
  };

  const toReactFlowEdge = (e: StudioEdgeData): Edge => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'schemaEdge',
    data: e as unknown as Record<string, unknown>,
  });

  try {
    const laid = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': direction,
        'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing),
        'elk.spacing.nodeNode': String(nodeSpacing),
        'elk.spacing.edgeNode': '28',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.edgeRouting': 'ORTHOGONAL',
      },
      children: graphNodes.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      edges: drawable.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    });

    const byId = new Map(graphNodes.map((n) => [n.id, n]));
    const nodes = (laid.children ?? []).flatMap((child) => {
      const data = byId.get(child.id);
      return data ? [toReactFlowNode(data, child.x ?? 0, child.y ?? 0)] : [];
    });

    return { nodes, edges: drawable.map(toReactFlowEdge) };
  } catch {
    const columns = 4;
    return {
      nodes: graphNodes.map((n, i) =>
        toReactFlowNode(n, (i % columns) * 300, Math.floor(i / columns) * 260),
      ),
      edges: drawable.map(toReactFlowEdge),
    };
  }
}
