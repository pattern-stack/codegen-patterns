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
import { estimateNodeSize, packBlocks, treeLayout } from '../layout/tree-layout';

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
  // Narrowed by STUDIO-4: #778's "parents above children" is about the spine
  // (since STUDIO-3). Every SPINE parent sits above its child, and so does a
  // secondary parent in the SAME tree block; a secondary parent in another
  // block may sit in any row, because blocks wrap into rows and a secondary
  // line moves no card. The next test pins that case.
  test('each parent sits above each of its children', () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    const laid = treeLayout(nodes, edges);
    const y = new Map(laid.nodes.map((n) => [n.id, n.position.y]));
    const spineParent = new Map(edges.filter((e) => e.treeRole === 'spine').map((e) => [e.child, e.parent]));
    const rootOf = (id: string): string => (spineParent.has(id) ? rootOf(spineParent.get(id)!) : id);

    const checked = PARENT_OF.filter(
      ([parent, child]) => spineParent.get(child) === parent || rootOf(parent) === rootOf(child),
    );
    expect(checked).toEqual([
      ['catalog', 'book'],
      ['catalog', 'chart'],
    ]);
    const violations = checked.flatMap(([parent, child]) =>
      y.get(parent)! < y.get(child)!
        ? []
        : [`parent below child: ${parent} (y=${y.get(parent)}) is not above ${child} (y=${y.get(child)})`],
    );
    expect(violations).toEqual([]);
  });

  test('a one-card secondary parent docks directly under its referencer (STUDIO-4)', () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    expect(edges.find((e) => e.child === 'chart' && e.parent === 'atlas')!.treeRole).toBe('secondary');
    const laid = treeLayout(nodes, edges);
    const at = Object.fromEntries(laid.nodes.map((n) => [n.id, n.position]));
    // atlas is a one-card tree referenced by chart, so it docks: x-centred
    // under chart, its top the catalog block's bottom (164 + 68 = 232) plus the
    // row spacing (96). Before docking it wrapped to { x: 0, y: 424 }.
    expect(at).toEqual({
      book: { x: 0, y: 164 },
      chart: { x: 296, y: 164 },
      catalog: { x: 148, y: 0 },
      atlas: { x: 296, y: 328 },
    });
  });

  test("a multi-card secondary parent in another block wraps where its block's size puts it — below its child here (#778)", () => {
    // atlas now has a child of its own, so its tree is two cards and never docks.
    const graph = graphOf(
      ['book', 'chart', 'catalog', 'atlas', 'map'],
      [...fk('book', 'catalog'), ...fk('chart', 'catalog'), ...fk('map', 'atlas'), ...fk('chart', 'atlas')],
    );
    const { nodes, edges } = adaptDomainGraph(graph);
    expect(edges.find((e) => e.child === 'chart' && e.parent === 'atlas')!.treeRole).toBe('secondary');
    const at = Object.fromEntries(treeLayout(nodes, edges, { targetAspect: 0.8 }).nodes.map((n) => [n.id, n.position]));
    // At 0.8:1 the atlas block wraps under the catalog block: its row starts at
    // the first row's height (232) plus the block-row gap (192) — below chart.
    expect(at).toEqual({
      book: { x: 0, y: 164 },
      chart: { x: 296, y: 164 },
      catalog: { x: 148, y: 0 },
      atlas: { x: 0, y: 424 },
      map: { x: 0, y: 588 },
    });
    // The secondary line placed nothing: the same without it.
    const without = graphOf(
      ['book', 'chart', 'catalog', 'atlas', 'map'],
      [...fk('book', 'catalog'), ...fk('chart', 'catalog'), ...fk('map', 'atlas')],
    );
    const bare = adaptDomainGraph(without);
    expect(
      Object.fromEntries(treeLayout(bare.nodes, bare.edges, { targetAspect: 0.8 }).nodes.map((n) => [n.id, n.position])),
    ).toEqual(at);
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
 * and `folder` second through a cascading FK — so its spine is
 * `folder` and `binder` is a secondary line. `binder` has two children of its
 * own, `memo` and `note`; `tag` is a lone root.
 */
const NAMES = ['binder', 'folder', 'memo', 'note', 'sheet', 'tag'];
const SPINE_EDGES: Edge[] = [
  ...fk('memo', 'binder'),
  ...fk('note', 'binder'),
  ...fk('sheet', 'folder', { onDelete: 'cascade' }),
];
const SECONDARY_SHEET_BINDER = fk('sheet', 'binder');
const SECONDARY_MEMO_FOLDER = fk('memo', 'folder');

/** `sheet → binder` declared before `sheet → folder`, as the YAML would. */
const TWO_PARENT = graphOf(NAMES, [
  ...fk('memo', 'binder'),
  ...fk('note', 'binder'),
  ...SECONDARY_SHEET_BINDER,
  ...fk('sheet', 'folder', { onDelete: 'cascade' }),
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
      // At 16:10 tag wraps to a second row of blocks (STUDIO-4): the first row
      // is 232 tall, plus the block-row gap (192).
      binder: { x: 148, y: 0 },
      folder: { x: 638, y: 0 },
      memo: { x: 0, y: 164 },
      note: { x: 296, y: 164 },
      sheet: { x: 638, y: 164 },
      tag: { x: 0, y: 424 },
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

  test("roots are on their block's top row, every other card below it", () => {
    const { box, edges } = lay(TWO_PARENT);
    const children = new Set(edges.filter((e) => e.treeRole === 'spine').map((e) => e.child));
    // The fixture's three trees, root first.
    const TREES = [
      ['binder', 'memo', 'note'],
      ['folder', 'sheet'],
      ['tag'],
    ];
    const misplaced = TREES.flatMap(([root, ...rest]) => {
      const top = box.get(root!)!.y;
      return [
        ...(children.has(root!) ? [`${root} has a spine parent but roots a tree`] : []),
        ...rest.flatMap((n) => (box.get(n)!.y > top ? [] : [`${n} is not below its tree's root ${root}`])),
      ];
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

    // Every channel lies in the gap between row 0's tallest card and row 1 of
    // the first row of blocks (tag wrapped below it and runs no line).
    const rowBottom = Math.max(...['binder', 'folder'].map((n) => box.get(n)!.y + box.get(n)!.height));
    const nextTop = box.get('memo')!.y;
    const outside = data.filter((d) => !(d.channelY! > rowBottom && d.channelY! < nextTop)).map((d) => d.id);
    expect(outside).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tree blocks wrapped to the canvas (STUDIO-4)
// ---------------------------------------------------------------------------

/**
 * Eight entities in three disconnected trees, plus two secondary lines:
 * `library` → `shelf`, `desk`; `shelf` → `volume` (4 cards); `garden` → `bed`,
 * `plot` (3); `pond` alone (1). `volume → desk` and `plot → library` are
 * declared before nothing — each card already has a plain spine parent listed
 * first, so both are secondary.
 */
const EIGHT = ['bed', 'desk', 'garden', 'library', 'plot', 'pond', 'shelf', 'volume'];
const EIGHT_SPINES: Edge[] = [
  ...fk('shelf', 'library'),
  ...fk('desk', 'library'),
  ...fk('volume', 'shelf'),
  ...fk('bed', 'garden'),
  ...fk('plot', 'garden'),
];
const EIGHT_SECONDARY: Edge[] = [...fk('volume', 'desk'), ...fk('plot', 'library')];
const EIGHT_TREES = [
  ['library', 'shelf', 'desk', 'volume'],
  ['garden', 'bed', 'plot'],
  ['pond'],
];

function layAt(graph: SerializedDomainGraph, targetAspect: number) {
  const { nodes, edges } = adaptDomainGraph(graph);
  const laid = treeLayout(nodes, edges, { targetAspect });
  const box = new Map(
    laid.nodes.map((n) => {
      const size = estimateNodeSize(nodes.find((x) => x.id === n.id)!);
      return [n.id, { x: n.position.x, y: n.position.y, width: size.width, height: size.height }];
    }),
  );
  return { laid, box, edges };
}

type Box = { x: number; y: number; width: number; height: number };
function bounds(boxes: Iterable<Box>) {
  const all = [...boxes];
  const left = Math.min(...all.map((b) => b.x));
  const top = Math.min(...all.map((b) => b.y));
  const right = Math.max(...all.map((b) => b.x + b.width));
  const bottom = Math.max(...all.map((b) => b.y + b.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** A box's aspect is "close" to the target within a factor of 1.25 either way. */
const ASPECT_TOLERANCE = 1.25;

describe('treeLayout — tree blocks wrapped to the canvas (STUDIO-4)', () => {
  const graph = graphOf(EIGHT, [...EIGHT_SPINES, ...EIGHT_SECONDARY]);

  test('several trees at 16:10 wrap into at least two rows, and the box is near 16:10', () => {
    const { box } = layAt(graph, 16 / 10);
    const blocks = EIGHT_TREES.map((ids) => bounds(ids.map((id) => box.get(id)!)));
    const rowTops = new Set(blocks.map((b) => b.top));
    expect(rowTops.size).toBeGreaterThanOrEqual(2);

    const all = bounds(box.values());
    const aspect = all.width / all.height;
    expect(aspect).toBeGreaterThan(16 / 10 / ASPECT_TOLERANCE);
    expect(aspect).toBeLessThan((16 / 10) * ASPECT_TOLERANCE);
  });

  test('the blocks never overlap; rows are left-aligned, blocks top-aligned in a row, biggest tree first', () => {
    const { box } = layAt(graph, 16 / 10);
    const blocks = EIGHT_TREES.map((ids) => bounds(ids.map((id) => box.get(id)!)));
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i]!;
        const b = blocks[j]!;
        const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
        expect(apart).toBe(true);
      }
    }
    // library (4) and garden (3) share the first row; pond wraps to the left edge of the second.
    expect(blocks.map((b) => [b.left, b.top])).toEqual([
      [0, 0],
      [blocks[0]!.right + 92, 0],
      [0, Math.max(blocks[0]!.bottom, blocks[1]!.bottom) + 192],
    ]);
  });

  test('every STUDIO-3 invariant holds inside each block', () => {
    const { box, edges } = layAt(graph, 16 / 10);
    const spine = edges.filter((e) => e.treeRole === 'spine');
    expect(spine.map((e) => [e.parent, e.child]).sort()).toEqual(
      [
        ['garden', 'bed'],
        ['garden', 'plot'],
        ['library', 'desk'],
        ['library', 'shelf'],
        ['shelf', 'volume'],
      ].sort(),
    );
    const problems: string[] = [];
    for (const [root, ...rest] of EIGHT_TREES) {
      const top = box.get(root!)!.y;
      for (const id of rest) if (!(box.get(id)!.y > top)) problems.push(`${id} not below its root ${root}`);
    }
    for (const e of spine) {
      const p = box.get(e.parent)!;
      const c = box.get(e.child)!;
      if (!(p.y < c.y)) problems.push(`${e.parent} not above ${e.child}`);
    }
    // One child: centred under it. Two: side by side in one row, parent centred over them.
    if (centre(box.get('volume')!) !== centre(box.get('shelf')!)) problems.push('volume not under shelf');
    for (const [parent, a, b] of [
      // Siblings in node order: the fixture lists entities alphabetically.
      ['library', 'desk', 'shelf'],
      ['garden', 'bed', 'plot'],
    ] as const) {
      const pa = box.get(a)!;
      const pb = box.get(b)!;
      if (pa.y !== pb.y || !(pa.x + pa.width < pb.x)) problems.push(`${a} and ${b} not side by side`);
      if (centre(box.get(parent)!) !== (centre(pa) + centre(pb)) / 2) problems.push(`${parent} not centred`);
    }
    expect(problems).toEqual([]);
  });

  test('the channels of a block lie in the gap below the row they leave', () => {
    const { laid, box } = layAt(graph, 16 / 10);
    const spineLines = laid.lines.filter((l) => l.treeRole === 'spine');
    const outside = spineLines.flatMap((l) => {
      const p = box.get(l.parent)!;
      const c = box.get(l.child)!;
      return l.channelY! > p.y + p.height && l.channelY! < c.y ? [] : [l.id];
    });
    expect(outside).toEqual([]);
    expect(new Set(laid.lines.map((l) => l.channelY)).size).toBe(laid.lines.length);
  });

  test('adding or removing a secondary line moves no card, wrapped or not', () => {
    for (const aspect of [16 / 10, 4 / 3, 21 / 9, 1]) {
      const positions = (g: SerializedDomainGraph) =>
        Object.fromEntries(layAt(g, aspect).laid.nodes.map((n) => [n.id, n.position]));
      expect(positions(graph)).toEqual(positions(graphOf(EIGHT, EIGHT_SPINES)));
    }
  });

  test('the layout is deterministic — same model, same positions; block placement ignores entity order', () => {
    const once = layAt(graph, 16 / 10).laid.nodes.map((n) => [n.id, n.position]);
    const again = layAt(graph, 16 / 10).laid.nodes.map((n) => [n.id, n.position]);
    expect(again).toEqual(once);

    // Siblings follow node order (STUDIO-3), so cards inside a block may swap;
    // where each block goes is by size, then root id, not by listing order.
    const reversed = graphOf([...EIGHT].reverse(), [...EIGHT_SPINES, ...EIGHT_SECONDARY]);
    const blockBoxes = (g: SerializedDomainGraph) => {
      const { box } = layAt(g, 16 / 10);
      return EIGHT_TREES.map((ids) => bounds(ids.map((id) => box.get(id)!)));
    };
    expect(blockBoxes(reversed)).toEqual(blockBoxes(graph));
  });

  test('a single tree is laid out as before, whatever the target aspect', () => {
    const one = graphOf(['library', 'shelf', 'desk', 'volume'], [
      ...fk('shelf', 'library'),
      ...fk('desk', 'library'),
      ...fk('volume', 'shelf'),
    ]);
    const expected = {
      // shelf + gap + desk = 546 wide, library centred over it; volume under shelf.
      library: { x: 148, y: 0 },
      shelf: { x: 0, y: 164 },
      desk: { x: 296, y: 164 },
      volume: { x: 0, y: 328 },
    };
    for (const aspect of [16 / 10, 1 / 4, 8]) {
      expect(Object.fromEntries(layAt(one, aspect).laid.nodes.map((n) => [n.id, n.position]))).toEqual(expected);
    }
  });
});

describe('packBlocks (STUDIO-4)', () => {
  const square = { width: 100, height: 100 };

  test('wraps equal blocks into the grid nearest the target aspect', () => {
    // Four 100×100 blocks, no gaps, at 1:1 → two rows of two.
    expect(packBlocks([square, square, square, square], 1, 0, 0)).toEqual([
      { left: 0, top: 0 },
      { left: 100, top: 0 },
      { left: 0, top: 100 },
      { left: 100, top: 100 },
    ]);
    // At 4:1 → one row.
    expect(packBlocks([square, square, square, square], 4, 0, 0).map((p) => p.top)).toEqual([0, 0, 0, 0]);
    // At 1:4 → one column.
    expect(packBlocks([square, square, square, square], 1 / 4, 0, 0).map((p) => p.left)).toEqual([0, 0, 0, 0]);
  });

  test('keeps the order it is given, rows left-aligned, blocks top-aligned', () => {
    const at = packBlocks(
      [
        { width: 300, height: 200 },
        { width: 100, height: 50 },
        { width: 200, height: 100 },
      ],
      1,
      10,
      20,
    );
    // A 310 limit gives 310×320 (aspect 0.97), the nearest to 1:1: the first
    // block alone, then the other two side by side, both at the row's top.
    expect(at).toEqual([
      { left: 0, top: 0 },
      { left: 0, top: 220 },
      { left: 110, top: 220 },
    ]);
  });

  test('picks the packing that fit-to-view shows largest, not merely the nearest aspect', () => {
    // On a 1:1 canvas: one row is 300×100 (aspect 3, zoom 1/300); wrapping the
    // second block under a tall gap is 200×400 (aspect 0.5 — nearer 1 on a log
    // scale — but zoom 1/400). One row shows the cards larger, so it wins.
    const blocks = [
      { width: 200, height: 100 },
      { width: 100, height: 100 },
    ];
    expect(packBlocks(blocks, 1, 0, 200)).toEqual([
      { left: 0, top: 0 },
      { left: 200, top: 0 },
    ]);
  });

  test("the 8-entity model's blocks: one row on a 2.24:1 canvas, wrapped on 16:10", () => {
    // Its three blocks as `treeLayout` sizes them. On 2.24:1 one row (1526×540)
    // fits larger than wrapping pond (1184×830); on 16:10 the wrap does.
    const blocks = [
      { width: 546, height: 540 },
      { width: 546, height: 328 },
      { width: 250, height: 98 },
    ];
    expect(packBlocks(blocks, 2.24, 92, 192).map((p) => p.top)).toEqual([0, 0, 0]);
    expect(packBlocks(blocks, 16 / 10, 92, 192)).toEqual([
      { left: 0, top: 0 },
      { left: 638, top: 0 },
      { left: 0, top: 732 },
    ]);
  });

  test('a bad target aspect falls back to 16:10, never to one row', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(packBlocks([square, square, square, square], bad, 0, 0)).toEqual(
        packBlocks([square, square, square, square], 16 / 10, 0, 0),
      );
    }
    expect(packBlocks([], 1, 0, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One-card trees dock under their referencer (STUDIO-4)
// ---------------------------------------------------------------------------

/**
 * Canvas aspects a 1440×900 window gives, as measured: the inspector open and
 * hidden with the drawer hidden (1016×780, 1404×780 — full screen measures the
 * same 1404×780, since the drawer is already hidden), the default with the
 * drawer open (1016×540), and the full window height as the tallest bound.
 */
const CANVAS_ASPECTS = {
  'inspector open': 1016 / 780,
  'inspector hidden': 1404 / 780,
  'drawer open': 1016 / 540,
  'full height': 1404 / 900,
};

/**
 * A 4-card tree, `station` → `dock`, `gate`, `lane`, and two one-card trees:
 * `bay`, referenced by `dock`, and `pier`, referenced by `lane`. Each child
 * declares `station` first, so both references are secondary.
 */
const PORT = graphOf(
  ['bay', 'dock', 'gate', 'lane', 'pier', 'station'],
  [
    ...fk('dock', 'station'),
    ...fk('gate', 'station'),
    ...fk('lane', 'station'),
    ...fk('dock', 'bay'),
    ...fk('lane', 'pier'),
  ],
);
const STATION_TREE = ['station', 'dock', 'gate', 'lane'];

/** `docked`'s offset from `by`: x-centre difference and top below `by`'s block bottom. */
function dockOffset(box: Map<string, Box>, docked: string, by: string, hostTree: string[]) {
  const d = box.get(docked)!;
  const b = box.get(by)!;
  const hostBottom = bounds(hostTree.map((id) => box.get(id)!)).bottom;
  return { dx: centre(d) - centre(b), dTop: d.y - hostBottom, rel: { x: d.x - b.x, y: d.y - b.y } };
}

describe('treeLayout — one-card trees dock under their referencer (STUDIO-4)', () => {
  test('a docked card sits x-centred under its referencer, a row spacing below its block, at every canvas aspect', () => {
    const offsets = Object.values(CANVAS_ASPECTS).map((aspect) => {
      const { box } = layAt(SHAPE, aspect);
      const o = dockOffset(box, 'atlas', 'chart', ['catalog', 'book', 'chart']);
      expect(o.dx).toBe(0);
      expect(o.dTop).toBe(96);
      return o.rel;
    });
    for (const rel of offsets) expect(rel).toEqual(offsets[0]!);
  });

  test('a 4-card tree with three children: each one-card tree docks under its own referencer, at every aspect', () => {
    const rels = Object.values(CANVAS_ASPECTS).map((aspect) => {
      const { box, edges } = layAt(PORT, aspect);
      expect(edges.filter((e) => e.treeRole === 'secondary').map((e) => [e.child, e.parent])).toEqual([
        ['dock', 'bay'],
        ['lane', 'pier'],
      ]);
      const bay = dockOffset(box, 'bay', 'dock', STATION_TREE);
      const pier = dockOffset(box, 'pier', 'lane', STATION_TREE);
      expect([bay.dx, bay.dTop, pier.dx, pier.dTop]).toEqual([0, 96, 0, 96]);
      return [bay.rel, pier.rel];
    });
    for (const rel of rels) expect(rel).toEqual(rels[0]!);
  });

  test('a docked card makes its block bigger for packing, and moves no other card in it', () => {
    const bare = graphOf(['dock', 'gate', 'lane', 'station'], [
      ...fk('dock', 'station'),
      ...fk('gate', 'station'),
      ...fk('lane', 'station'),
    ]);
    const without = Object.fromEntries(layAt(bare, 16 / 10).laid.nodes.map((n) => [n.id, n.position]));
    const { laid } = layAt(PORT, 16 / 10);
    const withDocks = Object.fromEntries(laid.nodes.map((n) => [n.id, n.position]));
    expect(Object.fromEntries(STATION_TREE.map((id) => [id, withDocks[id]]))).toEqual(without);
    // One block: nothing wraps beside or below the station tree.
    expect(withDocks.bay).toEqual({ x: withDocks.dock!.x, y: 328 });
    expect(withDocks.pier).toEqual({ x: withDocks.lane!.x, y: 328 });
  });

  test('referenced from several blocks, it docks under the first secondary line in declaration order', () => {
    const names = ['alpha', 'ant', 'beta', 'bee', 'cell'];
    const spines = [...fk('ant', 'alpha'), ...fk('bee', 'beta')];
    const beeFirst = layAt(graphOf(names, [...spines, ...fk('bee', 'cell'), ...fk('ant', 'cell')]), 16 / 10).box;
    const antFirst = layAt(graphOf(names, [...spines, ...fk('ant', 'cell'), ...fk('bee', 'cell')]), 16 / 10).box;
    expect(dockOffset(beeFirst, 'cell', 'bee', ['beta', 'bee'])).toMatchObject({ dx: 0, dTop: 96 });
    expect(dockOffset(antFirst, 'cell', 'ant', ['alpha', 'ant'])).toMatchObject({ dx: 0, dTop: 96 });
  });

  test('two docked cards whose spots would overlap are pushed apart by the sibling gap, in referencer order', () => {
    // Two one-card trees, `flag` and `sail`, both referenced by `rod`, the one
    // child of `pole`: both would centre on rod, so they are pushed apart.
    const graph = graphOf(['flag', 'pole', 'rod', 'sail'], [...fk('rod', 'pole'), ...fk('rod', 'flag'), ...fk('rod', 'sail')]);
    const { box } = layAt(graph, 16 / 10);
    const flag = box.get('flag')!;
    const sail = box.get('sail')!;
    const rod = box.get('rod')!;
    expect(flag.y).toBe(sail.y);
    // One referencer: declaration order keeps flag left of sail. The gap is
    // exactly the sibling gap, the pair centred under rod — and flag, pushed
    // left of the block's edge, shifts the whole block right to x = 0.
    expect(flag.x).toBeLessThan(sail.x);
    expect(sail.x - (flag.x + flag.width)).toBe(46);
    expect((centre(flag) + centre(sail)) / 2).toBe(centre(rod));
    expect(Math.min(flag.x, rod.x)).toBe(0);
  });

  test('a one-card tree referenced only by another one-card tree is not docked (no chains)', () => {
    // `kite` has_many `wing` with no belongs_to back: an unpaired inverse, a
    // secondary line with kite as its parent end and wing — itself a one-card
    // tree — as its child.
    const hasMany: Edge = {
      from: 'kite',
      to: 'wing',
      relationship: { name: 'wings', type: 'has_many', target: 'wing', foreignKey: 'kite_id', resolved: true },
      cardinality: '1:N',
      bidirectional: false,
    };
    const graph = graphOf(['kite', 'wing'], [hasMany]);
    const { box, edges } = layAt(graph, 16 / 10);
    expect(edges.map((e) => [e.treeRole, e.parent, e.child])).toEqual([['secondary', 'kite', 'wing']]);
    const bare = layAt(graphOf(['kite', 'wing'], []), 16 / 10).box;
    expect(box).toEqual(bare);
  });

  test('a one-card tree with no lines onto it still wraps as before', () => {
    const { box } = layAt(TWO_PARENT, 16 / 10);
    // tag: the third block, wrapped to the second row of blocks (232 + 192).
    expect({ x: box.get('tag')!.x, y: box.get('tag')!.y }).toEqual({ x: 0, y: 424 });
  });
});
