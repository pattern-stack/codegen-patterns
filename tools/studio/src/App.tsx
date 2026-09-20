import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { GraphNodeData } from '@pattern-stack/graph-components';
import type { HealthResponse, RunStepName, StudioFile } from '@studio-shared';

import { api, ApiError, streamRun } from './api/client';
import { adaptDomainGraph } from './adapters/schema-adapter';
import type { AdaptedGraph } from './adapters/schema-adapter';
import { GraphPane } from './graph/GraphPane';
import { Inspector } from './inspector/Inspector';
import type { InspectorTab } from './inspector/Inspector';
import { Drawer } from './drawer/Drawer';
import { RUN_STEPS, initialRunState, isRunInFlight, runReducer } from './drawer/run-state';
import { Button, Dot, Spinner, Toggle } from './ui/primitives';

const EMPTY_GRAPH: AdaptedGraph = { nodes: [], edges: [] };

interface GraphState {
  data: AdaptedGraph;
  counts: { entities: number; junctions: number; relationships: number } | null;
  loading: boolean;
  error?: { title: string; detail?: string };
}

/**
 * Studio.
 *
 * Three regions, fixed in place: the model graph on the left, the inspector on
 * the right, the run log and diff in a drawer along the bottom. The inspector
 * and drawer are resizable; nothing resizes itself, so a streaming run cannot
 * move anything the reader is looking at.
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphState>({ data: EMPTY_GRAPH, counts: null, loading: true });
  const [files, setFiles] = useState<StudioFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('detail');
  const [inspectorWidth, setInspectorWidth] = useState(420);
  const [dirty, setDirty] = useState(false);

  const [run, dispatch] = useReducer(runReducer, initialRunState);
  const [steps, setSteps] = useState<Record<RunStepName, boolean>>({
    generate: true,
    dbPush: false,
    restart: false,
  });
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState<'log' | 'diff'>('log');
  const [drawerHeight, setDrawerHeight] = useState(240);

  const unsubscribe = useRef<(() => void) | null>(null);

  // ── Loading ──────────────────────────────────────────────────────────────

  const loadGraph = useCallback(() => {
    setGraph((prev) => ({ ...prev, loading: true, error: undefined }));
    return api
      .graph()
      .then((res) => {
        setGraph({
          data: adaptDomainGraph(res.graph),
          counts: { entities: res.entities, junctions: res.junctions, relationships: res.relationships },
          loading: false,
        });
      })
      .catch((err: unknown) => {
        setGraph({ data: EMPTY_GRAPH, counts: null, loading: false, error: describe(err, 'Could not load the model') });
      });
  }, []);

  const loadFiles = useCallback(
    () => api.listFiles().then(setFiles).catch(() => setFiles([])),
    [],
  );

  const reload = useCallback(() => {
    void loadGraph();
    void loadFiles();
  }, [loadGraph, loadFiles]);

  useEffect(() => {
    api
      .health()
      .then((res) => {
        setHealth(res);
        setHealthError(null);
        reload();
      })
      .catch((err: unknown) => {
        const described = describe(err, 'Could not reach the Studio server');
        setHealthError(described.title);
        setGraph({ data: EMPTY_GRAPH, counts: null, loading: false, error: described });
      });
  }, [reload]);

  // Leaving with unsaved YAML is almost always a mis-click.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  useEffect(() => () => unsubscribe.current?.(), []);

  // ── Generate ─────────────────────────────────────────────────────────────

  const selectedSteps = useMemo(
    () => RUN_STEPS.map((s) => s.name).filter((name) => steps[name]),
    [steps],
  );

  const generate = useCallback(() => {
    if (selectedSteps.length === 0) return;
    unsubscribe.current?.();
    dispatch({ type: 'start' });
    setDrawerTab('log');
    setDrawerOpen(true);

    api
      .generate(selectedSteps)
      .then(({ runId }) => {
        dispatch({ type: 'started', runId });
        unsubscribe.current = streamRun(runId, {
          onEvent: (event) => {
            dispatch({ type: 'event', event });
            if (event.type === 'done') {
              // The run rewrote the project, so the graph on screen is stale.
              reload();
              // Show what it produced rather than making the reader find it.
              if (event.diff.files.length > 0) setDrawerTab('diff');
            }
          },
          onError: (message) => dispatch({ type: 'failed', message }),
        });
      })
      .catch((err: unknown) => {
        const described = describe(err, 'Could not start the run');
        dispatch({
          type: 'failed',
          message: described.detail != null ? `${described.title} — ${described.detail}` : described.title,
        });
      });
  }, [selectedSteps, reload]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const selectedNode: GraphNodeData | null = useMemo(
    () => graph.data.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.data.nodes, selectedId],
  );

  const entityNames = useMemo(
    () => graph.data.nodes.filter((n) => n.kind === 'entity').map((n) => n.id).sort(),
    [graph.data.nodes],
  );

  // Selecting a node is a request to look at it; the inspector follows.
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id != null) setInspectorTab((tab) => (tab === 'relate' ? tab : 'detail'));
  }, []);

  const startInspectorDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const move = (e: PointerEvent) => {
      setInspectorWidth(Math.min(Math.max(startWidth + (startX - e.clientX), 320), window.innerWidth - 400));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const inFlight = isRunInFlight(run);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-3)',
          flex: '0 0 var(--h-header)',
          height: 'var(--h-header)',
          padding: '0 var(--sp-4)',
          borderBottom: '1px solid var(--s-line)',
          background: 'var(--s-chrome)',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13.5, letterSpacing: '-0.01em' }}>Studio</span>

        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            fontSize: 11.5,
            color: 'var(--t-muted)',
            fontFamily: 'var(--font-mono)',
            minWidth: 0,
          }}
        >
          <Dot color={healthError != null ? 'var(--danger)' : health != null ? 'var(--ok)' : 'var(--warn)'} />
          {health != null ? (
            <>
              {/* A project path is truncated from the left, so the directory
                  that identifies it survives. `direction: rtl` does that, and
                  is only ever applied to a path — on a sentence it would move
                  the trailing punctuation to the front. */}
              <span
                title={health.projectDir}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  direction: 'rtl',
                }}
              >
                {health.projectDir}
              </span>
              <span style={{ flex: '0 0 auto' }}>v{health.cliVersion}</span>
            </>
          ) : (
            // The full message is already stated in the pane below; the header
            // only has to say which of the two states this is.
            <span style={{ flex: '0 0 auto', color: healthError != null ? 'var(--danger)' : undefined }}>
              {healthError != null ? 'disconnected' : 'connecting…'}
            </span>
          )}
        </span>

        {graph.counts != null && (
          <span style={{ display: 'flex', gap: 'var(--sp-3)', fontSize: 11.5, color: 'var(--t-muted)' }}>
            <span>{count(graph.counts.entities, 'entity', 'entities')}</span>
            <span>{count(graph.counts.junctions, 'junction')}</span>
            <span>{count(graph.counts.relationships, 'relationship')}</span>
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          {RUN_STEPS.map((step) => (
            <Toggle
              key={step.name}
              checked={steps[step.name]}
              onChange={(v) => setSteps((prev) => ({ ...prev, [step.name]: v }))}
              label={step.label}
            />
          ))}
          <Button size="sm" onClick={reload} disabled={graph.loading}>
            Reload
          </Button>
          <Button
            tone="primary"
            onClick={generate}
            disabled={inFlight || selectedSteps.length === 0 || health == null}
            icon={inFlight ? <Spinner size={11} /> : undefined}
            title={selectedSteps.length === 0 ? 'Select at least one step' : 'Run the selected steps'}
          >
            {inFlight ? 'Running…' : 'Generate'}
          </Button>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <GraphPane
            nodes={graph.data.nodes}
            edges={graph.data.edges}
            loading={graph.loading}
            error={graph.error}
            selectedId={selectedId}
            onSelect={select}
            onRetry={reload}
          />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the inspector"
          onPointerDown={startInspectorDrag}
          style={{ flex: '0 0 4px', cursor: 'col-resize', background: 'transparent' }}
        />

        <div style={{ flex: `0 0 ${inspectorWidth}px`, minWidth: 0 }}>
          <Inspector
            node={selectedNode}
            files={files}
            entities={entityNames}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            onProjectChanged={reload}
            onDirtyChange={setDirty}
          />
        </div>
      </div>

      <Drawer
        run={run}
        open={drawerOpen}
        onToggle={() => setDrawerOpen((v) => !v)}
        tab={drawerTab}
        onTabChange={setDrawerTab}
        height={drawerHeight}
        onResize={setDrawerHeight}
      />
    </div>
  );
}

/** `1 relationship`, `2 relationships` — the header reads as prose, not a table. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function describe(err: unknown, fallback: string): { title: string; detail?: string } {
  if (err instanceof ApiError) {
    return {
      title: err.isOffline
        ? 'The Studio server is not responding — is `just studio` running?'
        : err.message || fallback,
      detail: err.detail,
    };
  }
  return { title: fallback, detail: err instanceof Error ? err.message : String(err) };
}
