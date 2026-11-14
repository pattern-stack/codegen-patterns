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
import { edgeHighlight, toggleSelection } from './selection';
import type { Selection } from './selection';
import { treeLayout } from '../layout/tree-layout';

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
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
}

/**
 * The model graph.
 *
 * Layout runs off the semantic graph — a tree on the spine lines only
 * (`../layout/tree-layout`); selection is applied on top of the laid
 * out nodes rather than by re-running the layout, so clicking a node dims its
 * unrelated neighbours without anything moving. Clicking an edge does the
 * same for the edge: it and its two endpoints stay lit (`selection.ts`).
 */
export function SchemaCanvas({ nodes: graphNodes, edges: graphEdges, selection, onSelect }: SchemaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // The tree layout is pure and synchronous (`../layout/tree-layout`): a new
  // graph is laid out in the same pass, so there is no stale layout to guard.
  useEffect(() => {
    const result = treeLayout(graphNodes, graphEdges);
    setNodes(result.nodes);
    setEdges(result.edges);
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

  const selectedNodeId = selection?.kind === 'node' ? selection.id : null;
  const selectedEdgeId = selection?.kind === 'edge' ? selection.id : null;
  const nodeLit = useGraphSelection(selectedNodeId, graphNodes, graphEdges);
  const lit = useMemo(
    () =>
      selectedEdgeId != null
        ? edgeHighlight(selectedEdgeId, graphEdges)
        : { nodeIds: nodeLit.connectedNodeIds, edgeIds: nodeLit.connectedEdgeIds },
    [selectedEdgeId, graphEdges, nodeLit.connectedNodeIds, nodeLit.connectedEdgeIds],
  );

  // Selection is projected onto the laid out graph: `dimmed` rides in the node
  // and edge data, and positions are untouched.
  const shownNodes = useMemo<Node[]>(() => {
    if (selection == null) {
      return nodes.map((n) =>
        (n.data as { dimmed?: boolean }).dimmed === true || n.selected === true
          ? { ...n, selected: false, data: { ...n.data, dimmed: false } }
          : n,
      );
    }
    return nodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: { ...n.data, dimmed: !lit.nodeIds.has(n.id) },
    }));
  }, [nodes, selection, selectedNodeId, lit]);

  const shownEdges = useMemo<Edge[]>(() => {
    if (selection == null) {
      return edges.map((e) =>
        (e.data as { dimmed?: boolean }).dimmed === true || e.selected === true
          ? { ...e, selected: false, data: { ...e.data, dimmed: false } }
          : e,
      );
    }
    return edges.map((e) => ({
      ...e,
      selected: e.id === selectedEdgeId,
      data: { ...e.data, dimmed: !lit.edgeIds.has(e.id) },
    }));
  }, [edges, selection, selectedEdgeId, lit]);

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => onSelect(toggleSelection(selection, { kind: 'node', id: node.id })),
    [onSelect, selection],
  );

  const handleEdgeClick = useCallback(
    (_: unknown, edge: Edge) => onSelect(toggleSelection(selection, { kind: 'edge', id: edge.id })),
    [onSelect, selection],
  );

  const miniMapColor = useCallback(
    (node: Node) =>
      (node.data as unknown as GraphNodeData).kind === 'relationship'
        ? 'var(--graph-relationship-color)'
        : 'var(--graph-entity-color)',
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
              <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: marker.color }} />
            </marker>
          ))}
        </defs>
      </svg>

      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
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
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--s-dots)" />
        <Controls position="top-left" showInteractive={false} />
        {/* Only once the graph is too big to take in at once — below that the
            minimap is an overlay sitting on top of a card it duplicates. */}
        {graphNodes.length > MINIMAP_THRESHOLD && (
          <MiniMap
            nodeColor={miniMapColor}
            maskColor="var(--s-mask)"
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
