/**
 * Theme resolution: the attribute on `<html>` is the preference, absent means
 * "follow the system", and an explicit value wins in either direction. These
 * are the same rules `index.css` encodes with `color-scheme`, so script and
 * CSS cannot disagree about which palette is showing.
 */
import { describe, expect, test } from 'bun:test';
import {
  THEME_PREFERENCES,
  cssColor,
  parsePreference,
  resolveTheme,
  themeAttribute,
} from '../theme/theme';
import { EDGE_KIND_ORDER, EDGE_KIND_STYLES, EDGE_MARKERS, edgeColor } from '../graph/edge-kinds';

describe('parsePreference', () => {
  test('accepts exactly the three preferences', () => {
    for (const p of THEME_PREFERENCES) expect(parsePreference(p)).toBe(p);
  });

  test('anything else follows the system', () => {
    for (const raw of [null, undefined, '', 'Dark', 'auto', 'sepia', 1, {}]) {
      expect(parsePreference(raw)).toBe('system');
    }
  });
});

describe('resolveTheme', () => {
  test('system follows the media query', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  test('an explicit choice overrides the system both ways', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('themeAttribute', () => {
  test('system removes the attribute, so CSS falls back to color-scheme: light dark', () => {
    expect(themeAttribute('system')).toBeNull();
  });

  test('an explicit choice round-trips through the attribute', () => {
    for (const p of ['light', 'dark'] as const) {
      expect(parsePreference(themeAttribute(p))).toBe(p);
    }
  });
});

describe('themed colours', () => {
  test('render as one light-dark() value, light first', () => {
    expect(cssColor({ light: '#2563eb', dark: '#60a5fa' })).toBe('light-dark(#2563eb, #60a5fa)');
  });

  test('every edge kind has a distinct colour per theme, and markers carry the themed value', () => {
    for (const kind of EDGE_KIND_ORDER) {
      const { color } = EDGE_KIND_STYLES[kind];
      expect(color.light).not.toBe(color.dark);
    }
    for (const marker of EDGE_MARKERS) {
      const owner = EDGE_KIND_ORDER.map((k) => EDGE_KIND_STYLES[k]).find((s) => s.marker === marker.id);
      expect(owner).toBeDefined();
      expect(marker.color).toBe(edgeColor(owner!));
    }
  });
});
