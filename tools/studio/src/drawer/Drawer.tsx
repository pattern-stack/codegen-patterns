import { useState } from 'react';
import { LogView } from './LogView';
import { DiffView } from './DiffView';
import { isRunInFlight } from './run-state';
import type { RunState } from './run-state';
import { Button, CountBadge, Dot, Spinner, Tabs } from '../ui/primitives';

type DrawerTab = 'log' | 'diff';

export interface DrawerProps {
  run: RunState;
  open: boolean;
  onToggle: () => void;
  /** Which tab to show; the drawer switches to `diff` itself when a run lands. */
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  height: number;
  onResize: (height: number) => void;
}

/**
 * The bottom drawer — the run log while a run streams, its diff once it lands.
 *
 * Height is owned by the parent and applied to a flex basis, so opening,
 * closing and dragging move only this pane; the graph and inspector above
 * re-flow once, on release, rather than on every streamed line.
 */
export function Drawer({ run, open, onToggle, tab, onTabChange, height, onResize }: DrawerProps) {
  const [dragging, setDragging] = useState(false);
  const inFlight = isRunInFlight(run);
  const fileCount = run.diff?.files.length ?? 0;

  const statusDot = () => {
    if (inFlight) return <Spinner size={10} />;
    if (run.phase === 'error' || run.ok === false) return <Dot color="var(--danger)" title="failed" />;
    if (run.ok === true) return <Dot color="var(--ok)" title="succeeded" />;
    return <Dot color="var(--s-line-strong)" title="no run yet" />;
  };

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    setDragging(true);
    const startY = event.clientY;
    const startHeight = height;

    const move = (e: PointerEvent) => {
      // Clamped so the drawer can never swallow the graph or vanish behind
      // its own tab bar.
      const next = Math.min(Math.max(startHeight + (startY - e.clientY), 120), window.innerHeight - 220);
      onResize(next);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      style={{
        flex: `0 0 ${open ? height + 36 : 36}px`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderTop: '1px solid var(--s-line)',
        background: 'var(--s-panel)',
      }}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the drawer"
          onPointerDown={startDrag}
          style={{
            height: 4,
            marginTop: -2,
            marginBottom: -2,
            zIndex: 2,
            cursor: 'row-resize',
            background: dragging ? 'var(--accent)' : 'transparent',
          }}
        />
      )}

      <Tabs<DrawerTab>
        tabs={[
          { id: 'log', label: 'Log', badge: run.log.length > 0 ? <CountBadge count={run.log.length} /> : undefined },
          { id: 'diff', label: 'Diff', badge: fileCount > 0 ? <CountBadge count={fileCount} /> : undefined },
        ]}
        active={tab}
        onSelect={(next) => {
          onTabChange(next);
          if (!open) onToggle();
        }}
        trailing={
          <>
            {statusDot()}
            <Button size="sm" tone="ghost" onClick={onToggle}>
              {open ? 'Hide ▾' : 'Show ▴'}
            </Button>
          </>
        }
      />

      {open && (
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'log' ? <LogView state={run} /> : <DiffView diff={run.diff} />}
        </div>
      )}
    </div>
  );
}
