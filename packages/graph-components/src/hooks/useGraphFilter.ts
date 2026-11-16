import { useMemo } from 'react';
import type { GraphNodeData } from '../types/graph-node-data.js';
import type { GraphEdgeData } from '../types/graph-edge-data.js';

export interface GraphFilterOptions {
  query: string;
  filters: Record<string, boolean>;
}

export interface UseGraphFilterResult<T> {
  filteredNodes: GraphNodeData<T>[];
  filteredEdges: GraphEdgeData[];
}

/** The parts of a node the text query reads. `GraphNodeData` satisfies it. */
export type GraphQueryTarget = Pick<GraphNodeData, 'label' | 'subtitle' | 'group'> & {
  fields?: readonly { name: string }[];
  types?: readonly { name: string }[];
};

/**
 * The text query's match: `query` is a case-insensitive substring of the
 * node's label, subtitle, group, or one of its field or type names. The one
 * owner of this rule — `useGraphFilter` applies it, and so does any caller that
 * matches text outside the hook (Studio's selector, once per text token).
 */
export function matchesGraphQuery(node: GraphQueryTarget, query: string): boolean {
  const q = query.toLowerCase();
  if (node.label.toLowerCase().includes(q)) return true;
  if (node.subtitle?.toLowerCase().includes(q)) return true;
  if (node.group?.toLowerCase().includes(q)) return true;
  if (node.fields?.some((f) => f.name.toLowerCase().includes(q))) return true;
  if (node.types?.some((t) => t.name.toLowerCase().includes(q))) return true;
  return false;
}

export function useGraphFilter<T>(
  nodes: GraphNodeData<T>[],
  edges: GraphEdgeData[],
  options: GraphFilterOptions,
): UseGraphFilterResult<T> {
  const filteredNodes = useMemo(() => {
    let result = nodes;

    // Text search: label, subtitle, group, field and type names
    if (options.query) {
      result = result.filter((node) => matchesGraphQuery(node, options.query));
    }

    // Toggle filters: filter by kind, group, or behaviors
    const activeFilters = Object.entries(options.filters).filter(([, active]) => active);
    if (activeFilters.length > 0) {
      result = result.filter((node) => {
        return activeFilters.some(([key]) => {
          if (node.kind === key) return true;
          if (node.group === key) return true;
          if (node.behaviors?.includes(key)) return true;
          return false;
        });
      });
    }

    return result;
  }, [nodes, options.query, options.filters]);

  const filteredEdges = useMemo(() => {
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    return edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  }, [edges, filteredNodes]);

  return { filteredNodes, filteredEdges };
}
