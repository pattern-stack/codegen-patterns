import { useMemo } from 'react';
import type { GraphAdapter } from '../types/graph-adapter.js';
import type { GraphNodeData } from '../types/graph-node-data.js';
import type { GraphEdgeData } from '../types/graph-edge-data.js';

export interface UseGraphDataResult<T> {
  nodes: GraphNodeData<T>[];
  edges: GraphEdgeData[];
}

export function useGraphData<T>(
  raw: T[],
  adapter: GraphAdapter<T>,
): UseGraphDataResult<T> {
  const nodes = useMemo(() => adapter.toNodes(raw), [raw, adapter]);
  const edges = useMemo(() => adapter.toEdges(raw), [raw, adapter]);
  return { nodes, edges };
}
