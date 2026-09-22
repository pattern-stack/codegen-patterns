import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { edgeStyle } from './edge-kinds';
import type { StudioEdgeData } from './edge-kinds';

/**
 * A schema edge, styled from `edge-kinds` — the one table that decides what
 * each relationship kind looks like. Nothing here branches on a kind literal,
 * so the legend and the stroke cannot disagree.
 */
export const SchemaEdge = memo(function SchemaEdge({
  id,
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

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });

  const dimmed = edge?.dimmed === true;
  const label = edge?.roleName ?? edge?.label;

  // A `belongs_to` and its inverse `has_many` run between the same two cards in
  // opposite directions, so `getSmoothStepPath` hands both the same midpoint
  // and the two labels land on top of each other. Offsetting by the direction
  // of travel separates them without needing to know about the other edge.
  const labelOffset = sourceX <= targetX ? -11 : 11;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: style.color,
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
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY + labelOffset}px)`,
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              padding: '1px 5px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--s-canvas)',
              border: `1px solid ${style.color}55`,
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
