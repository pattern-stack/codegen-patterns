/**
 * CodeMirror dark theme and highlight style, matched to `index.css` tokens.
 *
 * Written out rather than pulled from `@codemirror/theme-one-dark` so the
 * editor sits in the same surface scale as every other pane; a second palette
 * inside one window is exactly the "looks assembled" failure.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const theme = EditorView.theme(
  {
    '&': {
      color: '#e2e8f0',
      backgroundColor: '#0b1120',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#60a5fa',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#60a5fa' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#1e3a5f',
    },
    '.cm-gutters': {
      backgroundColor: '#0b1120',
      color: '#475569',
      border: 'none',
      borderRight: '1px solid #243352',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(96, 165, 250, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#94a3b8' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(96, 165, 250, 0.14)' },
    '.cm-foldPlaceholder': {
      backgroundColor: '#1b263c',
      border: 'none',
      color: '#94a3b8',
    },
    '.cm-tooltip': {
      backgroundColor: '#131c2e',
      border: '1px solid #33456b',
      borderRadius: '6px',
      color: '#e2e8f0',
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
    },
    '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: '#33456b' },
    '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: '#131c2e' },
    '.cm-diagnostic': { padding: '4px 8px', borderLeft: 'none' },
    '.cm-diagnostic-error': { borderLeft: '3px solid #f87171' },
    '.cm-scroller': { overflow: 'auto' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  // YAML keys.
  { tag: tags.definition(tags.propertyName), color: '#7dd3fc' },
  { tag: tags.propertyName, color: '#7dd3fc' },
  { tag: tags.atom, color: '#c084fc' },
  { tag: tags.bool, color: '#c084fc' },
  { tag: tags.number, color: '#fbbf24' },
  { tag: tags.string, color: '#86efac' },
  { tag: tags.comment, color: '#64748b', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#60a5fa' },
  { tag: tags.null, color: '#c084fc' },
  { tag: tags.meta, color: '#94a3b8' },
  { tag: tags.invalid, color: '#f87171' },
]);

export const studioEditorTheme: Extension = [theme, syntaxHighlighting(highlight)];
