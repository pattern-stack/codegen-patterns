/**
 * The canvas layout: a tree on the spine lines (STUDIO-3), parents above
 * children (#778), each line on its own channel (#890).
 *
 * The #778 shape: one parent with two children that both `belongs_to` it, and
 * one of those children also `belongs_to` a second parent — every `belongs_to`
 * with its inverse `has_many` declared, so the graph the analyzer returns has
 * the 2-cycles that used to leave the layout with no direction to follow.
 * Through the real adapter: what is asserted is the picture.
 */
import { describe, expect, test } from 'bun:test';
import type { SerializedDomainGraph } from '@studio-shared';

import { adaptDomainGraph } from '../adapters/schema-adapter';
import { estimateNodeSize, treeLayout } from '../layout/tree-layout';

type Entity = SerializedDomainGraph['entities'][string];
type Edge = SerializedDomainGraph['edges'][number];
type Rel = Edge['relationship'];

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
function fk(child: string, parent: string, over: Partial<Rel> = {}): Edge[] {
  const column = `${parent}_id`;
  return [
    {
      from: child,
      to: parent,
      relationship: {
        name: parent,
        type: 'belongs_to',
        target: parent,
        foreignKey: column,
        resolved: true,
        onDelete: 'restrict',
        fkUnique: false,
        ...over,
      },
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

function graphOf(names: string[], edges: Edge[]): SerializedDomainGraph {
  return {
    entities: Object.fromEntries(names.map((n) => [n, entity(n)])),
    relationshipDefinitions: {},
    edges,
  };
}

// `catalog` is the parent of `book` and `chart`; `chart` also belongs to `atlas`.
const SHAPE: SerializedDomainGraph = graphOf(
  ['book', 'chart', 'catalog', 'atlas'],
  [...fk('book', 'catalog'), ...fk('chart', 'catalog'), ...fk('chart', 'atlas')],
);

const PARENT_OF: [parent: string, child: string][] = [
  ['catalog', 'book'],
  ['catalog', 'chart'],
  ['atlas', 'chart'],
];

describe('treeLayout — parents above children (#778)', () => {
  test('each parent sits above each of its children', () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    const laid = treeLayout(nodes, edges);
    const y = new Map(laid.nodes.map((n) => [n.id, n.position.y]));

    const violations = PARENT_OF.flatMap(([parent, child]) =>
      y.get(parent)! < y.get(child)!
        ? []
        : [`parent below child: ${parent} (y=${y.get(parent)}) is not above ${child} (y=${y.get(child)})`],
    );
    expect(violations).toEqual([]);
  });

  test('the drawn edges keep their meaning — FK holder → referenced, one per foreign key', () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    const laid = treeLayout(nodes, edges);
    expect(laid.edges.map((e) => [e.source, e.target])).toEqual([
      ['book', 'catalog'],
      ['chart', 'catalog'],
      ['chart', 'atlas'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The tree (STUDIO-3)
// ---------------------------------------------------------------------------

/**
 * Two parents and a two-parent child. `sheet` declares `binder` first (plain)
 * and `folder` second through a unique FK with cascade — so its spine is
 * `folder` and `binder` is a secondary line. `binder` has two children of its
 * own, `memo` and `note`; `tag` is a lone root.
 */
const NAMES = ['binder', 'folder', 'memo', 'note', 'sheet', 'tag'];
const SPINE_EDGES: Edge[] = [
  ...fk('memo', 'binder'),
  ...fk('note', 'binder'),
  ...fk('sheet', 'folder', { fkUnique: true, onDelete: 'cascade' }),
];
const SECONDARY_SHEET_BINDER = fk('sheet', 'binder');
const SECONDARY_MEMO_FOLDER = fk('memo', 'folder');

/** `sheet → binder` declared before `sheet → folder`, as the YAML would. */
const TWO_PARENT = graphOf(NAMES, [
  ...fk('memo', 'binder'),
  ...fk('note', 'binder'),
  ...SECONDARY_SHEET_BINDER,
  ...fk('sheet', 'folder', { fkUnique: true, onDelete: 'cascade' }),
]);

function lay(graph: SerializedDomainGraph) {
  const { nodes, edges } = adaptDomainGraph(graph);
  const laid = treeLayout(nodes, edges);
  const box = new Map(
    laid.nodes.map((n) => {
      const size = estimateNodeSize(nodes.find((x) => x.id === n.id)!);
      return [n.id, { x: n.position.x, y: n.position.y, width: size.width, height: size.height }];
    }),
  );
  return { laid, box, edges };
}

const centre = (b: { x: number; width: number }) => b.x + b.width / 2;

describe('treeLayout — a tree on the spine lines (STUDIO-3)', () => {
  test('the two-parent child sits directly under its spine parent, not its secondary parent', () => {
    const { box, edges } = lay(TWO_PARENT);
    const sheet = box.get('sheet')!;
    const folder = box.get('folder')!;
    const binder = box.get('binder')!;

    expect(edges.find((e) => e.child === 'sheet' && e.parent === 'folder')!.treeRole).toBe('spine');
    expect(edges.find((e) => e.child === 'sheet' && e.parent === 'binder')!.treeRole).toBe('secondary');

    expect(sheet.y).toBeGreaterThan(folder.y);
    expect(centre(sheet)).toBe(centre(folder));
    // Outside the secondary parent's columns entirely.
    expect(sheet.x >= binder.x + binder.width || sheet.x + sheet.width <= binder.x).toBe(true);
  });

  test('adding or removing a secondary line moves no card', () => {
    const positions = (graph: SerializedDomainGraph) =>
      Object.fromEntries(lay(graph).laid.nodes.map((n) => [n.id, n.position]));

    const without = positions(graphOf(NAMES, SPINE_EDGES));
    const withOne = positions(TWO_PARENT);
    const withTwo = positions(graphOf(NAMES, [...TWO_PARENT.edges, ...SECONDARY_MEMO_FOLDER]));

    expect(withOne).toEqual(without);
    expect(withTwo).toEqual(without);
    // Exact positions, so a layout that moved everything consistently would still fail.
    expect(without).toEqual({
      // binder's subtree is memo + gap + note = 546 wide, binder centred in it;
      // folder's starts a tree gap (92) later; row 1 = card height 68 + gap 96.
      binder: { x: 148, y: 0 },
      folder: { x: 638, y: 0 },
      memo: { x: 0, y: 164 },
      note: { x: 296, y: 164 },
      sheet: { x: 638, y: 164 },
      tag: { x: 980, y: 0 },
    });
  });

  test('siblings sit side by side in one row, under their parent', () => {
    const { box } = lay(TWO_PARENT);
    const memo = box.get('memo')!;
    const note = box.get('note')!;
    const binder = box.get('binder')!;
    expect(memo.y).toBe(note.y);
    expect(memo.x + memo.width).toBeLessThan(note.x);
    // The parent is centred over its children.
    expect(centre(binder)).toBe((centre(memo) + centre(note)) / 2);
  });

  test('roots are on the top row, every other card below it', () => {
    const { box, edges } = lay(TWO_PARENT);
    const children = new Set(edges.filter((e) => e.treeRole === 'spine').map((e) => e.child));
    const misplaced = NAMES.flatMap((n) => {
      const y = box.get(n)!.y;
      if (children.has(n)) return y > 0 ? [] : [`${n} has a spine parent but is on the top row`];
      return y === 0 ? [] : [`root ${n} is at y=${y}, not on the top row`];
    });
    expect(misplaced).toEqual([]);
    expect([...children].sort()).toEqual(['memo', 'note', 'sheet']);
  });
});

// ---------------------------------------------------------------------------
// One channel per line (#890)
// ---------------------------------------------------------------------------

describe('treeLayout — each line on its own channel (#890)', () => {
  test('lines between the same two rows never share a horizontal run', () => {
    const graph = graphOf(NAMES, [...TWO_PARENT.edges, ...SECONDARY_MEMO_FOLDER]);
    const { laid, box } = lay(graph);
    const data = laid.lines;
    expect(data.length).toBe(5);

    const channels = data.map((d) => d.channelY);
    expect(channels.every((c) => c != null)).toBe(true);
    expect(new Set(channels).size).toBe(channels.length);

    // Every channel lies in the gap between row 0's tallest card and row 1.
    const rowBottom = Math.max(...['binder', 'folder', 'tag'].map((n) => box.get(n)!.y + box.get(n)!.height));
    const nextTop = box.get('memo')!.y;
    const outside = data.filter((d) => !(d.channelY! > rowBottom && d.channelY! < nextTop)).map((d) => d.id);
    expect(outside).toEqual([]);
  });
});
