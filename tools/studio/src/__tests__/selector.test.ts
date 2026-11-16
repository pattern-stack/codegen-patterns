/**
 * The canvas filter's dbt-style selectors (STUDIO-5, `../graph/selector.ts`):
 * the grammar, direction, depth, union, the junction and inherits hops, a role,
 * and an unknown name — on edges built by the real adapter, so the parent /
 * child ends under test are the ones the canvas draws.
 *
 * The model (every arrow is "depends on"):
 *
 *   library ← shelf ← book ← page ← note
 *                      ↑ ↑
 *          ebook ──────┘ └────── review ──(role: critic)──→ reader
 *        (inherits)          (belongs_to)
 *
 *   book ⟷ book_tag ⟷ tag     (a first-class relationship: a junction node)
 */
import { describe, expect, test } from 'bun:test';
import type { SerializedDomainGraph } from '@studio-shared';

import { adaptDomainGraph } from '../adapters/schema-adapter';
import { UNLIMITED, applySelector, focusSelector, parseSelector, parseToken } from '../graph/selector';

type Entity = SerializedDomainGraph['entities'][string];
type Edge = SerializedDomainGraph['edges'][number];
type RelDef = SerializedDomainGraph['relationshipDefinitions'][string];

function entity(name: string, over: Partial<Entity> = {}): Entity {
  return {
    name,
    plural: `${name}s`,
    table: `${name}s`,
    fields: { id: { name: 'id', type: 'uuid', required: true, nullable: false, unique: false, index: false } },
    relationships: {},
    behaviors: [],
    sourcePath: `entities/${name}.yaml`,
    ...over,
  };
}

