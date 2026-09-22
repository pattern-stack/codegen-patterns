import { useMemo, useState } from 'react';
import type { GraphNodeData } from '@pattern-stack/graph-components';
import { useGraphFilter } from '@pattern-stack/graph-components';
import { SchemaCanvas } from './SchemaCanvas';
import type { StudioEdgeData } from './edge-kinds';
import { Button, EmptyState, ErrorState, LoadingState } from '../ui/primitives';

export interface GraphPaneProps {
  nodes: GraphNodeData[];
  edges: StudioEdgeData[];
  loading: boolean;
  error?: { title: string; detail?: string };
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRetry: () => void;
}

/** Filter chips, derived from the graph so they describe what is actually in it. */
function useFilterChips(nodes: GraphNodeData[]) {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const key = node.kind === 'relationship' ? 'relationship' : (node.group ?? 'Base');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [nodes]);
}

export function GraphPane({
  nodes,
  edges,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: GraphPaneProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Record<string, boolean>>({});
  const chips = useFilterChips(nodes);

  const { filteredNodes, filteredEdges } = useGraphFilter(nodes, edges, { query, filters: active });
  // `useGraphFilter` narrows edges to the surviving nodes but returns the
  // library's edge type; the Studio kind rides along on the same objects.
  const shownEdges = filteredEdges as StudioEdgeData[];

  const body = () => {
    if (error) {
      return <ErrorState title={error.title} detail={error.detail} onRetry={onRetry} />;
    }
    if (loading) {
      return <LoadingState label="Reading the model…" />;
    }
    if (nodes.length === 0) {
      return (
        <EmptyState
          title="No entities in this project"
          body="The server found no entity YAML to analyze. Add a file under the project's entities directory, then reload the graph."
        />
      );
    }
    if (filteredNodes.length === 0) {
      return (
        <EmptyState
          title="Nothing matches this filter"
          body={
            <Button
              onClick={() => {
                setQuery('');
                setActive({});
              }}
            >
              Clear filters
            </Button>
          }
        />
      );
    }
    return (
      <SchemaCanvas
        nodes={filteredNodes}
        edges={shownEdges}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          height: 'var(--h-tabbar)',
          flex: '0 0 var(--h-tabbar)',
          padding: '0 var(--sp-3)',
          borderBottom: '1px solid var(--s-line)',
          background: 'var(--s-chrome)',
          overflowX: 'auto',
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter entities, fields, types…"
          aria-label="Filter the graph"
          style={{
            width: 230,
            flex: '0 0 auto',
            height: 24,
            padding: '0 var(--sp-2)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--s-line-strong)',
            background: 'var(--s-canvas)',
            color: 'var(--t-primary)',
            fontFamily: 'inherit',
            fontSize: 12,
          }}
        />
        {chips.map(([key, count]) => {
          const on = active[key] === true;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => setActive((prev) => ({ ...prev, [key]: !on }))}
              style={{
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 22,
                padding: '0 var(--sp-2)',
                borderRadius: 999,
                border: `1px solid ${on ? 'var(--accent)' : 'var(--s-line-strong)'}`,
                background: on ? 'var(--accent-soft)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--t-muted)',
                fontFamily: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {key}
              <span style={{ opacity: 0.7 }}>{count}</span>
            </button>
          );
        })}
        <span style={{ marginLeft: 'auto', flex: '0 0 auto', fontSize: 11, color: 'var(--t-muted)' }}>
          {filteredNodes.length === nodes.length
            ? `${nodes.length} nodes · ${shownEdges.length} edges`
            : `${filteredNodes.length} of ${nodes.length} nodes`}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>{body()}</div>
    </div>
  );
}
