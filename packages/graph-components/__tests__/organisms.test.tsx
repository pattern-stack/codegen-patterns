import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { GraphNode } from '../src/organisms/GraphNode.js';
import { DetailPanel } from '../src/organisms/DetailPanel.js';
import { GraphLegend } from '../src/organisms/GraphLegend.js';
import { StatusBar } from '../src/organisms/StatusBar.js';
import type { GraphNodeData } from '../src/types/graph-node-data.js';

const entityNode: GraphNodeData = {
  id: 'person',
  label: 'Person',
  subtitle: 'persons',
  kind: 'entity',
  group: 'synced',
  fields: [
    { name: 'id', type: 'uuid', role: 'pk' },
    { name: 'first_name', type: 'string', role: 'required' },
    { name: 'last_name', type: 'string', role: 'required' },
    { name: 'email', type: 'string', role: 'nullable' },
    { name: 'created_at', type: 'timestamp', system: true },
  ],
  behaviors: ['timestamps', 'soft_delete'],
  fieldCount: 5,
  queryCount: 2,
};

const relationshipNode: GraphNodeData = {
  id: 'employment',
  label: 'Employment',
  kind: 'relationship',
  from: 'person',
  to: 'organization',
  selfReferential: false,
  types: [
    { name: 'employed_by', direction: 'directed' },
    { name: 'manages', direction: 'inverse', inverseName: 'managed_by' },
  ],
  flags: ['temporal'],
  fieldCount: 3,
  queryCount: 1,
};

const recordNode: GraphNodeData = {
  id: 'rec-123',
  label: 'Alice Smith',
  subtitle: 'person',
  kind: 'record',
  group: 'person',
  fields: [
    { name: 'first_name', value: 'Alice' },
    { name: 'last_name', value: 'Smith' },
    { name: 'email', value: 'alice@example.com' },
  ],
};

describe('GraphNode', () => {
  it('should render entity node', () => {
    const el = createElement(GraphNode, { data: entityNode });
    expect(el.props.data.kind).toBe('entity');
    expect(el.props.data.fields).toHaveLength(5);
  });

  it('should render relationship node', () => {
    const el = createElement(GraphNode, { data: relationshipNode });
    expect(el.props.data.kind).toBe('relationship');
    expect(el.props.data.from).toBe('person');
    expect(el.props.data.to).toBe('organization');
  });

  it('should render record node', () => {
    const el = createElement(GraphNode, { data: recordNode });
    expect(el.props.data.kind).toBe('record');
  });

  it('should accept selected and dimmed states', () => {
    const el = createElement(GraphNode, { data: entityNode, selected: true, dimmed: false });
    expect(el.props.selected).toBe(true);
    expect(el.props.dimmed).toBe(false);
  });

  it('should accept compact mode', () => {
    const el = createElement(GraphNode, { data: entityNode, compact: true });
    expect(el.props.compact).toBe(true);
  });

  it('should accept onClick and onHover handlers', () => {
    const onClick = () => {};
    const onHover = () => {};
    const el = createElement(GraphNode, { data: entityNode, onClick, onHover });
    expect(el.props.onClick).toBe(onClick);
    expect(el.props.onHover).toBe(onHover);
  });
});

describe('DetailPanel', () => {
  it('should render null when no node', () => {
    const el = createElement(DetailPanel, { node: null, onClose: () => {} });
    expect(el.props.node).toBeNull();
  });

  it('should render entity detail', () => {
    const el = createElement(DetailPanel, { node: entityNode, onClose: () => {} });
    expect(el.props.node?.label).toBe('Person');
  });

  it('should render relationship detail', () => {
    const el = createElement(DetailPanel, { node: relationshipNode, onClose: () => {} });
    expect(el.props.node?.kind).toBe('relationship');
  });

  it('should accept custom width', () => {
    const el = createElement(DetailPanel, { node: entityNode, onClose: () => {}, width: 400 });
    expect(el.props.width).toBe(400);
  });
});

describe('GraphLegend', () => {
  it('should render legend items', () => {
    const items = [
      { icon: 'entity' as const, label: 'Entity', color: '#3b82f6' },
      { icon: 'relationship' as const, label: 'Relationship', color: '#10b981' },
    ];
    const el = createElement(GraphLegend, { items });
    expect(el.props.items).toHaveLength(2);
  });

  it('should accept position', () => {
    const el = createElement(GraphLegend, {
      items: [{ icon: 'entity' as const, label: 'Entity', color: '#3b82f6' }],
      position: 'top-right',
    });
    expect(el.props.position).toBe('top-right');
  });

  it('should handle empty items', () => {
    const el = createElement(GraphLegend, { items: [] });
    expect(el.props.items).toHaveLength(0);
  });
});

describe('StatusBar', () => {
  it('should render stats', () => {
    const el = createElement(StatusBar, {
      stats: [
        { label: 'entities', value: 12 },
        { label: 'relationships', value: 5 },
      ],
    });
    expect(el.props.stats).toHaveLength(2);
  });

  it('should render warnings', () => {
    const el = createElement(StatusBar, {
      stats: [{ label: 'entities', value: 12 }],
      warnings: ['Orphan entity: webhook', 'Circular dependency: A → B → A'],
    });
    expect(el.props.warnings).toHaveLength(2);
  });

  it('should handle no warnings', () => {
    const el = createElement(StatusBar, {
      stats: [{ label: 'nodes', value: 10 }],
    });
    expect(el.props.warnings).toBeUndefined();
  });
});
