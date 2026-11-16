/**
 * A double-clicked card sets the filter box to `1+<name>+1` (STUDIO-5).
 *
 * The real `GraphPane` and `SchemaCanvas` are rendered; only ReactFlow itself
 * is replaced, by a stand-in that records the props the canvas hands it (there
 * is no DOM here to click in). Its `onNodeDoubleClick` is then called the way
 * ReactFlow calls it, and what reaches the pane's `onQueryChange` is asserted.
 * Rendering the pane again with that query shows it in the box and narrows the
 * canvas to the focused subset.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SerializedDomainGraph } from '@studio-shared';

// The component library is read from source (tsconfig `paths`), so its own
// `react` import resolves to a second copy under the library's node_modules,
// whose hooks have no dispatcher inside this app's renderer. For this test the
// library's copy is pointed at this app's one.
import * as React from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
const libraryDir = path.resolve(import.meta.dir, '../../../../packages/graph-components/src');
mock.module(createRequire(path.join(libraryDir, 'index.ts')).resolve('react'), () => React);

const real = await import('@xyflow/react');
let flowProps: Record<string, unknown> = {};
mock.module('@xyflow/react', () => ({
  ...real,
  ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
    flowProps = props;
    return null;
  },
}));

const { GraphPane } = await import('../graph/GraphPane');
const { adaptDomainGraph } = await import('../adapters/schema-adapter');

type Entity = SerializedDomainGraph['entities'][string];

function entity(name: string): Entity {
  return {
    name,
    plural: `${name}s`,
    table: `${name}s`,
    fields: { id: { name: 'id', type: 'uuid', required: true, nullable: false, unique: false, index: false } },
    relationships: {},
    behaviors: [],
    sourcePath: `entities/${name}.yaml`,
  };
}

function belongsTo(child: string, parent: string): SerializedDomainGraph['edges'][number] {
  return {
    from: child,
    to: parent,
    relationship: { name: parent, type: 'belongs_to', target: parent, foreignKey: `${parent}_id`, resolved: true },
    cardinality: 'N:1',
    bidirectional: false,
  };
}

// grove ← tree ← leaf ← vein, and a lone stone.
const { nodes, edges } = adaptDomainGraph({
  entities: Object.fromEntries(['grove', 'tree', 'leaf', 'vein', 'stone'].map((n) => [n, entity(n)])),
  relationshipDefinitions: {},
  edges: [belongsTo('tree', 'grove'), belongsTo('leaf', 'tree'), belongsTo('vein', 'leaf')],
});

function render(query: string, onQueryChange: (q: string) => void = () => {}): string {
  return renderToStaticMarkup(
    <GraphPane
      nodes={nodes}
      edges={edges}
      loading={false}
      selection={null}
      onSelect={() => {}}
      onRetry={() => {}}
      query={query}
      onQueryChange={onQueryChange}
    />,
  );
}

describe('double-click a card', () => {
  test('sets the box to 1+<name>+1, which shows the card and one hop each way', () => {
    const calls: string[] = [];
    const before = render('', (q) => calls.push(q));
    expect(before).toContain('5 nodes');

    const onNodeDoubleClick = flowProps.onNodeDoubleClick as (event: unknown, node: { id: string }) => void;
    expect(typeof onNodeDoubleClick).toBe('function');
    onNodeDoubleClick({}, { id: 'tree' });
    expect(calls).toEqual(['1+tree+1']);

    const after = render(calls[0]!);
    expect(after).toContain('value="1+tree+1"');
    expect(after).toContain('3 of 5 nodes'); // grove, tree, leaf — not vein (two hops), not stone
  });

  test('an unknown name is a message by the box, not a silent empty canvas', () => {
    const html = render('nowhere+');
    expect(html).toContain('No entity named nowhere');
    expect(html).toContain('role="status"');
  });
});
