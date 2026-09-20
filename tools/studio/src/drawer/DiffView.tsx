import { useMemo, useState } from 'react';
import type { DiffFile, DiffResponse, DiffStatus } from '@studio-shared';
import { parsePatch, patchTotals } from './parse-patch';
import { EmptyState } from '../ui/primitives';

const STATUS_STYLE: Record<DiffStatus, { glyph: string; color: string }> = {
  added: { glyph: 'A', color: 'var(--add)' },
  untracked: { glyph: '?', color: 'var(--add)' },
  modified: { glyph: 'M', color: 'var(--warn)' },
  deleted: { glyph: 'D', color: 'var(--del)' },
  renamed: { glyph: 'R', color: 'var(--accent)' },
};

const LINE_STYLE: Record<string, { background?: string; color: string; marker: string }> = {
  add: { background: 'var(--add-bg)', color: 'var(--add)', marker: '+' },
  del: { background: 'var(--del-bg)', color: 'var(--del)', marker: '-' },
  context: { color: 'var(--t-secondary)', marker: ' ' },
  hunk: { color: 'var(--t-muted)', marker: ' ' },
  meta: { color: 'var(--t-muted)', marker: ' ' },
};

/**
 * The working-tree diff a run produced: file list on the left, the selected
 * file's patch on the right.
 *
 * The two-pane split keeps the patch column a fixed width no matter how many
 * files a run touched — a single scrolling list of every patch makes finding
 * the one file you care about a scroll hunt.
 */
export function DiffView({ diff }: { diff: DiffResponse | null }) {
  const [selected, setSelected] = useState<string | null>(null);

  const totals = useMemo(
    () => patchTotals((diff?.files ?? []).map((f) => f.patch)),
    [diff],
  );

  if (!diff) {
    return (
      <EmptyState
        title="No diff yet"
        body="Run Generate — the diff of everything it wrote lands here."
      />
    );
  }

  if (diff.files.length === 0) {
    return (
      <EmptyState
        title="No changes"
        body="The run finished without changing any file in the project's working tree."
      />
    );
  }

  const current: DiffFile = diff.files.find((f) => f.path === selected) ?? diff.files[0]!;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div
        style={{
          width: 300,
          flex: '0 0 300px',
          borderRight: '1px solid var(--s-line)',
          overflowY: 'auto',
          background: 'var(--s-chrome)',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-3)',
            padding: 'var(--sp-2) var(--sp-3)',
            borderBottom: '1px solid var(--s-line)',
            fontSize: 11,
            color: 'var(--t-muted)',
            position: 'sticky',
            top: 0,
            background: 'var(--s-chrome)',
          }}
        >
          <span>{diff.files.length} files</span>
          <span style={{ color: 'var(--add)' }}>+{totals.added}</span>
          <span style={{ color: 'var(--del)' }}>−{totals.removed}</span>
        </div>

        {diff.files.map((file) => {
          const status = STATUS_STYLE[file.status];
          const on = file.path === current.path;
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelected(file.path)}
              title={file.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-2)',
                width: '100%',
                padding: '5px var(--sp-3)',
                border: 'none',
                borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                background: on ? 'var(--s-raised)' : 'transparent',
                color: on ? 'var(--t-primary)' : 'var(--t-secondary)',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
              }}
            >
              <span style={{ color: status.color, fontWeight: 700, width: 10, flex: '0 0 auto' }}>
                {status.glyph}
              </span>
              {/* Long generated paths are truncated from the left so the
                  filename — the part that identifies it — stays visible. */}
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  direction: 'rtl',
                  textAlign: 'left',
                }}
              >
                {file.path}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--s-canvas)' }}>
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            padding: 'var(--sp-2) var(--sp-3)',
            borderBottom: '1px solid var(--s-line)',
            background: 'var(--s-chrome)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--t-primary)',
          }}
        >
          {current.path}
        </div>
        <PatchBody patch={current.patch} />
      </div>
    </div>
  );
}

function PatchBody({ patch }: { patch: string }) {
  const parsed = useMemo(() => parsePatch(patch), [patch]);

  if (parsed.lines.length === 0) {
    return (
      <div style={{ padding: 'var(--sp-4)', fontSize: 12, color: 'var(--t-muted)' }}>
        No textual changes in this file.
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: '17px' }}>
      {parsed.lines.map((line, i) => {
        const style = LINE_STYLE[line.kind]!;
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              background: line.kind === 'hunk' ? 'var(--s-chrome)' : style.background,
              color: style.color,
              whiteSpace: 'pre',
            }}
          >
            <span
              style={{
                flex: '0 0 44px',
                textAlign: 'right',
                paddingRight: 'var(--sp-2)',
                color: 'var(--t-muted)',
                opacity: 0.6,
                userSelect: 'none',
              }}
            >
              {line.oldLine ?? ''}
            </span>
            <span
              style={{
                flex: '0 0 44px',
                textAlign: 'right',
                paddingRight: 'var(--sp-2)',
                color: 'var(--t-muted)',
                opacity: 0.6,
                userSelect: 'none',
                borderRight: '1px solid var(--s-line)',
              }}
            >
              {line.newLine ?? ''}
            </span>
            <span
              style={{
                flex: '0 0 18px',
                textAlign: 'center',
                userSelect: 'none',
                opacity: 0.8,
              }}
            >
              {line.kind === 'hunk' || line.kind === 'meta' ? '' : style.marker}
            </span>
            <span style={{ flex: 1, paddingRight: 'var(--sp-3)' }}>{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}
