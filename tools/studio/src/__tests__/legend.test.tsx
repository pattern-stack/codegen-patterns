/**
 * The legend is generated from `edge-kinds`, so a kind added there shows up in it
 * with no second edit. This renders the real component and holds that: the
 * `inherits` row (RFC-0006, #875 S6) is in the expanded legend, with its own
 * description, and in the collapsed chip's swatches.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EDGE_KIND_ORDER, EDGE_KIND_STYLES, edgeColor } from '../graph/edge-kinds';
import { Legend } from '../graph/Legend';

describe('Legend', () => {
  test('the expanded legend has a row per edge kind, `inherits` among them', () => {
    const html = renderToStaticMarkup(<Legend roomy />);
    for (const kind of EDGE_KIND_ORDER) {
      expect(html).toContain(EDGE_KIND_STYLES[kind].label);
      // the description is HTML-escaped by React (`inherits:` carries backticks, not entities)
      expect(html).toContain(EDGE_KIND_STYLES[kind].description.replace(/`/g, '`'));
    }
    expect(EDGE_KIND_ORDER).toContain('inherits');
    expect(html).toContain('joined 1:1 to its base on id');
  });

  test('`inherits` is drawn in its own themed colour — a light-dark() pair, never a literal in the component', () => {
    const html = renderToStaticMarkup(<Legend roomy />);
    const colour = edgeColor(EDGE_KIND_STYLES.inherits);
    expect(colour).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    expect(html).toContain(colour);
    // distinct from every other kind's, so the swatch tells it apart
    for (const kind of EDGE_KIND_ORDER.filter((k) => k !== 'inherits')) {
      expect(edgeColor(EDGE_KIND_STYLES[kind])).not.toBe(colour);
    }
  });

  test('the collapsed chip still shows a swatch per kind', () => {
    const html = renderToStaticMarkup(<Legend roomy={false} />);
    expect(html).toContain(edgeColor(EDGE_KIND_STYLES.inherits));
    expect(html).not.toContain('joined 1:1 to its base on id'); // the descriptions are the expanded half
  });
});
