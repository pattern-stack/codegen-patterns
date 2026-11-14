/**
 * The canvas layout ranks parents above their children (#778).
 *
 * The shape: one parent with two children that both `belongs_to` it, and one
 * of those children also `belongs_to` a second parent — every `belongs_to`
 * with its inverse `has_many` declared, so the graph the analyzer returns has
 * the 2-cycles that used to leave `layered` with no direction to follow. Real
 * elk, through the real adapter: what is asserted is the picture.
 */
import { describe, expect, test } from 'bun:test';
import type { SerializedDomainGraph } from '@studio-shared';

import { adaptDomainGraph } from '../adapters/schema-adapter';

/**
 * The layout module, loaded the way a browser would see it.
 *
 * elkjs's bundled worker decides at load time whether it *is* a web worker:
 * `self` defined and `document` not. Bun defines `self`, so the bundle
 * registers itself as a worker and exports nothing, and `new ELK()` throws.
 * For the one load, `document` exists, as it does on the page; it is put back
 * as it was straight after, so no other test sees it.
 */
async function loadLayout(): Promise<typeof import('../layout/elk-layout')> {
  const g = globalThis as { document?: unknown };
  const had = 'document' in g;
  const prev = g.document;
  if (!had) g.document = {};
  try {
    return await import('../layout/elk-layout');
  } finally {
    if (!had) delete g.document;
    else g.document = prev;
  }
}

const { elkLayout } = await loadLayout();

type Entity = SerializedDomainGraph['entities'][string];
type Edge = SerializedDomainGraph['edges'][number];

function entity(name: string): Entity {
  return {
    name,
    plural: `${name}s`,
    table: `${name}s`,
    fields: {
      id: { name: 'id', type: 'uuid', required: true, nullable: false, unique: false, index: false },
    },
    relationships: {},
    behaviors: [],
    sourcePath: `entities/${name}.yaml`,
  };
}

/** `child` belongs_to `parent` on `<parent>_id`, and `parent` has_many it back. */
function fk(child: string, parent: string): Edge[] {
  const column = `${parent}_id`;
  return [
    {
      from: child,
      to: parent,
      relationship: { name: parent, type: 'belongs_to', target: parent, foreignKey: column, resolved: true },
      cardinality: 'N:1',
      bidirectional: true,
    },
    {
      from: parent,
      to: child,
      relationship: { name: `${child}s`, type: 'has_many', target: child, foreignKey: column, resolved: true },
      cardinality: '1:N',
      bidirectional: true,
    },
  ];
}

// `catalog` is the parent of `book` and `chart`; `chart` also belongs to `atlas`.
const SHAPE: SerializedDomainGraph = {
  entities: {
    book: entity('book'),
    chart: entity('chart'),
    catalog: entity('catalog'),
    atlas: entity('atlas'),
  },
  relationshipDefinitions: {},
  edges: [...fk('book', 'catalog'), ...fk('chart', 'catalog'), ...fk('chart', 'atlas')],
};

const PARENT_OF: [parent: string, child: string][] = [
  ['catalog', 'book'],
  ['catalog', 'chart'],
  ['atlas', 'chart'],
];

describe('elkLayout — parents above children (#778)', () => {
  test('each parent sits above each of its children', async () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    const laid = await elkLayout(nodes, edges);
    const y = new Map(laid.nodes.map((n) => [n.id, n.position.y]));

    const violations = PARENT_OF.flatMap(([parent, child]) =>
      y.get(parent)! < y.get(child)!
        ? []
        : [`parent below child: ${parent} (y=${y.get(parent)}) is not above ${child} (y=${y.get(child)})`],
    );
    expect(violations).toEqual([]);
  });

  test('the drawn edges keep their meaning — FK holder → referenced, one per foreign key', async () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    const laid = await elkLayout(nodes, edges);
    expect(laid.edges.map((e) => [e.source, e.target])).toEqual([
      ['book', 'catalog'],
      ['chart', 'catalog'],
      ['chart', 'atlas'],
    ]);
  });
});
