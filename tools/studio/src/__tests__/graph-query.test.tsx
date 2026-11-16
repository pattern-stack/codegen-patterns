/**
 * The text filter has one owner: `matchesGraphQuery` in the component library
 * (`packages/graph-components/src/hooks/useGraphFilter.ts`). The library's
 * `useGraphFilter` hook applies it, and so does a selector's text token
 * (`../graph/selector.ts`). These tests pin the predicate, and assert that the
 * hook and the selector both select exactly what it matches.
 */
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GraphNodeData } from '@pattern-stack/graph-components';

// The library is read from source (tsconfig `paths`), so its `react` import
// resolves to a second copy under the library's node_modules. Point it at this
// app's copy, as `graph-focus.test.tsx` does, so the hook has a dispatcher.
import * as React from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
const libraryDir = path.resolve(import.meta.dir, '../../../../packages/graph-components/src');
mock.module(createRequire(path.join(libraryDir, 'index.ts')).resolve('react'), () => React);

const { matchesGraphQuery, useGraphFilter } = await import('@pattern-stack/graph-components');
const { applySelector } = await import('../graph/selector');

const NODES: GraphNodeData[] = [
  { id: 'shelf', label: 'Shelf', kind: 'entity', subtitle: 'shelves', group: 'catalog', fields: [{ name: 'aisle' }] },
  { id: 'book', label: 'Book', kind: 'entity', subtitle: 'books', group: 'catalog', fields: [{ name: 'isbn' }] },
  { id: 'reader', label: 'Reader', kind: 'entity', subtitle: 'readers', group: 'people', fields: [{ name: 'card_no' }] },
  { id: 'book_tag', label: 'BookTag', kind: 'relationship', types: [{ name: 'primary' }] },
];

describe('matchesGraphQuery — the text filter', () => {
  test.each([
    ['the label', 'shel', true],
    ['the subtitle (the table)', 'readers', true],
    ['the group', 'catalog', true],
    ['a field name', 'isbn', true],
    ['a type name', 'prim', true],
  ])('matches %s', (_what, query, want) => {
    expect(NODES.some((n) => matchesGraphQuery(n, query))).toBe(want);
  });

  test('ignores case, either side', () => {
    expect(matchesGraphQuery(NODES[0]!, 'SHEL')).toBe(true);
    expect(matchesGraphQuery({ label: 'SHELF' }, 'shelf')).toBe(true);
  });

  test('a query that is in no searched part matches nothing', () => {
    expect(NODES.filter((n) => matchesGraphQuery(n, 'zzz'))).toEqual([]);
    // `id` and `kind` are not searched.
    expect(matchesGraphQuery(NODES[3]!, 'relationship')).toBe(false);
  });
});

/** What `useGraphFilter` shows for a query, rendered through React. */
function hookIds(query: string): string[] {
  let ids: string[] = [];
  function Probe() {
    ids = useGraphFilter(NODES, [], { query, filters: {} }).filteredNodes.map((n) => n.id);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return ids.sort();
}

const QUERIES = ['shel', 'readers', 'catalog', 'isbn', 'prim', 'Book', 'zzz'];

describe('one owner: the hook and the selector both apply matchesGraphQuery', () => {
  test.each(QUERIES)('useGraphFilter, query %p', (query) => {
    expect(hookIds(query)).toEqual(NODES.filter((n) => matchesGraphQuery(n, query)).map((n) => n.id).sort());
  });

  test.each(QUERIES)('a selector text token, query %p', (query) => {
    const { ids } = applySelector(query, NODES, []);
    expect([...ids!].sort()).toEqual(hookIds(query));
  });
});