/** `child` belongs_to `parent`, with the inverse has_many declared too. */
function fk(child: string, parent: string, role?: string): Edge[] {
  const column = `${role ?? parent}_id`;
  return [
    {
      from: child,
      to: parent,
      relationship: {
        name: role ? `${role}_${parent}` : parent,
        type: 'belongs_to',
        target: parent,
        foreignKey: column,
        resolved: true,
        ...(role ? { role } : {}),
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

function relDef(name: string, from: string, to: string): RelDef {
  return {
    name,
    table: name,
    from,
    to,
    selfReferential: false,
    fromColumn: `${from}_id`,
    toColumn: `${to}_id`,
    types: [],
    hasTypes: false,
    temporal: false,
    sourced: false,
    onDeleteFrom: 'cascade',
    onDeleteTo: 'cascade',
    uniqueOn: [],
    fields: {},
    sourcePath: `relationships/${name}.yaml`,
  };
}

const NAMES = ['library', 'shelf', 'book', 'page', 'note', 'review', 'reader', 'tag'];
const GRAPH: SerializedDomainGraph = {
  entities: {
    ...Object.fromEntries(NAMES.map((n) => [n, entity(n)])),
    ebook: entity('ebook', { inherits: { base: 'book', as: 'ebook', relationId: 'ebook.inherits' } }),
  },
  relationshipDefinitions: { book_tag: relDef('book_tag', 'book', 'tag') },
  edges: [
    ...fk('shelf', 'library'),
    ...fk('book', 'shelf'),
    ...fk('page', 'book'),
    ...fk('note', 'page'),
    ...fk('review', 'book'),
    ...fk('review', 'reader', 'critic'),
  ],
};
const { nodes, edges } = adaptDomainGraph(GRAPH);

/** The ids a selector shows, sorted; `null` when nothing is filtered. */
function shown(input: string): string[] | null {
  const { ids } = applySelector(input, nodes, edges);
  return ids == null ? null : [...ids].sort();
}

describe('parseToken — the grammar', () => {
  test.each([
    ['book+', { name: 'book', up: 0, down: UNLIMITED }],
    ['+book', { name: 'book', up: UNLIMITED, down: 0 }],
    ['+book+', { name: 'book', up: UNLIMITED, down: UNLIMITED }],
    ['2+book', { name: 'book', up: 2, down: 0 }],
    ['book+3', { name: 'book', up: 0, down: 3 }],
    ['2+book+3', { name: 'book', up: 2, down: 3 }],
    ['+book+1', { name: 'book', up: UNLIMITED, down: 1 }],
    ['12+book_tag', { name: 'book_tag', up: 12, down: 0 }],
  ])('%s', (raw, want) => {
    expect(parseToken(raw)).toEqual({ kind: 'select', raw, ...want });
  });

  test('a token without + is the text filter', () => {
    expect(parseToken('book')).toEqual({ kind: 'text', raw: 'book' });
    expect(parseToken('2book')).toEqual({ kind: 'text', raw: '2book' });
  });

  test.each(['+', '++book', 'book++', 'book+x', '+book+x', '1+2+book', '+book+book+'])(
    'malformed: %s',
    (raw) => {
      expect(parseToken(raw)).toMatchObject({ kind: 'malformed', raw });
    },
  );

  test('a depth of 0 is malformed, not "no hops"', () => {
    expect(parseToken('0+book')).toMatchObject({ kind: 'malformed', reason: expect.stringContaining('depth of 0') });
    expect(parseToken('book+0')).toMatchObject({ kind: 'malformed' });
  });

  test('tokens are split on any whitespace; an empty box is no tokens', () => {
    expect(parseSelector('  book+  \t +page ')).toHaveLength(2);
    expect(parseSelector('   ')).toEqual([]);
  });

  test('a comma separates tokens like whitespace; it is never part of a token', () => {
    const spaced = parseSelector('book+ +page');
    expect(parseSelector('book+, +page')).toEqual(spaced);
    expect(parseSelector('book+,+page')).toEqual(spaced);
    expect(parseSelector(' ,book+ ,, +page, ')).toEqual(spaced);
  });

  test('a comma alone is no tokens: never a text token, so it matches no text', () => {
    expect(parseSelector(',')).toEqual([]);
    expect(parseSelector(' , ,')).toEqual([]);
  });

  test('a malformed token shows a message and selects nothing — it is not read as text', () => {
    const result = applySelector('++book', nodes, edges);
    expect([...result.ids!]).toEqual([]);
    expect(result.messages).toEqual([
      { token: '++book', text: '++book is not a selector — write name+, +name, 2+name+3' },
    ]);
  });
});

describe('applySelector — direction', () => {
  test('name+ is the entity and what depends on it (its children)', () => {
    expect(shown('page+')).toEqual(['note', 'page']);
  });

  test('+name is the entity and what it depends on (its parents)', () => {
    expect(shown('+shelf')).toEqual(['library', 'shelf']);
    // book's many-to-many partner is a hop from book, either way (the junction rule below).
    expect(shown('+page')).toEqual(['book', 'book_tag', 'library', 'page', 'shelf', 'tag']);
    expect(shown('2+page')).toEqual(['book', 'book_tag', 'page', 'shelf', 'tag']);
  });

  test('+name+ is both sides, never a walk up and then down', () => {
    // book is reached going up; its other children (ebook, review) are not.
    expect(shown('3+note+')).toEqual(['book', 'book_tag', 'note', 'page', 'shelf', 'tag']);
  });

  test('a role follows its foreign key: the entity declaring the role depends on the actor', () => {
    expect(shown('1+review')).toEqual(['book', 'reader', 'review']);
    expect(shown('reader+')).toEqual(['reader', 'review']);
  });

  test('a selector names its entity by id or by label, ignoring case', () => {
    expect(shown('Page+')).toEqual(['note', 'page']);
  });
});

describe('applySelector — depth', () => {
  test('a number limits the hops; a bare + is unlimited', () => {
    expect(shown('1+note')).toEqual(['note', 'page']);
    expect(shown('2+note')).toEqual(['book', 'note', 'page']);
    expect(shown('3+note')).toEqual(['book', 'book_tag', 'note', 'page', 'shelf', 'tag']);
    expect(shown('+note')).toEqual(['book', 'book_tag', 'library', 'note', 'page', 'shelf', 'tag']);
    expect(shown('library+2')).toEqual(['book', 'library', 'shelf']);
  });

  test('each side has its own depth', () => {
    expect(shown('1+page+1')).toEqual(['book', 'note', 'page']);
  });
});

describe('applySelector — union', () => {
  test('space-separated tokens are a union', () => {
    expect(shown('page+ 1+shelf')).toEqual(['library', 'note', 'page', 'shelf']);
  });

  test('a text token keeps the text filter, and its matches join the union', () => {
    expect(shown('shel')).toEqual(['shelf']);
    expect(shown('page+ read')).toEqual(['note', 'page', 'reader']);
  });

  test('a comma is a union too: a+, b+ shows what a+ b+ shows', () => {
    expect(shown('page+, 1+shelf')).toEqual(shown('page+ 1+shelf'));
    expect(shown('page+, 1+shelf')).toEqual(['library', 'note', 'page', 'shelf']);
    expect(shown('page+,read')).toEqual(['note', 'page', 'reader']);
  });

  test('a comma alone selects nothing and matches no text: the box reads as empty, with no message', () => {
    expect(applySelector(',', nodes, edges)).toEqual({ ids: null, messages: [] });
    expect(applySelector(' , ', nodes, edges)).toEqual(applySelector('', nodes, edges));
  });

  test('an empty box filters nothing', () => {
    expect(shown('')).toBeNull();
  });
});

describe('applySelector — the junction hop', () => {
  test('crossing a junction node is one hop between its ends, and the junction is shown', () => {
    expect(shown('tag+1')).toEqual(['book', 'book_tag', 'tag']);
    expect(shown('1+tag')).toEqual(['book', 'book_tag', 'tag']);
  });

  test('the walk goes on from the far end, a hop further', () => {
    expect(shown('tag+2')).toEqual(['book', 'book_tag', 'ebook', 'page', 'review', 'tag']);
  });

  test('a junction named in a selector walks its own lines: +link is it and both ends', () => {
    expect(shown('1+book_tag')).toEqual(['book', 'book_tag', 'tag']);
    expect(shown('book_tag+')).toEqual(['book_tag']);
  });
});

describe('applySelector — the inherits hop', () => {
  test('a child depends on its base', () => {
    expect(shown('1+ebook')).toEqual(['book', 'ebook']);
    expect(shown('ebook+')).toEqual(['ebook']);
  });

  test('a base reaches its children one hop down', () => {
    expect(shown('book+1')).toEqual(['book', 'book_tag', 'ebook', 'page', 'review', 'tag']);
  });
});

describe('applySelector — an unknown name', () => {
  test('selects nothing and says so', () => {
    const result = applySelector('ghost+', nodes, edges);
    expect([...result.ids!]).toEqual([]);
    expect(result.messages).toEqual([{ token: 'ghost+', text: 'No entity named ghost' }]);
  });

  test('the other tokens still apply', () => {
    const result = applySelector('ghost+ page+', nodes, edges);
    expect([...result.ids!].sort()).toEqual(['note', 'page']);
    expect(result.messages).toHaveLength(1);
  });
});

describe('focusSelector — what a double-click sets', () => {
  test('one hop each way', () => {
    expect(focusSelector('book')).toBe('1+book+1');
    expect(shown(focusSelector('book'))).toEqual(['book', 'book_tag', 'ebook', 'page', 'review', 'shelf', 'tag']);
  });
});
