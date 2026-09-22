import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import type { Edge, EdgeTypes, Node, NodeTypes } from '@xyflow/react';
import type { GraphNodeData } from '@pattern-stack/graph-components';
import { useGraphSelection } from '@pattern-stack/graph-components';

import { SchemaNode } from './SchemaNode';
import { SchemaEdge } from './SchemaEdge';
import { Legend } from './Legend';
import { EDGE_MARKERS } from './edge-kinds';
import type { StudioEdgeData } from './edge-kinds';
import { elkLayout } from '../layout/elk-layout';
import { LoadingState } from '../ui/primitives';

const nodeTypes: NodeTypes = { schemaNode: SchemaNode };

/** Above this many nodes, the minimap is worth the corner it occupies. */
const MINIMAP_THRESHOLD = 12;

/**
 * The canvas a fully expanded legend can sit on without covering a card.
 *
 * The panel is roughly 355×180 CSS px in the bottom-left. Below these bounds it
 * takes a third of the canvas and lands on the node area — at 1280×720 it half
 * covered the junction card, which is the one node a relations demo is about.
 */
const LEGEND_MIN_WIDTH = 760;
const LEGEND_MIN_HEIGHT = 520;
const edgeTypes: EdgeTypes = { schemaEdge: SchemaEdge };

export interface SchemaCanvasProps {
  nodes: GraphNodeData[];
  edges: StudioEdgeData[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * The model graph.
 *
 * Layout runs off the semantic graph; selection is applied on top of the laid
 * out nodes rather than by re-running elk, so clicking a node dims its
 * unrelated neighbours without anything moving.
 */
export function SchemaCanvas({ nodes: graphNodes, edges: graphEdges, selectedId, onSelect }: SchemaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [laidOut, setLaidOut] = useState(false);
  /** Guards against a slow layout landing after a newer one. */
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    if (graphNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      setLaidOut(true);
      return;
    }

    setLaidOut(false);
    void elkLayout(graphNodes, graphEdges).then((result) => {
      if (generation.current !== mine) return;
      setNodes(result.nodes);
      setEdges(result.edges);
      setLaidOut(true);
    });
  }, [graphNodes, graphEdges, setNodes, setEdges]);

  // Measured, not derived from the window: the inspector and the drawer both
  // take from the canvas, so the viewport says nothing about the room here.
  const host = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (!box) return;
      setRoomy(box.width >= LEGEND_MIN_WIDTH && box.height >= LEGEND_MIN_HEIGHT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { connectedNodeIds, connectedEdgeIds } = useGraphSelection(selectedId, graphNodes, graphEdges);

  // Selection is projected onto the laid out graph: `dimmed` rides in the node
  // and edge data, and positions are untouched.
  const shownNodes = useMemo<Node[]>(() => {
    if (selectedId == null) {
      return nodes.map((n) =>
        (n.data as { dimmed?: boolean }).dimmed === true || n.selected === true
          ? { ...n, selected: false, data: { ...n.data, dimmed: false } }
          : n,
      );
    }
    return nodes.map((n) => ({
      ...n,
      selected: n.id === selectedId,
      data: { ...n.data, dimmed: !connectedNodeIds.has(n.id) },
    }));
  }, [nodes, selectedId, connectedNodeIds]);

  const shownEdges = useMemo<Edge[]>(() => {
    if (selectedId == null) {
      return edges.map((e) =>
        (e.data as { dimmed?: boolean }).dimmed === true
          ? { ...e, data: { ...e.data, dimmed: false } }
          : e,
      );
    }
    return edges.map((e) => ({
      ...e,
      data: { ...e.data, dimmed: !connectedEdgeIds.has(e.id) },
    }));
  }, [edges, selectedId, connectedEdgeIds]);

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => onSelect(node.id === selectedId ? null : node.id),
    [onSelect, selectedId],
  );

  const miniMapColor = useCallback(
    (node: Node) =>
      (node.data as unknown as GraphNodeData).kind === 'relationship' ? '#34d399' : '#60a5fa',
    [],
  );

  return (
    <div
      ref={host}
      style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--s-canvas)' }}
    >
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
        <defs>
          {EDGE_MARKERS.map((marker) => (
            <marker
              key={marker.id}
              id={marker.id}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={marker.color} />
            </marker>
          ))}
        </defs>
      </svg>

      {!laidOut && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'var(--s-canvas)' }}>
          <LoadingState label="Laying out the graph…" />
        </div>
      )}

      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelect(null)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.05}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1c2942" />
        <Controls position="top-left" showInteractive={false} />
        {/* Only once the graph is too big to take in at once — below that the
            minimap is an overlay sitting on top of a card it duplicates. */}
        {graphNodes.length > MINIMAP_THRESHOLD && (
          <MiniMap
            nodeColor={miniMapColor}
            maskColor="rgba(11, 17, 32, 0.75)"
            nodeStrokeWidth={0}
            position="bottom-right"
            pannable
            zoomable
          />
        )}
      </ReactFlow>

      <Legend roomy={roomy} />
    </div>
  );
}
