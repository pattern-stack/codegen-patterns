/**
 * The spine-order toggle (STUDIO-6): the two orders `chooseSpines` ranks by,
 * what each does to a shared base whose children have owners, the remembered
 * choice, and the floating-inheritance prototype's pure half.
 *
 * The family is `fixtures/spine-order/entities/` — a base `part` (discriminator
 * `kind`), `audio_part` (inherits `part`, owned by `recording` with cascade) and
 * `text_part` (inherits `part`, owned by `message` with cascade) — as the real
 * `codegen project graph --json` reports it (`fixtures/spine-order-graph.json`).
 */
import { describe, expect, test } from 'bun:test';
import type { SerializedDomainGraph } from '@studio-shared';

import { adaptDomainGraph } from '../adapters/schema-adapter';
import type { StudioEdgeData } from '../graph/edge-kinds';
import { floatedBases, hidesFloatedLine } from '../graph/FloatingBase';
import { NO_SIGNALS, SPINE_ORDERS, chooseSpines } from '../graph/spine';
import type { SpineCandidate, SpineOrder, SpineSignals } from '../graph/spine';
import { spineParents } from '../layout/tree-layout';
import {
  SPINE_ORDER_OPTIONS,
  SPINE_ORDER_STORAGE_KEY,
  loadSpineOrder,
  storeSpineOrder,
} from '../spine-order';
import spineOrderGraph from './fixtures/spine-order-graph.json';

const graph = spineOrderGraph.graph as unknown as SerializedDomainGraph;

function cand(child: string, parent: string, order: number, signals: Partial<SpineSignals> = {}): SpineCandidate {
  return { edgeId: `${child}->${parent}`, child, parent, order, signals: { ...NO_SIGNALS, ...signals } };
}

function edgesUnder(order: SpineOrder): StudioEdgeData[] {
  return adaptDomainGraph(graph, order).edges;
}

/** `[child, parent, treeRole, treeReason]` for every line, sorted — the whole tree in one value. */
function tree(order: SpineOrder): [string, string, string, string][] {
  return edgesUnder(order)
    .map((e): [string, string, string, string] => [e.child, e.parent, e.treeRole, e.treeReason])
    .sort((a, b) => (a.join() < b.join() ? -1 : 1));
}

describe('the two orders', () => {
  test('they rank the same three tiers, and differ only in the first two', () => {
    expect(SPINE_ORDERS['inheritance-first']).toEqual(['inherits', 'cascade', 'first-declared']);
    expect(SPINE_ORDERS['ownership-first']).toEqual(['cascade', 'inherits', 'first-declared']);
  });

  test('inheritance first (the default): an `inherits` beats a cascade', () => {
    const candidates = [cand('c', 'owner', 0, { cascade: true }), cand('c', 'base', 1, { inherits: true })];
    for (const spines of [chooseSpines(candidates), chooseSpines(candidates, 'inheritance-first')]) {
      expect([spines.get('c')?.parent, spines.get('c')?.reason]).toEqual(['base', 'spine: inherits']);
    }
  });

  test('ownership first: a cascade beats an `inherits`, and an `inherits` still beats a plain declaration', () => {
    const owned = chooseSpines(
      [cand('c', 'base', 0, { inherits: true }), cand('c', 'owner', 1, { cascade: true })],
      'ownership-first',
    ).get('c');
    expect([owned?.parent, owned?.tier, owned?.reason]).toEqual(['owner', 'cascade', 'spine: on_delete: cascade']);

    const unowned = chooseSpines(
      [cand('c', 'plain', 0), cand('c', 'base', 1, { inherits: true })],
      'ownership-first',
    ).get('c');
    expect([unowned?.parent, unowned?.reason]).toEqual(['base', 'spine: inherits']);
  });
});

