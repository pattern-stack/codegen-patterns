import { useState, useEffect } from 'react';
import { SchemaCanvas } from './canvas/SchemaCanvas';
import { adaptDomainGraph } from './adapters/schema-adapter';
import type { GraphNodeData, GraphEdgeData } from '@pattern-stack/graph-components';
import type { SerializedDomainGraph } from './adapters/schema-adapter';

/**
 * Root application component for the Schema Graph Viewer.
 *
 * Loads graph data from one of these sources (in order):
 * 1. window.__GRAPH_DATA__ — pre-adapted nodes/edges injected by CLI
 * 2. window.__DOMAIN_GRAPH__ — raw DomainGraph JSON, needs SchemaAdapter
 * 3. ?data=<url> query parameter pointing to a graph.json file
 * 4. /graph.json default fetch path
 * 5. Built-in demo data for development
 */
export function App() {
  const [nodes, setNodes] = useState<GraphNodeData[]>([]);
  const [edges, setEdges] = useState<GraphEdgeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadGraphData()
      .then(({ nodes: n, edges: e }) => {
        setNodes(n);
        setEdges(e);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <p>Loading graph data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ color: '#ef4444', fontWeight: 600 }}>Failed to load graph data</p>
        <p style={{ color: '#6b7280' }}>{error}</p>
      </div>
    );
  }

  return <SchemaCanvas nodes={nodes} edges={edges} />;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __GRAPH_DATA__?: { nodes: GraphNodeData[]; edges: GraphEdgeData[] };
    __DOMAIN_GRAPH__?: SerializedDomainGraph;
  }
}

async function loadGraphData(): Promise<{
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}> {
  // 1. Check for pre-adapted data
  if (window.__GRAPH_DATA__) {
    return window.__GRAPH_DATA__;
  }

  // 2. Check for raw DomainGraph (run through adapter)
  if (window.__DOMAIN_GRAPH__) {
    return adaptDomainGraph(window.__DOMAIN_GRAPH__);
  }

  // 3. Check for ?data= query param
  const params = new URLSearchParams(window.location.search);
  const dataUrl = params.get('data');
  if (dataUrl) {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${dataUrl}: ${res.status}`);
    const json = await res.json();
    // Auto-detect format: if it has 'entities' key, it's a DomainGraph
    if (json.entities && !json.nodes) {
      return adaptDomainGraph(json as SerializedDomainGraph);
    }
    return json;
  }

  // 4. Try default /graph.json
  try {
    const res = await fetch('/graph.json');
    if (res.ok) {
      const json = await res.json();
      if (json.entities && !json.nodes) {
        return adaptDomainGraph(json as SerializedDomainGraph);
      }
      return json;
    }
  } catch {
    // Fall through to demo data
  }

  // 5. Demo data for development
  return getDemoData();
}

function getDemoData(): { nodes: GraphNodeData[]; edges: GraphEdgeData[] } {
  return {
    nodes: [
      {
        id: 'person',
        label: 'Person',
        kind: 'entity',
        group: 'crm-synced',
        fields: [
          { name: 'id', type: 'uuid', role: 'pk', system: true },
          { name: 'first_name', type: 'string', role: 'required' },
          { name: 'last_name', type: 'string', role: 'required' },
          { name: 'email', type: 'string', role: 'required' },
          { name: 'phone', type: 'string', role: 'nullable' },
        ],
        behaviors: ['timestamps', 'soft_delete'],
        fieldCount: 5,
        queryCount: 2,
      },
      {
        id: 'organization',
        label: 'Organization',
        kind: 'entity',
        group: 'crm-synced',
        fields: [
          { name: 'id', type: 'uuid', role: 'pk', system: true },
          { name: 'name', type: 'string', role: 'required' },
          { name: 'domain', type: 'string', role: 'nullable' },
          { name: 'industry', type: 'enum', role: 'nullable' },
        ],
        behaviors: ['timestamps', 'soft_delete'],
        fieldCount: 4,
        queryCount: 1,
      },
      {
        id: 'opportunity',
        label: 'Opportunity',
        kind: 'entity',
        group: 'crm-synced',
        fields: [
          { name: 'id', type: 'uuid', role: 'pk', system: true },
          { name: 'title', type: 'string', role: 'required' },
          { name: 'value', type: 'decimal', role: 'nullable' },
          { name: 'stage', type: 'enum', role: 'required' },
          { name: 'close_date', type: 'date', role: 'nullable' },
        ],
        behaviors: ['timestamps', 'soft_delete', 'user_tracking'],
        fieldCount: 5,
        queryCount: 3,
      },
      {
        id: 'engagement',
        label: 'Engagement',
        kind: 'entity',
        group: 'activity',
        fields: [
          { name: 'id', type: 'uuid', role: 'pk', system: true },
          { name: 'type', type: 'enum', role: 'required' },
          { name: 'subject', type: 'string', role: 'required' },
          { name: 'occurred_at', type: 'timestamp', role: 'required' },
        ],
        behaviors: ['timestamps'],
        fieldCount: 4,
        queryCount: 2,
      },
      {
        id: 'person_organization',
        label: 'PersonOrganization',
        kind: 'relationship',
        from: 'person',
        to: 'organization',
        types: [
          { name: 'employed_by', direction: 'directed' },
          { name: 'founded', direction: 'directed' },
          { name: 'advisor', direction: 'bidirectional' },
        ],
        flags: ['temporal'],
        fieldCount: 0,
        queryCount: 0,
      },
    ],
    edges: [
      { id: 'e-po-person', source: 'person', target: 'person_organization', type: 'junction', cardinality: '1:N' },
      { id: 'e-po-org', source: 'person_organization', target: 'organization', type: 'junction', cardinality: 'N:1' },
      { id: 'e-opp-org', source: 'opportunity', target: 'organization', type: 'inline', cardinality: 'N:1', label: 'belongs_to' },
      { id: 'e-eng-person', source: 'engagement', target: 'person', type: 'inline', cardinality: 'N:1', label: 'belongs_to' },
      { id: 'e-eng-opp', source: 'engagement', target: 'opportunity', type: 'inline', cardinality: 'N:1', label: 'belongs_to' },
    ],
  };
}
