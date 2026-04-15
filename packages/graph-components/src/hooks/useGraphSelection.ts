import { useMemo } from 'react';
import type { GraphNodeData } from '../types/graph-node-data.js';
import type { GraphEdgeData } from '../types/graph-edge-data.js';

export interface UseGraphSelectionResult {
  selectedNodeId: string | null;
  connectedNodeIds: Set<string>;
  connectedEdgeIds: Set<string>;
  isConnected: (id: string) => boolean;
}

export function useGraphSelection(
  selectedNodeId: string | null,
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
): UseGraphSelectionResult {
  const { connectedNodeIds, connectedEdgeIds } = useMemo(() => {
    const connNodes = new Set<string>();
    const connEdges = new Set<string>();

    if (!selectedNodeId) return { connectedNodeIds: connNodes, connectedEdgeIds: connEdges };

    connNodes.add(selectedNodeId);

    for (const edge of edges) {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        connEdges.add(edge.id);
        connNodes.add(edge.source);
        connNodes.add(edge.target);
      }
    }

    return { connectedNodeIds: connNodes, connectedEdgeIds: connEdges };
  }, [selectedNodeId, edges]);

  const isConnected = useMemo(() => {
    return (id: string) => connectedNodeIds.has(id);
  }, [connectedNodeIds]);

  return {
    selectedNodeId,
    connectedNodeIds,
    connectedEdgeIds,
    isConnected,
  };
}
