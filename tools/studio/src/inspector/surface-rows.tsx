/**
 * The rows and chips the API tab and the edge panel both print — one row
 * anatomy, so a method reads the same on an entity as on an edge.
 */
import type { YamlRef } from '@studio-shared';

import { edgeColor, edgeStyle } from '../graph/edge-kinds';
import type { OriginChip as OriginChipModel, SurfaceRow } from './surface-view';

export interface LinkProps {
  onReveal: (ref: YamlRef) => void;
  canReveal: (ref: YamlRef) => boolean;
}

export function Row({ row, hideOrigin = false, ...link }: { row: SurfaceRow; hideOrigin?: boolean } & LinkProps) {
  return (
    <div
      style={{
        padding: '5px var(--sp-2)',
        borderBottom: '1px solid var(--s-line)',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      {/* The line wraps: a chip that does not fit beside the signature drops
          under it rather than squeezing it (a long origin once left the
          signature one letter per line). */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--sp-1) var(--sp-2)',
          minWidth: 0,
        }}
      >
        <span
          style={{
            flex: '1 1 auto',
            // Never narrower than this, so a neighbour cannot squeeze it.
            minWidth: 'min(100%, 20ch)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--t-primary)',
            // The signature is the row's content — it wraps rather than hide
            // its result shape behind an ellipsis, and only between words
            // (`anywhere` would let its min-content shrink to one letter).
            overflowWrap: 'break-word',
          }}
        >
          {row.signature}
        </span>
        {!hideOrigin && row.origin != null && <Chip chip={row.origin} {...link} />}
      </div>

      {(row.kindLabel != null || row.flags.length > 0 || row.calls != null) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-1)', fontSize: 11 }}>
          {row.kindLabel != null && <Tag strong>{row.kindLabel}</Tag>}
          {row.flags.map((f) => (
            <Tag key={f}>{f}</Tag>
          ))}
          {row.calls != null && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--t-muted)' }}>→ {row.calls}</span>
          )}
        </div>
      )}

      {row.shadows.map((shadow) => (
        <div
          key={shadow.text}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            paddingLeft: 'var(--sp-3)',
            fontSize: 11,
            color: 'var(--t-muted)',
          }}
        >
          <span>shadows</span>
          <Chip chip={shadow} {...link} muted />
          <span>— resolved to the same name and lost</span>
        </div>
      ))}
    </div>
  );
}

function Tag({ children, strong = false }: { children: string; strong?: boolean }) {
  return (
    <span
      style={{
        padding: '0 5px',
        borderRadius: 'var(--r-sm)',
        background: strong ? 'var(--accent-soft)' : 'var(--s-raised)',
        color: strong ? 'var(--accent)' : 'var(--t-secondary)',
        lineHeight: '16px',
      }}
    >
      {children}
    </span>
  );
}

/**
 * An origin. A relation origin takes its edge kind's colour, so the chip
 * matches the line on the canvas it explains; every other origin is neutral.
 * A YAML origin is a link to its declaration's line.
 */
export function Chip({ chip, onReveal, canReveal, muted = false }: { chip: OriginChipModel; muted?: boolean } & LinkProps) {
  const tint = chip.edgeKind != null ? edgeColor(edgeStyle(chip.edgeKind)) : undefined;
  const ref = chip.yaml;
  const linked = ref != null && canReveal(ref);
  // Never wider than its line: a long origin truncates with an ellipsis and
  // keeps its full text in the tooltip. `text-overflow` needs a block box, so
  // the chip is inline-block, not inline-flex.
  const style = {
    flex: '0 1 auto',
    display: 'inline-block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    verticalAlign: 'middle',
    textAlign: 'left' as const,
    padding: '0 6px',
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: muted ? 'dashed' : 'solid',
    borderColor: tint ?? 'var(--s-line-strong)',
    background: 'transparent',
    color: tint ?? 'var(--t-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    lineHeight: '16px',
    whiteSpace: 'nowrap' as const,
  };

  if (!linked)
    return (
      <span title={chip.text} style={style}>
        {chip.text}
      </span>
    );
  return (
    <button
      type="button"
      onClick={(e) => {
        // Inside a <summary>, a click would also toggle the group.
        e.preventDefault();
        onReveal(ref);
      }}
      title={`${chip.text}\nOpen the ${ref.doc.kind} ${ref.doc.name} YAML at this declaration`}
      style={{ ...style, cursor: 'pointer' }}
    >
      {chip.text}
    </button>
  );
}
