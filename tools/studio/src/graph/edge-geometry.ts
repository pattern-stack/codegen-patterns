/**
 * Where a line meets its two cards (#778).
 *
 * A card's handles are fixed (`SchemaNode.tsx`), but the line does not use
 * them: it leaves and enters whichever sides face each other in the laid-out
 * geometry. Fixed sides were what made a line leave the right of one card and
 * wrap round into the left of a card placed to its left — a route that reads
 * as a self-reference.
 *
 * Pure: no React, no DOM. Unit-tested in `../__tests__/edge-geometry.test.ts`.
 */
import { Position } from '@xyflow/react';

/** A card on the canvas, in flow coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchors {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
}

function point(box: Box, side: Position): { x: number; y: number } {
  switch (side) {
    case Position.Top:
      return { x: box.x + box.width / 2, y: box.y };
    case Position.Bottom:
      return { x: box.x + box.width / 2, y: box.y + box.height };
    case Position.Left:
      return { x: box.x, y: box.y + box.height / 2 };
    case Position.Right:
      return { x: box.x + box.width, y: box.y + box.height / 2 };
  }
}

function anchored(source: Box, sourceSide: Position, target: Box, targetSide: Position): Anchors {
  const s = point(source, sourceSide);
  const t = point(target, targetSide);
  return {
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: sourceSide,
    targetX: t.x,
    targetY: t.y,
    targetPosition: targetSide,
  };
}

/**
 * The sides a line between two cards uses.
 *
 * Cards in different layers (no vertical overlap) join bottom-to-top, which
 * is every parent → child line of the parents-above layout. Cards beside each
 * other join on their facing sides. A line from a card to itself leaves its
 * right side and comes back in at its top, so it reads as a loop, not as an
 * edge to a neighbour.
 */
export function anchorsBetween(source: Box, target: Box): Anchors {
  if (source.x === target.x && source.y === target.y) {
    return anchored(source, Position.Right, target, Position.Top);
  }

  const sourceBottom = source.y + source.height;
  const targetBottom = target.y + target.height;
  if (sourceBottom <= target.y) return anchored(source, Position.Bottom, target, Position.Top);
  if (targetBottom <= source.y) return anchored(source, Position.Top, target, Position.Bottom);

  const sourceCentre = source.x + source.width / 2;
  const targetCentre = target.x + target.width / 2;
  return sourceCentre <= targetCentre
    ? anchored(source, Position.Right, target, Position.Left)
    : anchored(source, Position.Left, target, Position.Right);
}
