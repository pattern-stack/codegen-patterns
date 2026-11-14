/**
 * What the canvas has selected — a node or an edge, by id — and what stays lit
 * around it.
 *
 * Node selection lights the node, every edge touching it and every node at the
 * other end of one (the component library's `useGraphSelection`). Edge
 * selection is Studio's own: the library knows only nodes. It lights the edge
 * and its two endpoints, and dims the rest.
 */
import type { GraphEdgeData } from '@pattern-stack/graph-components';

export type Selection = { kind: 'node' | 'edge'; id: string };

export interface Lit {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

/** The edge and its two endpoints; nothing when the edge is not on the canvas. */
export function edgeHighlight(edgeId: string, edges: readonly Pick<GraphEdgeData, 'id' | 'source' | 'target'>[]): Lit {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return { nodeIds: new Set(), edgeIds: new Set() };
  return { nodeIds: new Set([edge.source, edge.target]), edgeIds: new Set([edge.id]) };
}

/** A click on what is already selected clears it; any other click selects. */
export function toggleSelection(current: Selection | null, next: Selection): Selection | null {
  return current != null && current.kind === next.kind && current.id === next.id ? null : next;
}
