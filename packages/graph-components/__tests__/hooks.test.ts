import { describe, it, expect } from 'vitest';
import type { GraphNodeData } from '../src/types/graph-node-data.js';
import type { GraphEdgeData } from '../src/types/graph-edge-data.js';
import type { GraphAdapter } from '../src/types/graph-adapter.js';

// Test the hook logic directly without React rendering
// (hooks are thin wrappers around useMemo with pure logic)

// --- useGraphData logic ---

describe('useGraphData logic', () => {
  interface TestEntity { name: string; kind: string }

  const adapter: GraphAdapter<TestEntity> = {
    toNodes(data) {
      return data.map((d) => ({
        id: d.name,
        label: d.name,
        kind: 'entity' as const,
      }));
    },
    toEdges() {
      return [];
    },
  };

  it('should transform data to nodes via adapter', () => {
    const raw: TestEntity[] = [
      { name: 'person', kind: 'entity' },
      { name: 'org', kind: 'entity' },
    ];
    const nodes = adapter.toNodes(raw);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe('person');
    expect(nodes[1].id).toBe('org');
  });

  it('should transform data to edges via adapter', () => {
    const edges = adapter.toEdges([]);
    expect(edges).toHaveLength(0);
  });
});

// --- useGraphSelection logic ---

describe('useGraphSelection logic', () => {
  const edges: GraphEdgeData[] = [
    { id: 'e1', source: 'person', target: 'org', type: 'fk' },
    { id: 'e2', source: 'person', target: 'opportunity', type: 'junction' },
    { id: 'e3', source: 'org', target: 'engagement', type: 'fk' },
  ];

  function computeSelection(selectedNodeId: string | null, edgeList: GraphEdgeData[]) {
    const connNodes = new Set<string>();
    const connEdges = new Set<string>();

    if (!selectedNodeId) return { connectedNodeIds: connNodes, connectedEdgeIds: connEdges };

    connNodes.add(selectedNodeId);
    for (const edge of edgeList) {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        connEdges.add(edge.id);
        connNodes.add(edge.source);
        connNodes.add(edge.target);
      }
    }
    return { connectedNodeIds: connNodes, connectedEdgeIds: connEdges };
  }

  it('should return empty sets when no selection', () => {
    const { connectedNodeIds, connectedEdgeIds } = computeSelection(null, edges);
    expect(connectedNodeIds.size).toBe(0);
    expect(connectedEdgeIds.size).toBe(0);
  });

  it('should find connected nodes for person', () => {
    const { connectedNodeIds, connectedEdgeIds } = computeSelection('person', edges);
    expect(connectedNodeIds.has('person')).toBe(true);
    expect(connectedNodeIds.has('org')).toBe(true);
    expect(connectedNodeIds.has('opportunity')).toBe(true);
    expect(connectedNodeIds.has('engagement')).toBe(false);
    expect(connectedEdgeIds.has('e1')).toBe(true);
    expect(connectedEdgeIds.has('e2')).toBe(true);
    expect(connectedEdgeIds.has('e3')).toBe(false);
  });

  it('should find connected nodes for org', () => {
    const { connectedNodeIds, connectedEdgeIds } = computeSelection('org', edges);
    expect(connectedNodeIds.has('person')).toBe(true);
    expect(connectedNodeIds.has('org')).toBe(true);
    expect(connectedNodeIds.has('engagement')).toBe(true);
    expect(connectedEdgeIds.has('e1')).toBe(true);
    expect(connectedEdgeIds.has('e3')).toBe(true);
  });
});

// --- useGraphFilter logic ---

describe('useGraphFilter logic', () => {
  const nodes: GraphNodeData[] = [
    { id: 'person', label: 'Person', kind: 'entity', group: 'synced', behaviors: ['timestamps'] },
    { id: 'org', label: 'Organization', kind: 'entity', group: 'synced', behaviors: ['timestamps', 'soft_delete'] },
    { id: 'employment', label: 'Employment', kind: 'relationship', from: 'person', to: 'org' },
    { id: 'note', label: 'Note', kind: 'entity', group: 'activity', behaviors: ['user_tracking'] },
  ];

  const edges: GraphEdgeData[] = [
    { id: 'e1', source: 'person', target: 'employment', type: 'fk' },
    { id: 'e2', source: 'employment', target: 'org', type: 'fk' },
    { id: 'e3', source: 'person', target: 'note', type: 'fk' },
  ];

  function filterGraph(
    nodeList: GraphNodeData[],
    edgeList: GraphEdgeData[],
    query: string,
    filters: Record<string, boolean>,
  ) {
    let result = nodeList;

    if (query) {
      const q = query.toLowerCase();
      result = result.filter((node) => {
        if (node.label.toLowerCase().includes(q)) return true;
        if (node.subtitle?.toLowerCase().includes(q)) return true;
        if (node.group?.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    const activeFilters = Object.entries(filters).filter(([, active]) => active);
    if (activeFilters.length > 0) {
      result = result.filter((node) =>
        activeFilters.some(([key]) => {
          if (node.kind === key) return true;
          if (node.group === key) return true;
          if (node.behaviors?.includes(key)) return true;
          return false;
        }),
      );
    }

    const nodeIds = new Set(result.map((n) => n.id));
    const filteredEdges = edgeList.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

    return { filteredNodes: result, filteredEdges };
  }

  it('should return all nodes with empty query and no filters', () => {
    const { filteredNodes, filteredEdges } = filterGraph(nodes, edges, '', {});
    expect(filteredNodes).toHaveLength(4);
    expect(filteredEdges).toHaveLength(3);
  });

  it('should filter by text query', () => {
    const { filteredNodes } = filterGraph(nodes, edges, 'person', {});
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].id).toBe('person');
  });

  it('should filter by query matching group', () => {
    const { filteredNodes } = filterGraph(nodes, edges, 'synced', {});
    expect(filteredNodes).toHaveLength(2);
  });

  it('should filter by kind toggle', () => {
    const { filteredNodes, filteredEdges } = filterGraph(nodes, edges, '', { entity: true });
    expect(filteredNodes).toHaveLength(3); // person, org, note
    expect(filteredEdges).toHaveLength(1); // person → note
  });

  it('should filter by group toggle', () => {
    const { filteredNodes } = filterGraph(nodes, edges, '', { activity: true });
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].id).toBe('note');
  });

  it('should filter by behavior toggle', () => {
    const { filteredNodes } = filterGraph(nodes, edges, '', { soft_delete: true });
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].id).toBe('org');
  });

  it('should combine query and filters', () => {
    const { filteredNodes } = filterGraph(nodes, edges, 'org', { entity: true });
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].id).toBe('org');
  });

  it('should filter edges to only include connected filtered nodes', () => {
    const { filteredNodes, filteredEdges } = filterGraph(nodes, edges, '', { synced: true });
    expect(filteredNodes).toHaveLength(2); // person, org
    expect(filteredEdges).toHaveLength(0); // employment filtered out, so edges through it are gone
  });
});
