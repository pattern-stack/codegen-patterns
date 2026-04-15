import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphNodeData, GraphEdgeData } from '@pattern-stack/graph-components';
import type { Node, Edge } from '@xyflow/react';

const elk = new ELK();

/** Estimated node dimensions based on field count */
function estimateNodeSize(node: GraphNodeData): { width: number; height: number } {
  const fieldCount = node.fields?.length ?? node.fieldCount ?? 0;
  const headerHeight = 48;
  const fieldRowHeight = 24;
  const badgeRowHeight = node.behaviors?.length ? 32 : 0;
  const padding = 24;

  const width = node.kind === 'relationship' ? 220 : 260;
  const height = headerHeight + Math.min(fieldCount, 8) * fieldRowHeight + badgeRowHeight + padding;

  return { width, height: Math.max(height, 100) };
}

export interface LayoutOptions {
  direction?: 'RIGHT' | 'DOWN';
  spacing?: number;
  nodeSpacing?: number;
}

/**
 * Run elkjs layout on semantic graph data and produce positioned ReactFlow nodes + edges.
 */
export async function elkLayout(
  graphNodes: GraphNodeData[],
  graphEdges: GraphEdgeData[],
  options: LayoutOptions = {},
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const {
    direction = 'RIGHT',
    spacing = 80,
    nodeSpacing = 60,
  } = options;

  const elkNodes = graphNodes.map((n) => {
    const size = estimateNodeSize(n);
    return {
      id: n.id,
      width: size.width,
      height: size.height,
    };
  });

  const elkEdges = graphEdges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const elkGraph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing),
      'elk.spacing.nodeNode': String(nodeSpacing),
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: elkNodes,
    edges: elkEdges,
  });

  // Map elk results back to ReactFlow nodes
  const nodeDataMap = new Map(graphNodes.map((n) => [n.id, n]));
  const nodes: Node[] = (elkGraph.children ?? []).map((elkNode) => ({
    id: elkNode.id,
    position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
    data: nodeDataMap.get(elkNode.id)! as unknown as Record<string, unknown>,
    type: 'schemaNode',
    style: { width: elkNode.width, height: elkNode.height },
  }));

  // Map edges to ReactFlow edges
  const edges: Edge[] = graphEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'schemaEdge',
    label: e.label,
    data: e as unknown as Record<string, unknown>,
    animated: e.type === 'junction',
  }));

  return { nodes, edges };
}
