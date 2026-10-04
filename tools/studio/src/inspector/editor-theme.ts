/**
 * CodeMirror theme and highlight style, matched to `index.css` tokens.
 *
 * Written out rather than pulled from `@codemirror/theme-one-dark` so the
 * editor sits in the same surface scale as every other pane; a second palette
 * inside one window is exactly the "looks assembled" failure.
 *
 * One theme serves both palettes. The chrome reads Studio's tokens, and the
 * syntax colours are a table with both themes' value per tag, rendered as
 * `light-dark()` — so CSS's `color-scheme` switch repaints the editor without
 * it being rebuilt. The one thing CSS cannot reach is CodeMirror's own
 * `darkTheme` flag (it picks the base styles for panels such as search), which
 * `editorDarkFlag` sets from the resolved theme.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Tag } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import { cssColor } from '../theme/theme';
import type { ResolvedTheme, ThemedColor } from '../theme/theme';

const theme = EditorView.theme({
  '&': {
    color: 'var(--t-primary)',
    backgroundColor: 'var(--s-canvas)',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '8px 0',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--s-canvas)',
    color: 'var(--t-faint)',
    border: 'none',
    borderRight: '1px solid var(--s-line)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--t-secondary)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--s-raised)',
    border: 'none',
    color: 'var(--t-secondary)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--s-panel)',
    border: '1px solid var(--s-line-strong)',
    borderRadius: '6px',
    color: 'var(--t-primary)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
  },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--s-line-strong)' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--s-panel)' },
  '.cm-diagnostic': { padding: '4px 8px', borderLeft: 'none' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
  '.cm-scroller': { overflow: 'auto' },
});

/**
 * Syntax colours, both themes per tag. Dark keeps the 300-step pastels that
 * read on near-black; light takes the 700 steps of the same hues, each at or
 * above 4.5:1 on the light editor background.
 */
const SYNTAX: { tag: Tag | Tag[]; color: ThemedColor; italic?: true }[] = [
  // YAML keys.
  { tag: [tags.definition(tags.propertyName), tags.propertyName], color: { light: '#0369a1', dark: '#7dd3fc' } },
  { tag: [tags.atom, tags.bool, tags.null], color: { light: '#7e22ce', dark: '#c084fc' } },
  { tag: tags.number, color: { light: '#b45309', dark: '#fbbf24' } },
  { tag: tags.string, color: { light: '#15803d', dark: '#86efac' } },
  { tag: tags.comment, color: { light: '#5f6c7f', dark: '#718096' }, italic: true },
  { tag: tags.keyword, color: { light: '#1d4ed8', dark: '#60a5fa' } },
  { tag: tags.meta, color: { light: '#475569', dark: '#94a3b8' } },
  { tag: tags.invalid, color: { light: '#b91c1c', dark: '#f87171' } },
];

const highlight = HighlightStyle.define(
  SYNTAX.map(({ tag, color, italic }) => ({
    tag,
    color: cssColor(color),
    ...(italic ? { fontStyle: 'italic' } : {}),
  })),
);

export const studioEditorTheme: Extension = [theme, syntaxHighlighting(highlight)];

/** CodeMirror's own light/dark switch, for its base styles. Reconfigured on theme change. */
export function editorDarkFlag(resolved: ResolvedTheme): Extension {
  return EditorView.darkTheme.of(resolved === 'dark');
}
