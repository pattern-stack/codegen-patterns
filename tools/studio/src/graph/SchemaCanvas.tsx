import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type { Edge, EdgeTypes, Node, NodeTypes, ReactFlowInstance } from '@xyflow/react';
import type { GraphNodeData } from '@pattern-stack/graph-components';
import { useGraphSelection } from '@pattern-stack/graph-components';

import { SchemaNode } from './SchemaNode';
import { SchemaEdge } from './SchemaEdge';
import { Legend } from './Legend';
import { EDGE_MARKERS } from './edge-kinds';
import type { StudioEdgeData } from './edge-kinds';
import { edgeHighlight, toggleSelection } from './selection';
import type { Selection } from './selection';
import { DEFAULT_TARGET_ASPECT, treeLayout } from '../layout/tree-layout';
import { fitAvoidingCorner } from './fit-corner';
import type { Rect } from './fit-corner';

const nodeTypes: NodeTypes = { schemaNode: SchemaNode };

/** Above this many nodes, the minimap is worth the corner it occupies. */
const MINIMAP_THRESHOLD = 12;

/**
 * The canvas a fully expanded legend can sit on without covering a card.
 *
 * The panel is roughly 355×180 CSS px in the bottom-right. Below these bounds it
 * takes a third of the canvas and lands on the node area — at 1280×720 it half
 * covered the junction card, which is the one node a relations demo is about.
 */
const LEGEND_MIN_WIDTH = 760;
const LEGEND_MIN_HEIGHT = 520;
const edgeTypes: EdgeTypes = { schemaEdge: SchemaEdge };

const FIT_PADDING = 0.18;
const ZOOM = { min: 0.05, max: 2 } as const;
/** ReactFlow's own label for its fit button, kept for the one that replaces it. */
const FIT_VIEW_LABEL = 'Fit View';
/** How many frames a fit waits for ReactFlow to measure re-laid-out cards before giving up. */
const MEASURE_FRAMES = 30;

