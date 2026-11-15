/**
 * The spine rule (STUDIO-3): first match wins — inherits, cascade,
 * first declared — and within a tier the first declared wins.
 */
import { describe, expect, test } from 'bun:test';

import { NO_SIGNALS, chooseSpines, secondaryReason, spineReason } from '../graph/spine';
import type { SpineCandidate, SpineSignals } from '../graph/spine';

function cand(child: string, parent: string, order: number, signals: Partial<SpineSignals> = {}): SpineCandidate {
  return { edgeId: `${child}->${parent}`, child, parent, order, signals: { ...NO_SIGNALS, ...signals } };
}

const spineOf = (candidates: SpineCandidate[], child: string) => chooseSpines(candidates).get(child);

describe('chooseSpines — each tier beats the ones below it', () => {
  test('tier 1: an explicit `inherits` beats a cascade and an earlier declaration', () => {
    const s = spineOf(
      [cand('c', 'unique', 0, { cascade: true }), cand('c', 'base', 1, { inherits: true })],
      'c',
    );
    expect([s?.parent, s?.tier, s?.reason]).toEqual(['base', 'inherits', 'spine: inherits']);
  });

  test('tier 2: a cascade beats an earlier plain declaration', () => {
    const s = spineOf([cand('c', 'plain', 0), cand('c', 'cascades', 1, { cascade: true })], 'c');
    expect([s?.parent, s?.tier, s?.reason]).toEqual(['cascades', 'cascade', 'spine: on_delete: cascade']);
  });

  test('tier 3: with no signal, the first declared', () => {
    const s = spineOf([cand('c', 'second', 1), cand('c', 'first', 0)], 'c');
    expect([s?.parent, s?.tier, s?.reason]).toEqual(['first', 'first-declared', 'spine: first declared']);
  });
});

describe('chooseSpines — ties within a tier go to the first declared', () => {
  test('two cascades', () => {
    expect(spineOf([cand('c', 'b', 1, { cascade: true }), cand('c', 'a', 0, { cascade: true })], 'c')?.parent).toBe('a');
  });

  test('two inherits', () => {
    expect(spineOf([cand('c', 'b', 1, { inherits: true }), cand('c', 'a', 0, { inherits: true })], 'c')?.parent).toBe('a');
  });
});

describe('chooseSpines — the result is a forest', () => {
  test('a self-reference is never a spine', () => {
    expect(spineOf([cand('c', 'c', 0, { cascade: true })], 'c')).toBeUndefined();
    expect(spineOf([cand('c', 'c', 0, { cascade: true }), cand('c', 'p', 1)], 'c')?.parent).toBe('p');
  });

  test('a cycle of spines is broken at its weakest choice, whatever order the candidates arrive in', () => {
    const forward = [cand('a', 'b', 0, { cascade: true }), cand('b', 'a', 0)];
    for (const candidates of [forward, [...forward].reverse()]) {
      const spines = chooseSpines(candidates);
      expect(spines.get('a')?.parent).toBe('b');
      expect(spines.has('b')).toBe(false);
    }
  });

  test('a node with no candidate has no spine', () => {
    expect(chooseSpines([cand('c', 'p', 0)]).has('p')).toBe(false);
  });
});

describe('the words on the line', () => {
  test('a spine names its tier; a secondary names the spine it is not', () => {
    expect(spineReason('cascade')).toBe('spine: on_delete: cascade');
    const spine = spineOf([cand('c', 'one', 0, { cascade: true })], 'c');
    expect(secondaryReason('c', spine)).toBe("secondary: c's spine is one (on_delete: cascade)");
    expect(secondaryReason('c', undefined)).toBe('secondary: c has no spine');
  });
});
