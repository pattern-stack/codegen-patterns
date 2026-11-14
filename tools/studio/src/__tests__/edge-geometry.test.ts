/**
 * Where a line meets its cards (#778): the sides that face each other, so no
 * line wraps round a card to reach a fixed handle.
 */
import { describe, expect, test } from 'bun:test';
import { Position } from '@xyflow/react';

import { anchorsBetween } from '../graph/edge-geometry';
import type { Box } from '../graph/edge-geometry';

const box = (x: number, y: number): Box => ({ x, y, width: 200, height: 100 });

function sides(source: Box, target: Box): [Position, Position] {
  const a = anchorsBetween(source, target);
  return [a.sourcePosition, a.targetPosition];
}

describe('anchorsBetween', () => {
  test('a child below its parent joins bottom of the upper card to top of the lower one', () => {
    // Drawn child → parent (a belongs_to), child in the lower layer.
    expect(sides(box(0, 300), box(0, 0))).toEqual([Position.Top, Position.Bottom]);
    expect(sides(box(0, 0), box(500, 300))).toEqual([Position.Bottom, Position.Top]);
  });

  test('cards side by side join on their facing sides, whichever way the line runs', () => {
    expect(sides(box(0, 0), box(400, 20))).toEqual([Position.Right, Position.Left]);
    // The case fixed handles got wrong: a target to the LEFT of its source.
    expect(sides(box(400, 20), box(0, 0))).toEqual([Position.Left, Position.Right]);
  });

  test('anchors sit on the middle of the chosen side', () => {
    expect(anchorsBetween(box(0, 300), box(0, 0))).toEqual({
      sourceX: 100,
      sourceY: 300,
      sourcePosition: Position.Top,
      targetX: 100,
      targetY: 100,
      targetPosition: Position.Bottom,
    });
  });

  test('a card to itself leaves its right side and comes back in at its top', () => {
    expect(sides(box(0, 0), box(0, 0))).toEqual([Position.Right, Position.Top]);
  });
});
