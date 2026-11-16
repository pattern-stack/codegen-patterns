/**
 * PROTOTYPE (STUDIO-6) — floating inheritance, ownership-first only.
 *
 * Under ownership first a child that inherits a shared base hangs under its
 * owner, so its `inherits` line is secondary and runs the width of the canvas
 * to a base card placed somewhere else. This replaces that line with a chip on
 * the child ("is a Part"); clicking it selects the real base card and pans to
 * it. The base card is still drawn once, where its own spine puts it.
 *
 * A floated `inherits` line is hidden at rest and drawn again while its child
 * or its base is selected, so the relation stays reachable (and its edge panel
 * clickable) without the long line on the resting canvas. Either way it is a
 * secondary line, which the layout never reads: floating moves no card.
 *
 * Exploratory: the owner decides at sign-off whether it stays. Everything is
 * here behind `FLOAT_INHERITANCE`; deleting it is this file plus the handful of
 * lines in `SchemaCanvas.tsx`, `SchemaNode.tsx`, `GraphPane.tsx` and `App.tsx`
 * that name it.
 */
import { createContext, useContext } from 'react';
import { edgeColor, edgeStyle } from './edge-kinds';
import type { StudioEdgeData } from './edge-kinds';

/** The prototype's one flag. `false` turns it off everywhere. */
export const FLOAT_INHERITANCE = true;

/** What a floated child shows: its base's id and the base's card label. */
export interface FloatedBase {
  base: string;
  label: string;
}

/**
 * The children whose `inherits` line floats, keyed by child id: every
 * `inherits` line that is not its child's spine. Pure — tested without a DOM.
 */
export function floatedBases(
  edges: readonly StudioEdgeData[],
  labelOf: (id: string) => string,
): Map<string, FloatedBase> {
  const floated = new Map<string, FloatedBase>();
  for (const e of edges) {
    if (e.studioKind !== 'inherits' || e.treeRole !== 'secondary') continue;
    floated.set(e.child, { base: e.parent, label: labelOf(e.parent) });
  }
  return floated;
}

/** True when a floated line should be hidden: it floats and neither of its ends is selected. */
export function hidesFloatedLine(
  edge: StudioEdgeData,
  floated: ReadonlyMap<string, FloatedBase>,
  selectedNodeId: string | null,
  selectedEdgeId: string | null,
): boolean {
  if (edge.studioKind !== 'inherits' || floated.get(edge.child)?.base !== edge.parent) return false;
  return selectedEdgeId !== edge.id && selectedNodeId !== edge.child && selectedNodeId !== edge.parent;
}

/** Select and reveal a base card — provided by the canvas, read by the chip. */
export const RevealBaseContext = createContext<(base: string) => void>(() => {});

/**
 * The chip on a floated child. It hangs off the card's top edge, outside the
 * card's box, so the card's size (and so the layout) is the same with or
 * without it.
 */
export function BaseChip({ floated }: { floated: FloatedBase }) {
  const reveal = useContext(RevealBaseContext);
  const color = edgeColor(edgeStyle('inherits'));
  const label = `is a ${floated.label}`;
  return (
    <button
      type="button"
      className="nodrag nopan"
      title={`${label} — select and show the ${floated.label} card`}
      aria-label={`${label}: show the ${floated.label} card`}
      onClick={(event) => {
        // The card's own click toggles the card; this one is about the base.
        event.stopPropagation();
        reveal(floated.base);
      }}
      style={{
        position: 'absolute',
        // Fully above the card's top edge, clear of its header badge; rows are ≥ 96 px apart.
        top: -24,
        right: 10,
        height: 20,
        padding: '0 7px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        borderRadius: 999,
        border: `1px dashed ${color}`,
        background: 'var(--s-panel)',
        color: 'var(--t-secondary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      <span aria-hidden style={{ color }}>
        ▲
      </span>
      {label}
    </button>
  );
}
