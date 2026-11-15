import { Button } from '../ui/primitives';

export interface InspectorRailProps {
  /** What the canvas has selected — named so the reader knows the inspector has something to show. */
  selectionName: string | null;
  onExpand: () => void;
  /** The expand control's title and accessible name, shortcut included. */
  expandLabel: string;
}

/**
 * The inspector, collapsed: a thin rail down the right edge holding the
 * expand control, mirroring the drawer's collapsed bar.
 *
 * Selecting while collapsed does not reopen the inspector. Clicking cards to
 * light their neighbours *is* the exploration a full-width canvas is for;
 * reopening would shrink the canvas and refit it on every click. So the rail
 * says what is selected and that the inspector is hidden, with the expand
 * control right there.
 */
export function InspectorRail({ selectionName, onExpand, expandLabel }: InspectorRailProps) {
  return (
    <div
      role="complementary"
      aria-label="Inspector (hidden)"
      style={{
        flex: '0 0 var(--h-tabbar)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        minHeight: 0,
        paddingTop: 'var(--sp-1)',
        borderLeft: '1px solid var(--s-line)',
        background: 'var(--s-panel)',
        overflow: 'hidden',
      }}
    >
      <Button
        size="sm"
        tone="ghost"
        onClick={onExpand}
        title={expandLabel}
        ariaLabel={expandLabel}
        // Reads down the rail, as the drawer's collapsed bar reads across.
        style={{ writingMode: 'vertical-rl', height: 'auto', padding: 'var(--sp-2) 0' }}
      >
        Show ◂
      </Button>
      {selectionName != null && (
        <button
          type="button"
          onClick={onExpand}
          title={`${selectionName} is selected — the inspector is hidden. ${expandLabel}`}
          style={{
            writingMode: 'vertical-rl',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            minHeight: 0,
            padding: 'var(--sp-2) 0',
            border: 'none',
            background: 'transparent',
            color: 'var(--t-muted)',
            fontFamily: 'inherit',
            fontSize: 11.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: 'pointer',
          }}
        >
          <span style={{ color: 'var(--t-primary)', fontWeight: 600 }}>{selectionName}</span>
          <span>selected · inspector hidden</span>
        </button>
      )}
    </div>
  );
}
