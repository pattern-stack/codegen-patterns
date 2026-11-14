import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNodeData } from '@pattern-stack/graph-components';
import { DetailPanel } from '@pattern-stack/graph-components';
import type { StudioFile, YamlRef, ZodIssueLike } from '@studio-shared';

import { api, ApiError, FileValidationError } from '../api/client';
import { YamlEditor } from './YamlEditor';
import { RelationshipForm } from './RelationshipForm';
import { ApiTab } from './ApiTab';
import type { SurfaceState } from './ApiTab';
import { formatIssuePath, locatePath } from './yaml-issues';
import {
  Button,
  CountBadge,
  Dot,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  Tabs,
} from '../ui/primitives';

export type InspectorTab = 'detail' | 'api' | 'yaml' | 'relate';

export interface InspectorProps {
  /** The graph node the canvas has selected, if any. */
  node: GraphNodeData | null;
  files: StudioFile[];
  entities: string[];
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  /** The derived API surface, fetched apart from the graph. */
  surface: SurfaceState;
  onRetrySurface: () => void;
  /** Raised when the YAML or a relationship was written — the graph reloads. */
  onProjectChanged: () => void;
  /** Reported upward so the window's beforeunload guard can see it. */
  onDirtyChange: (dirty: boolean) => void;
}