describe('a shared base whose children have owners (the fixture family)', () => {
  test('inheritance first: both children hang under `part`; each owner is a secondary line', () => {
    expect(tree('inheritance-first')).toEqual([
      ['audio_part', 'part', 'spine', 'spine: inherits'],
      ['audio_part', 'recording', 'secondary', "secondary: audio_part's spine is part (inherits)"],
      ['text_part', 'message', 'secondary', "secondary: text_part's spine is part (inherits)"],
      ['text_part', 'part', 'spine', 'spine: inherits'],
    ]);
  });

  test('ownership first: each child hangs under its owner; the `inherits` lines are secondary', () => {
    expect(tree('ownership-first')).toEqual([
      ['audio_part', 'part', 'secondary', "secondary: audio_part's spine is recording (on_delete: cascade)"],
      ['audio_part', 'recording', 'spine', 'spine: on_delete: cascade'],
      ['text_part', 'message', 'spine', 'spine: on_delete: cascade'],
      ['text_part', 'part', 'secondary', "secondary: text_part's spine is message (on_delete: cascade)"],
    ]);
  });

  test('the layout reads the order: under ownership first each child sits under its owner', () => {
    const present = new Set(Object.keys(graph.entities));
    expect([...spineParents(present, edgesUnder('inheritance-first'))].sort()).toEqual([
      ['audio_part', 'part'],
      ['text_part', 'part'],
    ]);
    expect([...spineParents(present, edgesUnder('ownership-first'))].sort()).toEqual([
      ['audio_part', 'recording'],
      ['text_part', 'message'],
    ]);
  });
});

describe('the remembered order', () => {
  function memory(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial));
    return {
      items,
      storage: () => ({
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
      }),
    };
  }

  test('falls back to inheritance first when storage is absent, throws, is empty or holds garbage', () => {
    const throwing = () => {
      throw new Error('blocked');
    };
    const throwingGet = () => ({
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: () => {},
    });
    expect(loadSpineOrder(() => undefined)).toBe('inheritance-first');
    expect(loadSpineOrder(throwing)).toBe('inheritance-first');
    expect(loadSpineOrder(throwingGet)).toBe('inheritance-first');
    expect(loadSpineOrder(memory().storage)).toBe('inheritance-first');
    for (const garbage of ['', 'ownership', 'OWNERSHIP-FIRST', 'constructor', '{"order":"ownership-first"}']) {
      expect(loadSpineOrder(memory({ [SPINE_ORDER_STORAGE_KEY]: garbage }).storage)).toBe('inheritance-first');
    }
  });

  test('store round-trips each order, under its key', () => {
    for (const { id } of SPINE_ORDER_OPTIONS) {
      const { items, storage } = memory();
      storeSpineOrder(storage, id);
      expect(items.get('studio.spineOrder')).toBe(id);
      expect(loadSpineOrder(storage)).toBe(id);
    }
  });

  test('a store that throws is swallowed', () => {
    expect(() =>
      storeSpineOrder(
        () => ({
          getItem: () => null,
          setItem: () => {
            throw new Error('quota');
          },
        }),
        'ownership-first',
      ),
    ).not.toThrow();
  });
});

describe('the floating-inheritance prototype (pure half)', () => {
  const label = (id: string) => (id === 'part' ? 'Part' : id);

  test('ownership first: each child floats its base, one chip per child', () => {
    expect([...floatedBases(edgesUnder('ownership-first'), label)].sort()).toEqual([
      ['audio_part', { base: 'part', label: 'Part' }],
      ['text_part', { base: 'part', label: 'Part' }],
    ]);
  });

  test('inheritance first: the `inherits` lines are spines, so nothing floats', () => {
    expect(floatedBases(edgesUnder('inheritance-first'), label).size).toBe(0);
  });

  test('a floated line is hidden at rest and drawn while its child, its base or the line is selected', () => {
    const edges = edgesUnder('ownership-first');
    const floated = floatedBases(edges, label);
    const audioInherits = edges.find((e) => e.studioKind === 'inherits' && e.child === 'audio_part')!;
    const owner = edges.find((e) => e.studioKind === 'belongs_to' && e.child === 'audio_part')!;
    expect(hidesFloatedLine(audioInherits, floated, null, null)).toBe(true);
    expect(hidesFloatedLine(audioInherits, floated, 'text_part', null)).toBe(true);
    expect(hidesFloatedLine(audioInherits, floated, 'audio_part', null)).toBe(false);
    expect(hidesFloatedLine(audioInherits, floated, 'part', null)).toBe(false);
    expect(hidesFloatedLine(audioInherits, floated, null, audioInherits.id)).toBe(false);
    // Only a floated `inherits` line is ever hidden.
    expect(hidesFloatedLine(owner, floated, null, null)).toBe(false);
  });
});