export interface SchemaCanvasProps {
  nodes: GraphNodeData[];
  edges: StudioEdgeData[];
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  /**
   * Changed by the app when a panel toggle changes the canvas's room
   * (STUDIO-4). The view refits once the canvas has been re-measured at its
   * new size — never on a timer, never to the old box. A drag-resize does not
   * change it: that refits only when the packing re-wraps, as before.
   */
  fitKey?: string;
  /**
   * Changes when the filter box or the chips choose a different subset
   * (STUDIO-5). The subset is laid out as its own tree and the view refits to
   * it once ReactFlow has measured its cards.
   */
  subsetKey?: string;
  /** A card was double-clicked: the pane sets the box to `1+<id>+1`. */
  onNodeFocus?: (id: string) => void;
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
export function SchemaCanvas({
  nodes: graphNodes,
  edges: graphEdges,
  selection,
  onSelect,
  fitKey = '',
  subsetKey = '',
  onNodeFocus,
}: SchemaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Measured, not derived from the window: the inspector and the drawer both
  // take from the canvas, so the viewport says nothing about the room here.
  const host = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  // The canvas's width ÷ height: the tree blocks are wrapped to it (STUDIO-4).
  // The layout is handed the number; it never reads the DOM itself.
  const [aspect, setAspect] = useState(DEFAULT_TARGET_ASPECT);
  // A toggle's fit waits for the observer to report the new box; `fitTick`
  // then fits once the layout for that box has been applied.
  const fitPending = useRef(false);
  const lastFitKey = useRef(fitKey);
  const [fitTick, setFitTick] = useState(0);

  // A layout effect, so the flag is set in the same commit that resized the
  // canvas — before the browser lays it out and the observer reports.
  useLayoutEffect(() => {
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    fitPending.current = true;
  }, [fitKey]);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (!box) return;
      setRoomy(box.width >= LEGEND_MIN_WIDTH && box.height >= LEGEND_MIN_HEIGHT);
      if (box.width > 0 && box.height > 0) {
        setAspect(box.width / box.height);
        if (fitPending.current) {
          fitPending.current = false;
          setFitTick((t) => t + 1);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The tree layout is pure and synchronous (`../layout/tree-layout`): a new
  // graph is laid out in the same pass, so there is no stale layout to guard.
  const laid = useMemo(() => treeLayout(graphNodes, graphEdges, { targetAspect: aspect }), [graphNodes, graphEdges, aspect]);
  // Packing is discrete: most resizes leave every card where it was. A resize
  // that re-wraps the blocks re-fits the view, so the new arrangement is shown
  // whole; one that does not leaves the user's pan and zoom alone, and so does
  // an edit to the model (as before STUDIO-4).
  const placement = useMemo(
    () => laid.nodes.map((n) => `${n.id}@${n.position.x},${n.position.y}`).join('|'),
    [laid],
  );
  const flow = useRef<ReactFlowInstance | null>(null);
  const legend = useRef<HTMLDivElement>(null);
  // The cards the current layout places: a fit waits until ReactFlow holds
  // exactly these, so a new subset is never fitted to the cards it replaced.
  const laidIds = useRef<Set<string>>(new Set());
  laidIds.current = new Set(laid.nodes.map((n) => n.id));

  /**
   * Fit-to-view that keeps the legend off the cards (`fit-corner.ts`): the
   * plain fit unless it would put a card under the legend, else the fit that
   * gives up a bottom or right strip with the larger zoom. Every fit goes
   * through here — the first, a re-wrap's, a panel toggle's, the fit button.
   * The legend is measured as it is now, expanded or collapsed.
   */
  const retry = useRef<number | null>(null);
  const fit = useCallback((given?: ReactFlowInstance) => {
    if (retry.current != null) cancelAnimationFrame(retry.current);
    retry.current = null;
    let frames = 0;
    const attempt = () => {
      retry.current = null;
      const instance = given ?? flow.current;
      const el = host.current;
      if (instance == null || el == null) return;
      // A re-layout hands ReactFlow fresh node objects, measured a frame or
      // two later; a fit that cannot see every card's size waits for them.
      const nodes = instance.getNodes();
      const current = nodes.length === laidIds.current.size && nodes.every((n) => laidIds.current.has(n.id));
      const cards: Rect[] = [];
      for (const n of nodes) {
        const size = instance.getInternalNode(n.id)?.measured ?? n.measured;
        if (size?.width == null || size.height == null || size.width <= 0 || size.height <= 0) break;
        cards.push({ x: n.position.x, y: n.position.y, width: size.width, height: size.height });
      }
      if (!current || nodes.length === 0 || cards.length < nodes.length) {
        if (frames++ < MEASURE_FRAMES) retry.current = requestAnimationFrame(attempt);
        return;
      }
      const canvas = el.getBoundingClientRect();
      const box = legend.current?.getBoundingClientRect();
      const corner =
        box != null ? { x: box.left - canvas.left, y: box.top - canvas.top, width: box.width, height: box.height } : null;
      const viewport = fitAvoidingCorner(cards, { width: canvas.width, height: canvas.height }, corner, FIT_PADDING, ZOOM);
      if (viewport != null) void instance.setViewport(viewport);
    };
    attempt();
  }, []);
  useEffect(() => () => {
    if (retry.current != null) cancelAnimationFrame(retry.current);
  }, []);

  const fitted = useRef<{ placement: string; aspect: number } | null>(null);

  useEffect(() => {
    setNodes(laid.nodes);
    setEdges(laid.edges);
  }, [laid, setNodes, setEdges]);

  useEffect(() => {
    const last = fitted.current;
    fitted.current = { placement, aspect };
    // The first fit waits for ReactFlow to measure the cards (`FitWhenMeasured` below).
    if (last == null || flow.current == null) return;
    if (last.aspect === aspect || last.placement === placement) return;
    const frame = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(frame);
  }, [placement, aspect, fit]);

  const lastSubset = useRef(subsetKey);
  useEffect(() => {
    if (lastSubset.current === subsetKey) return;
    lastSubset.current = subsetKey;
    if (flow.current == null) return;
    const frame = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(frame);
  }, [subsetKey, fit]);

  useEffect(() => {
    if (fitTick === 0 || flow.current == null) return;
    const frame = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(frame);
  }, [fitTick, fit]);

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

  const handleNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => onNodeFocus?.(node.id),
    [onNodeFocus],
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
        // The legend sits bottom-right; keep React Flow's attribution visible beside it.
        attributionPosition="bottom-left"
        nodes={shownNodes}
        edges={shownEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={() => onSelect(null)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => {
          flow.current = instance;
        }}
        minZoom={ZOOM.min}
        maxZoom={ZOOM.max}
        nodesDraggable
        nodesConnectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--s-dots)" />
        <FitWhenMeasured onMeasured={fit} />
        {/* ReactFlow's fit button always runs its own plain fit, so it is
            replaced by one with the same icon and label that runs ours. */}
        <Controls position="top-left" showInteractive={false} showFitView={false}>
          <ControlButton
            className="react-flow__controls-fitview"
            onClick={() => fit()}
            title={FIT_VIEW_LABEL}
            aria-label={FIT_VIEW_LABEL}
          >
            <FitViewIcon />
          </ControlButton>
        </Controls>
        {/* Only once the graph is too big to take in at once — below that the
            minimap is an overlay sitting on top of a card it duplicates. */}
        {graphNodes.length > MINIMAP_THRESHOLD && (
          <MiniMap
            nodeColor={miniMapColor}
            maskColor="var(--s-mask)"
            nodeStrokeWidth={0}
            // Top-right: the legend holds the bottom-right corner (STUDIO-4).
            position="top-right"
            pannable
            zoomable
          />
        )}
      </ReactFlow>

      <Legend roomy={roomy} boxRef={legend} />
    </div>
  );
}

/**
 * The first fit, once ReactFlow has measured every card — a card's size is
 * needed to know whether the legend covers it. Later graphs keep the reader's
 * view, as ReactFlow's own `fitView` prop did; re-wraps and toggles refit
 * through the canvas.
 */
function FitWhenMeasured({ onMeasured }: { onMeasured: (instance: ReactFlowInstance) => void }) {
  const measured = useNodesInitialized();
  // `onInit` fires on a timer after the viewport is ready, so the canvas's own
  // instance ref can still be empty here: take the instance from the store.
  const ready = useStore((s) => s.panZoom != null);
  const instance = useReactFlow();
  const done = useRef(false);
  useEffect(() => {
    if (!measured || !ready || done.current) return;
    done.current = true;
    onMeasured(instance);
  }, [measured, ready, instance, onMeasured]);
  return null;
}

/** ReactFlow's fit-view glyph (not exported by the library), for the replacement button. */
function FitViewIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" aria-hidden>
      <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
    </svg>
  );
}
