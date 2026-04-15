import type { GraphNodeData } from './graph-node-data.js';
import type { GraphEdgeData } from './graph-edge-data.js';

export interface GraphAdapter<T> {
  toNodes(data: T[]): GraphNodeData<T>[];
  toEdges(data: T[]): GraphEdgeData[];
}
