import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
} from '@xyflow/react';
import type { Node, Edge, NodeTypes, EdgeTypes } from '@xyflow/react';
import type { GraphNodeData, GraphEdgeData } from '@pattern-stack/graph-components';

import { SchemaNode } from './SchemaNode';
import { SchemaEdge } from './SchemaEdge';
import { elkLayout } from '../layout/elk-layout';

const nodeTypes: NodeTypes = {
  schemaNode: SchemaNode,
};

const edgeTypes: EdgeTypes = {
  schemaEdge: SchemaEdge,
};

interface SchemaCanvasProps {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

/**
 * ReactFlow canvas that renders the schema graph.
 * Runs elkjs layout on mount to position all nodes.
 */
export function SchemaCanvas({ nodes: graphNodes, edges: graphEdges }: SchemaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutDone, setLayoutDone] = useState(false);

  // Run layout when graph data changes
  useEffect(() => {
    if (graphNodes.length === 0) {
      setLayoutDone(true);
      return;
    }

    setLayoutDone(false);
    elkLayout(graphNodes, graphEdges, { direction: 'RIGHT', spacing: 100, nodeSpacing: 60 })
      .then(({ nodes: layoutNodes, edges: layoutEdges }) => {
        setNodes(layoutNodes);
        setEdges(layoutEdges);
        setLayoutDone(true);
      })
      .catch((err) => {
        console.error('Layout failed:', err);
        // Fallback: position nodes in a grid
        const fallbackNodes: Node[] = graphNodes.map((n, i) => ({
          id: n.id,
          position: { x: (i % 4) * 300, y: Math.floor(i / 4) * 250 },
          data: n as unknown as Record<string, unknown>,
          type: 'schemaNode',
        }));
        const fallbackEdges: Edge[] = graphEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'schemaEdge',
          data: e as unknown as Record<string, unknown>,
        }));
        setNodes(fallbackNodes);
        setEdges(fallbackEdges);
        setLayoutDone(true);
      });
  }, [graphNodes, graphEdges, setNodes, setEdges]);

  // MiniMap node color by kind
  const miniMapNodeColor = useCallback((node: Node) => {
    const data = node.data as unknown as GraphNodeData;
    if (data?.kind === 'relationship') return '#f59e0b';
    if (data?.kind === 'record') return '#10b981';
    return '#6366f1';
  }, []);

  // SVG defs for arrow markers
  const svgDefs = useMemo(
    () => (
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
        </defs>
      </svg>
    ),
    [],
  );

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      {svgDefs}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'schemaEdge' }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e5e7eb" />
        <Controls position="top-left" />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          position="bottom-right"
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
}
