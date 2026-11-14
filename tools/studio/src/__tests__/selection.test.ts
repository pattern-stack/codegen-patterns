/**
 * Edge selection on the canvas (STUDIO-2 §5): an edge lights itself and its
 * two endpoints; clicking what is selected clears it.
 */
import { describe, expect, test } from 'bun:test';

import { edgeHighlight, toggleSelection } from '../graph/selection';

const EDGES = [
  { id: 'belongs_to-contact-account-account', source: 'contact', target: 'account' },
  { id: 'has_many-account-contacts-contact', source: 'account', target: 'contact' },
  { id: 'belongs_to-opportunity-account-account', source: 'opportunity', target: 'account' },
];

describe('edgeHighlight', () => {
  test('lights the edge and its two endpoints only', () => {
    const lit = edgeHighlight('belongs_to-contact-account-account', EDGES);
    expect([...lit.nodeIds].sort()).toEqual(['account', 'contact']);
    expect([...lit.edgeIds]).toEqual(['belongs_to-contact-account-account']);
  });

  test('the reverse edge between the same two nodes stays dimmed', () => {
    expect(edgeHighlight('belongs_to-contact-account-account', EDGES).edgeIds.has('has_many-account-contacts-contact')).toBe(
      false,
    );
  });

  test('an edge that is not on the canvas lights nothing', () => {
    const lit = edgeHighlight('gone', EDGES);
    expect(lit.nodeIds.size + lit.edgeIds.size).toBe(0);
  });
});

describe('toggleSelection', () => {
  test('a second click on the same edge clears it', () => {
    const edge = { kind: 'edge' as const, id: 'x' };
    expect(toggleSelection(edge, { kind: 'edge', id: 'x' })).toBeNull();
  });

  test('a node and an edge with the same id are different selections', () => {
    expect(toggleSelection({ kind: 'node', id: 'x' }, { kind: 'edge', id: 'x' })).toEqual({ kind: 'edge', id: 'x' });
  });

  test('from nothing, a click selects', () => {
    expect(toggleSelection(null, { kind: 'node', id: 'contact' })).toEqual({ kind: 'node', id: 'contact' });
  });
});
