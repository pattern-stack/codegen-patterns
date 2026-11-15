/**
 * Fit-to-view that keeps a corner overlay off the cards (STUDIO-4) — pure, no DOM.
 *
 * The legend sits in the canvas's bottom-right corner. A plain fit centres the
 * graph on the whole canvas, so on some shapes a card lands under the legend.
 * The rule: take the plain fit unless a card's on-screen rect meets the
 * corner's box; then fit into the canvas minus a strip along the bottom (the
 * corner's height, inset included) or along the right (its width, inset
 * included), whichever leaves the larger zoom — ties go to the bottom.
 *
 * The plain fit is ReactFlow's own `getViewportForBounds`, so "no overlap"
 * means exactly the view ReactFlow's `fitView` would have shown.
 */
import { getViewportForBounds } from '@xyflow/react';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

/** The union of the cards' rects, in flow coordinates. */
export function boundsOf(cards: readonly Rect[]): Rect | null {
  if (cards.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cards) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A card's rect on screen, under a viewport. */
export function onScreen(card: Rect, viewport: Viewport): Rect {
  return {
    x: card.x * viewport.zoom + viewport.x,
    y: card.y * viewport.zoom + viewport.y,
    width: card.width * viewport.zoom,
    height: card.height * viewport.zoom,
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True when any card, under `viewport`, meets the corner's box (canvas coordinates). */
export function coversACard(cards: readonly Rect[], viewport: Viewport, corner: Rect): boolean {
  if (corner.width <= 0 || corner.height <= 0) return false;
  return cards.some((card) => intersects(onScreen(card, viewport), corner));
}

const finite = (v: Viewport) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom);

function fitInto(bounds: Rect, region: Size, padding: number, limits: ZoomLimits): Viewport | null {
  if (region.width <= 0 || region.height <= 0) return null;
  const v = getViewportForBounds(bounds, region.width, region.height, limits.min, limits.max, padding);
  return finite(v) ? v : null;
}

/**
 * The viewport for fit-to-view on `canvas`, keeping `corner` — the overlay's
 * box in canvas coordinates, anchored bottom-right — off every card.
 *
 * `corner` null (nothing measured) or covering nothing → the plain fit. A
 * corner too big to leave room on either side falls back to the plain fit
 * rather than producing a degenerate view.
 */
export function fitAvoidingCorner(
  cards: readonly Rect[],
  canvas: Size,
  corner: Rect | null,
  padding: number,
  limits: ZoomLimits,
): Viewport | null {
  const bounds = boundsOf(cards);
  if (bounds == null) return null;
  const plain = fitInto(bounds, canvas, padding, limits);
  if (plain == null) return null;
  if (corner == null || !coversACard(cards, plain, corner)) return plain;

  // The strip runs from the corner's near edge to the canvas edge, so it
  // includes the inset between the overlay and the edge.
  const bottom = fitInto(bounds, { width: canvas.width, height: corner.y }, padding, limits);
  const right = fitInto(bounds, { width: corner.x, height: canvas.height }, padding, limits);
  if (bottom == null && right == null) return plain;
  if (right == null) return bottom;
  if (bottom == null) return right;
  return right.zoom > bottom.zoom ? right : bottom;
}
