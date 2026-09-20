import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import type { Diagnostic } from '@codemirror/lint';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import type { ZodIssueLike } from '@studio-shared';

import { studioEditorTheme } from './editor-theme';
import { issueMessage, locateIssues } from './yaml-issues';
import type { LocatedIssue } from './yaml-issues';

export interface YamlEditorProps {
  value: string;
  onChange: (next: string) => void;
  issues: ZodIssueLike[];
  /** Save is wired to ⌘S / Ctrl-S as well as the toolbar button. */
  onSave: () => void;
  readOnly?: boolean;
}

/**
 * CodeMirror 6 over the selected YAML file, with the server's Zod issues
 * rendered on the lines they belong to.
 *
 * The 422 issues arrive as schema paths, not positions, so `yaml-issues` maps
 * each one onto a range in the current document. A path that does not exist —
 * a missing required key — resolves to its nearest ancestor and is phrased as
 * "expected here", which is where the author has to type.
 */
export function YamlEditor({ value, onChange, issues, onSave, readOnly = false }: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const editable = useRef(new Compartment());
  const [located, setLocated] = useState<LocatedIssue[]>([]);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Mounted once. Document and diagnostics are pushed in through transactions
  // below — tearing the editor down on every keystroke would lose the cursor.
  useEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        lintGutter(),
        history(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        yamlLanguage(),
        studioEditorTheme,
        EditorView.lineWrapping,
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        editable.current.of(EditorView.editable.of(!readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Replace the document only when the incoming value is genuinely different
  // from what the editor holds; echoing our own edits back would reset the
  // selection on every keystroke.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(instance.state.selection.main.anchor, value.length) },
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!readOnly)),
    });
  }, [readOnly]);

  // Diagnostics are recomputed against the *current* document, so an issue
  // keeps pointing at the right line while the author edits around it.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;

    const source = instance.state.doc.toString();
    const resolved = locateIssues(source, issues);
    setLocated(resolved);

    const diagnostics: Diagnostic[] = resolved.flatMap((item) =>
      item.location
        ? [
            {
              from: item.location.from,
              to: item.location.to,
              severity: 'error' as const,
              message: issueMessage(item),
            },
          ]
        : [],
    );

    instance.dispatch(setDiagnostics(instance.state, diagnostics));
  }, [issues, value]);

  const jumpTo = useCallback((item: LocatedIssue) => {
    const instance = view.current;
    if (!instance || !item.location) return;
    instance.dispatch({
      selection: { anchor: item.location.from, head: item.location.to },
      scrollIntoView: true,
    });
    instance.focus();
  }, []);

  const unlocated = useMemo(() => located.filter((i) => !i.location), [located]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />

      {issues.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            maxHeight: 160,
            overflowY: 'auto',
            borderTop: '1px solid var(--s-line)',
            background: 'var(--s-panel)',
          }}
        >
          <div
            style={{
              padding: '5px var(--sp-3)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: 'var(--danger)',
              borderBottom: '1px solid var(--s-line)',
            }}
          >
            {issues.length} validation {issues.length === 1 ? 'issue' : 'issues'}
            {unlocated.length > 0 && (
              <span style={{ color: 'var(--t-muted)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
                {' '}
                · {unlocated.length} could not be placed
              </span>
            )}
          </div>
          {located.map((item, i) => (
            <button
              key={`${item.issue.code}-${i}`}
              type="button"
              onClick={() => jumpTo(item)}
              disabled={!item.location}
              style={{
                display: 'flex',
                gap: 'var(--sp-2)',
                width: '100%',
                textAlign: 'left',
                padding: '4px var(--sp-3)',
                border: 'none',
                background: 'transparent',
                color: 'var(--t-secondary)',
                fontSize: 11.5,
                cursor: item.location ? 'pointer' : 'default',
              }}
            >
              <span
                style={{
                  flex: '0 0 42px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--danger)',
                  textAlign: 'right',
                }}
              >
                {item.location ? `${item.location.line}:${item.location.column}` : '—'}
              </span>
              <span style={{ flex: 1 }}>{issueMessage(item)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