interface FileState {
  path: string;
  saved: string;
  draft: string;
  issues: ZodIssueLike[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  error?: { title: string; detail?: string };
  savedAt?: number;
}

/** The file that backs a graph node, matched on the node's own name. */
function fileForNode(files: StudioFile[], node: GraphNodeData | null): StudioFile | undefined {
  if (!node) return undefined;
  return files.find(
    (f) => (f.kind === 'entity' || f.kind === 'junction' || f.kind === 'relationship') && f.name === node.id,
  );
}

export function Inspector({
  node,
  files,
  entities,
  tab,
  onTabChange,
  surface,
  onRetrySurface,
  onProjectChanged,
  onDirtyChange,
}: InspectorProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileState | null>(null);
  /** A declaration to show once its file is open — set by an origin chip. */
  const [pendingReveal, setPendingReveal] = useState<{ path: string; yamlPath: YamlRef['path'] } | null>(null);
  const [reveal, setReveal] = useState<{ line: number; seq: number } | undefined>(undefined);
  const [revealNote, setRevealNote] = useState<string | null>(null);

  const dirty = file != null && file.draft !== file.saved;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const load = useCallback((path: string) => {
    setOpenPath(path);
    setFile({ path, saved: '', draft: '', issues: [], status: 'loading' });
    api
      .readFile(path)
      .then((res) =>
        setFile({ path, saved: res.content, draft: res.content, issues: [], status: 'ready' }),
      )
      .catch((err: unknown) =>
        setFile({
          path,
          saved: '',
          draft: '',
          issues: [],
          status: 'error',
          error: describe(err, 'Could not read this file'),
        }),
      );
  }, []);

  // Selecting a node opens its file, unless the open one has unsaved edits —
  // silently discarding them on a stray click is worse than staying put.
  // It follows the *selection*, not the open file: once an origin chip has
  // opened another file (a junction's), that file stays open until the
  // selection changes.
  const nodeFile = useMemo(() => fileForNode(files, node), [files, node]);
  const syncedNodePath = useRef<string | null>(null);
  useEffect(() => {
    if (!nodeFile || nodeFile.path === syncedNodePath.current) return;
    if (nodeFile.path === openPath) {
      syncedNodePath.current = nodeFile.path;
      return;
    }
    if (dirty) return;
    syncedNodePath.current = nodeFile.path;
    load(nodeFile.path);
  }, [nodeFile, openPath, dirty, load]);

  const fileForRef = useCallback(
    (ref: YamlRef) => files.find((f) => f.kind === ref.doc.kind && f.name === ref.doc.name),
    [files],
  );

  // An origin chip: open the YAML that declared it, then put the cursor on the
  // declaration. The line is located in the file as it is *now*, by the same
  // walker the validation markers use.
  const revealYaml = useCallback(
    (ref: YamlRef) => {
      const target = fileForRef(ref);
      if (!target) return;
      if (target.path !== openPath) {
        if (dirty && !window.confirm('Discard unsaved changes to this file?')) return;
        load(target.path);
      }
      setRevealNote(null);
      setPendingReveal({ path: target.path, yamlPath: ref.path });
      onTabChange('yaml');
    },
    [fileForRef, openPath, dirty, load, onTabChange],
  );

  useEffect(() => {
    if (!pendingReveal || !file || file.path !== pendingReveal.path || file.status !== 'ready') return;
    const location = locatePath(file.draft, pendingReveal.yamlPath);
    const where = formatIssuePath(pendingReveal.yamlPath);
    if (location) {
      setReveal((prev) => ({ line: location.line, seq: (prev?.seq ?? 0) + 1 }));
      setRevealNote(location.exact ? null : `${where} is no longer in this file — showing its nearest ancestor.`);
    } else {
      setRevealNote(`${where} is not in this file any more.`);
    }
    setPendingReveal(null);
  }, [pendingReveal, file]);

  const save = useCallback(() => {
    if (!file || file.status === 'saving') return;
    const { path, draft } = file;
    setFile((prev) => (prev ? { ...prev, status: 'saving', issues: [] } : prev));

    api
      .writeFile(path, draft)
      .then(() => {
        setFile((prev) =>
          prev && prev.path === path
            ? { ...prev, saved: draft, issues: [], status: 'ready', error: undefined, savedAt: Date.now() }
            : prev,
        );
        onProjectChanged();
      })
      .catch((err: unknown) => {
        setFile((prev) => {
          if (!prev || prev.path !== path) return prev;
          if (err instanceof FileValidationError) {
            // A 422 is not an error state: the editor stays editable and the
            // issues render on the lines they came from.
            return { ...prev, status: 'ready', issues: err.issues, error: undefined };
          }
          return { ...prev, status: 'ready', issues: [], error: describe(err, 'Could not save') };
        });
      });
  }, [file, onProjectChanged]);

  const revert = useCallback(() => {
    setFile((prev) => (prev ? { ...prev, draft: prev.saved, issues: [] } : prev));
  }, []);

  const editableFiles = useMemo(() => files.filter((f) => f.kind !== 'config'), [files]);

  const tabs = [
    { id: 'detail' as const, label: 'Detail', disabled: node == null },
    { id: 'api' as const, label: 'API', disabled: node == null },
    {
      id: 'yaml' as const,
      label: 'YAML',
      badge: (
        <>
          {dirty && <Dot color="var(--warn)" title="unsaved changes" />}
          {file != null && file.issues.length > 0 && (
            <CountBadge count={file.issues.length} tone="danger" />
          )}
        </>
      ),
    },
    { id: 'relate' as const, label: 'Relate' },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        borderLeft: '1px solid var(--s-line)',
        background: 'var(--s-panel)',
      }}
    >
      <Tabs tabs={tabs} active={tab} onSelect={onTabChange} />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'detail' &&
          (node ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              {/* The library panel is sized by its container here rather than
                  by its own `width` prop, so the inspector column owns the
                  width and the two cannot disagree. */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
                <DetailPanel node={node} onClose={() => onTabChange('relate')} width={undefined} />
              </div>
            </div>
          ) : (
            <EmptyState
              title="Nothing selected"
              body="Click an entity or junction in the graph to inspect it."
            />
          ))}

        {tab === 'api' && (
          <ApiTab
            nodeId={node?.id ?? null}
            surface={surface}
            onRetry={onRetrySurface}
            onReveal={revealYaml}
            canReveal={(ref) => fileForRef(ref) != null}
          />
        )}

        {tab === 'yaml' && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-2)',
                flex: '0 0 auto',
                height: 30,
                padding: '0 var(--sp-2)',
                borderBottom: '1px solid var(--s-line)',
                background: 'var(--s-chrome)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Select
                  value={openPath ?? ''}
                  onChange={(path) => {
                    if (dirty && !window.confirm('Discard unsaved changes to this file?')) return;
                    load(path);
                  }}
                  choices={[
                    ...(openPath == null ? [{ value: '', label: 'Select a file…' }] : []),
                    ...editableFiles.map((f) => ({ value: f.path, label: `${f.name} — ${f.path}` })),
                  ]}
                />
              </div>
              <Button size="sm" onClick={revert} disabled={!dirty}>
                Revert
              </Button>
              <Button
                size="sm"
                tone="primary"
                onClick={save}
                disabled={!dirty || file?.status === 'saving'}
                title="⌘S / Ctrl-S"
              >
                {file?.status === 'saving' ? 'Saving…' : 'Save'}
              </Button>
            </div>

            <div style={{ flex: 1, minHeight: 0 }}>
              {file == null ? (
                <EmptyState
                  title="No file open"
                  body={
                    editableFiles.length === 0
                      ? 'The server reported no editable YAML in this project.'
                      : 'Pick a file above, or click a node in the graph.'
                  }
                />
              ) : file.status === 'loading' ? (
                <LoadingState label="Reading the file…" />
              ) : file.status === 'error' && file.error ? (
                <ErrorState
                  title={file.error.title}
                  detail={file.error.detail}
                  onRetry={() => load(file.path)}
                />
              ) : (
                <>
                  {revealNote != null && (
                    <div
                      style={{
                        padding: 'var(--sp-2) var(--sp-3)',
                        background: 'var(--s-raised)',
                        color: 'var(--t-secondary)',
                        fontSize: 11.5,
                      }}
                    >
                      {revealNote}
                    </div>
                  )}
                  {file.error != null && (
                    <div
                      style={{
                        padding: 'var(--sp-2) var(--sp-3)',
                        background: 'var(--danger-soft)',
                        color: 'var(--danger)',
                        fontSize: 11.5,
                      }}
                    >
                      {file.error.title}
                      {file.error.detail != null ? ` — ${file.error.detail}` : ''}
                    </div>
                  )}
                  <YamlEditor
                    value={file.draft}
                    onChange={(draft) =>
                      setFile((prev) => (prev && prev.path === file.path ? { ...prev, draft } : prev))
                    }
                    issues={file.issues}
                    onSave={save}
                    readOnly={file.status === 'saving'}
                    revealLine={reveal}
                  />
                </>
              )}
            </div>
          </>
        )}

        {tab === 'relate' && (
          <RelationshipForm
            entities={entities}
            initialFrom={node?.kind === 'entity' ? node.id : undefined}
            onWritten={onProjectChanged}
          />
        )}
      </div>
    </div>
  );
}

function describe(err: unknown, fallback: string): { title: string; detail?: string } {
  if (err instanceof ApiError) {
    return {
      title: err.isOffline ? 'The Studio server is not responding' : err.message || fallback,
      detail: err.detail,
    };
  }
  return { title: fallback, detail: err instanceof Error ? err.message : String(err) };
}
