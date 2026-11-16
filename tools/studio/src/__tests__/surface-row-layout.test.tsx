/**
 * A long origin chip must not squeeze a row's signature (STUDIO-2 §4, row anatomy).
 *
 * The case: a child's `upsertByNaturalKey(input, tx) → one`, credited to its base's
 * `unique_indexes[0].natural_key` with a note that names both entities — a chip of
 * ~130 characters on a generic family (base `customer_interaction_record`, child
 * `scheduled_video_conference_session`). Before the fix the signature, sharing one
 * flex line with an unshrinkable chip, collapsed to one letter per line and the chip
 * ran past the inspector's right edge.
 *
 * jsdom-style rendering has no layout, so this pins the CSS that guarantees the
 * behaviour, on the real `Row` / `Chip` markup and the real `originChip` text:
 *
 * - the signature is `flex: 1 1 auto` with a non-zero `min-width`, and wraps only at
 *   word boundaries (`overflow-wrap: anywhere` is what let it shrink to one letter);
 * - the row wraps, so a chip that does not fit beside the signature drops under it;
 * - the chip is at most the row's width and truncates with an ellipsis, its full
 *   text in a `title` tooltip.
 *
 * The behaviour itself (one signature line, chip inside a 420 px inspector) was
 * measured in a real browser when this landed; no browser runs in CI.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Origin, ProjectApiSurface } from '@studio-shared';

import { Row } from '../inspector/surface-rows';
import { originChip, signature } from '../inspector/surface-view';
import type { SurfaceRow } from '../inspector/surface-view';

import family from './fixtures/family-surface.json';

const SURFACE = family.surface as ProjectApiSurface;

const BASE = 'customer_interaction_record';
const CHILD = 'scheduled_video_conference_session';

/** The origin the derivation gives a child's upsert through its base's natural key. */
const THROUGH_BASE: Origin = {
  from: 'yaml',
  at: {
    doc: { kind: 'entity', name: BASE },
    path: ['unique_indexes', 0, 'natural_key'],
    note: `${BASE}'s natural key, through ${CHILD}'s inherits`,
  },
};

const ROW: SurfaceRow = {
  key: 'upsertByNaturalKey',
  name: 'upsertByNaturalKey',
  signature: signature('upsertByNaturalKey', [{ name: 'input' }, { name: 'tx' }], 'one'),
  flags: [],
  origin: originChip(SURFACE, THROUGH_BASE),
  shadows: [],
};

/** Every element's inline style, keyed by the element's text when it has no children. */
function styleOf(html: string, text: string): Record<string, string> {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<(\\w+)([^>]*)>${escaped}</\\1>`).exec(html);
  if (!match) throw new Error(`no element whose whole text is ${JSON.stringify(text)}`);
  return parseStyle(match[2] ?? '');
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
}

function parseStyle(attrs: string): Record<string, string> & { __attrs: string } {
  const out: Record<string, string> = {};
  for (const decl of (attr(attrs, 'style') ?? '').split(';')) {
    const at = decl.indexOf(':');
    if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return Object.assign(out, { __attrs: attrs });
}

function unescape(s: string): string {
  return s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>');
}

function render(canReveal: boolean): string {
  return unescape(renderToStaticMarkup(<Row row={ROW} onReveal={() => {}} canReveal={() => canReveal} />));
}

describe('API tab row — a long origin chip', () => {
  test('the fixture is the long case: a ~120-character chip beside a short signature', () => {
    expect(ROW.signature).toBe('upsertByNaturalKey(input, tx) → one');
    expect(ROW.origin?.text.length).toBeGreaterThanOrEqual(120);
  });

  test('the signature keeps its width and wraps only between words', () => {
    const sig = styleOf(render(true), ROW.signature);
    expect(sig.flex).toBe('1 1 auto');
    expect(sig['min-width']).toBeDefined();
    expect(sig['min-width']).not.toBe('0');
    expect(sig['overflow-wrap']).not.toBe('anywhere');
    expect(sig['word-break']).toBeUndefined();
  });

  test('the row lets the chip drop under the signature', () => {
    const html = render(true);
    const lineOpen = /<div style="([^"]*)"><span[^>]*>upsertByNaturalKey/.exec(html);
    expect(lineOpen).not.toBeNull();
    expect(parseStyle(` style="${lineOpen?.[1] ?? ''}"`)['flex-wrap']).toBe('wrap');
  });

  for (const linked of [true, false]) {
    test(`the chip never outgrows the panel, and its full text is the tooltip (${linked ? 'a link' : 'plain'})`, () => {
      const text = ROW.origin?.text ?? '';
      const chip = styleOf(render(linked), text);
      expect(chip.__attrs.startsWith(linked ? ' type="button"' : '')).toBe(true);
      expect(chip['max-width']).toBe('100%');
      expect(chip.overflow).toBe('hidden');
      expect(chip['text-overflow']).toBe('ellipsis');
      expect(chip['white-space']).toBe('nowrap');
      // `text-overflow` needs a block container: an inline-flex chip never shows its ellipsis.
      expect(chip.display).toBe('inline-block');
      expect(unescape(attr(chip.__attrs, 'title') ?? '')).toContain(text);
    });
  }
});
