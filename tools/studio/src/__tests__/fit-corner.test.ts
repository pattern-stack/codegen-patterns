/**
 * Fit-to-view that keeps the legend's corner off the cards (STUDIO-4): when
 * nothing is covered it is ReactFlow's own fit, unchanged; when something is,
 * it reserves the strip (bottom or right) that leaves the larger zoom.
 */
import { describe, expect, test } from 'bun:test';
import { getViewportForBounds } from '@xyflow/react';

import { boundsOf, coversACard, fitAvoidingCorner } from '../graph/fit-corner';
import type { Rect } from '../graph/fit-corner';

const PADDING = 0.18;
const LIMITS = { min: 0.05, max: 2 };

/** A small tree: one parent on top, two children below it. */
const TREE: Rect[] = [
  { x: 200, y: 0, width: 300, height: 150 },
  { x: 0, y: 280, width: 300, height: 190 },
  { x: 360, y: 280, width: 300, height: 190 },
];
/** The expanded legend: 348×188, inset 12 from the bottom-right of a 1000×600 canvas. */
const CANVAS = { width: 1000, height: 600 };
const LEGEND: Rect = { x: 640, y: 400, width: 348, height: 188 };

const plainFit = (cards: Rect[], canvas = CANVAS) =>
  getViewportForBounds(boundsOf(cards)!, canvas.width, canvas.height, LIMITS.min, LIMITS.max, PADDING);

describe('fitAvoidingCorner', () => {
  test('nothing covered → exactly the plain fit', () => {
    const small: Rect = { x: 900, y: 560, width: 88, height: 28 };
    expect(coversACard(TREE, plainFit(TREE), small)).toBe(false);
    expect(fitAvoidingCorner(TREE, CANVAS, small, PADDING, LIMITS)).toEqual(plainFit(TREE));
  });

  test('no corner measured → the plain fit', () => {
    expect(fitAvoidingCorner(TREE, CANVAS, null, PADDING, LIMITS)).toEqual(plainFit(TREE));
  });

  test('covered → the candidate with the larger zoom, which covers no card', () => {
    expect(coversACard(TREE, plainFit(TREE), LEGEND)).toBe(true);

    const fit = fitAvoidingCorner(TREE, CANVAS, LEGEND, PADDING, LIMITS)!;
    expect(coversACard(TREE, fit, LEGEND)).toBe(false);

    const bounds = boundsOf(TREE)!;
    const bottom = getViewportForBounds(bounds, CANVAS.width, LEGEND.y, LIMITS.min, LIMITS.max, PADDING);
    const right = getViewportForBounds(bounds, LEGEND.x, CANVAS.height, LIMITS.min, LIMITS.max, PADDING);
    // This tree is wide for the room a bottom strip leaves: the right strip zooms further.
    expect(right.zoom).toBeGreaterThan(bottom.zoom);
    expect(fit).toEqual(right);
  });

  test('a long row keeps more zoom by giving up the bottom strip', () => {
    const row: Rect[] = [
      { x: 0, y: 0, width: 300, height: 400 },
      { x: 400, y: 0, width: 300, height: 400 },
      { x: 800, y: 0, width: 300, height: 400 },
      { x: 1200, y: 0, width: 300, height: 400 },
    ];
    const canvas = { width: 1000, height: 400 };
    const legend: Rect = { x: 760, y: 300, width: 228, height: 88 };
    expect(coversACard(row, plainFit(row, canvas), legend)).toBe(true);

    const fit = fitAvoidingCorner(row, canvas, legend, PADDING, LIMITS)!;
    const bounds = boundsOf(row)!;
    const bottom = getViewportForBounds(bounds, canvas.width, legend.y, LIMITS.min, LIMITS.max, PADDING);
    const right = getViewportForBounds(bounds, legend.x, canvas.height, LIMITS.min, LIMITS.max, PADDING);
    expect(bottom.zoom).toBeGreaterThan(right.zoom);
    expect(fit).toEqual(bottom);
    expect(coversACard(row, fit, legend)).toBe(false);
  });

  test('a tie goes to the bottom strip', () => {
    // Square canvas, square corner, square graph: both strips leave the same room.
    const cards: Rect[] = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 400, y: 400, width: 100, height: 100 },
    ];
    const canvas = { width: 1000, height: 1000 };
    const corner: Rect = { x: 600, y: 600, width: 388, height: 388 };
    expect(coversACard(cards, plainFit(cards, canvas), corner)).toBe(true);

    const bounds = boundsOf(cards)!;
    const bottom = getViewportForBounds(bounds, canvas.width, corner.y, LIMITS.min, LIMITS.max, PADDING);
    const right = getViewportForBounds(bounds, corner.x, canvas.height, LIMITS.min, LIMITS.max, PADDING);
    expect(bottom.zoom).toBe(right.zoom);
    expect(fitAvoidingCorner(cards, canvas, corner, PADDING, LIMITS)).toEqual(bottom);
  });

  test('zoom stays within the limits', () => {
    const tiny: Rect[] = [{ x: 0, y: 0, width: 10, height: 10 }];
    const fit = fitAvoidingCorner(tiny, CANVAS, { x: 0, y: 0, width: 1000, height: 600 }, PADDING, LIMITS)!;
    expect(fit.zoom).toBeLessThanOrEqual(LIMITS.max);
    expect(fit.zoom).toBeGreaterThanOrEqual(LIMITS.min);
  });

  test('a corner bigger than the canvas neither throws nor yields NaN', () => {
    const huge: Rect = { x: -200, y: -200, width: 1400, height: 1000 };
    const fit = fitAvoidingCorner(TREE, CANVAS, huge, PADDING, LIMITS);
    expect(fit).not.toBeNull();
    for (const v of [fit!.x, fit!.y, fit!.zoom]) expect(Number.isFinite(v)).toBe(true);
    expect(fit).toEqual(plainFit(TREE));
  });

  test('no cards, or a zero-size canvas, gives no viewport rather than NaN', () => {
    expect(fitAvoidingCorner([], CANVAS, LEGEND, PADDING, LIMITS)).toBeNull();
    expect(fitAvoidingCorner(TREE, { width: 0, height: 0 }, LEGEND, PADDING, LIMITS)).toBeNull();
  });
});
