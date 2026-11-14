import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useInternalNode } from '@xyflow/react';
import type { EdgeProps, InternalNode } from '@xyflow/react';
import { anchorsBetween } from './edge-geometry';
import type { Box } from './edge-geometry';
import { edgeColor, edgeStyle } from './edge-kinds';
import type { StudioEdgeData } from './edge-kinds';

/** A laid-out card's box, once ReactFlow has measured it. */
function boxOf(node: InternalNode | undefined): Box | undefined {
  const width = node?.measured.width;
  const height = node?.measured.height;
  if (node == null || width == null || height == null) return undefined;
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, width, height };
}

/**
 * A schema edge, styled from `edge-kinds` — the one table that decides what
 * each relationship kind looks like. Nothing here branches on a kind literal,
 * so the legend and the stroke cannot disagree.
 *
 * The line meets each card on the side facing the other (`edge-geometry.ts`),
 * not at the card's fixed handles — those only exist because ReactFlow will
 * not draw an edge without one. Before both cards are measured, the handle
 * positions ReactFlow passes in are used as they are.
 */
export const SchemaEdge = memo(function SchemaEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edge = data as unknown as (StudioEdgeData & { dimmed?: boolean }) | undefined;
  const style = edgeStyle(edge?.studioKind ?? 'belongs_to');
  const color = edgeColor(style);

  const sourceBox = boxOf(useInternalNode(source));
  const targetBox = boxOf(useInternalNode(target));
  const anchors =
    sourceBox != null && targetBox != null
      ? anchorsBetween(sourceBox, targetBox)
      : { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition };

  const [path, labelX, labelY] = getSmoothStepPath({ ...anchors, borderRadius: 14 });

  const dimmed = edge?.dimmed === true;
  // A `belongs_to` and its inverse are one line (#778), so its label already
  // names both ends — there is no second label to keep clear of.
  const label = edge?.label;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: selected === true ? style.width + 1 : style.width,
          strokeDasharray: style.dash,
          opacity: dimmed ? 0.12 : 0.85,
          transition: 'opacity 140ms ease',
        }}
        markerEnd={style.marker != null ? `url(#${style.marker})` : undefined}
      />
      {label != null && label !== '' && !dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              padding: '1px 5px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--s-canvas)',
              border: `1px solid color-mix(in srgb, ${color} 33%, transparent)`,
              color: 'var(--t-secondary)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
