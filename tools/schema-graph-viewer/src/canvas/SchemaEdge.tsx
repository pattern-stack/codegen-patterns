import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
} from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { GraphEdgeData } from '@pattern-stack/graph-components';

/**
 * Custom ReactFlow edge renderer for schema relationships.
 * Uses smooth step paths (orthogonal routing) to match the elkjs layout.
 * Edge color and style vary by relationship type.
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
  label,
  selected,
}: EdgeProps) {
  const edgeData = data as unknown as GraphEdgeData | undefined;

  const color =
    edgeData?.type === 'junction'
      ? '#f59e0b'
      : edgeData?.type === 'fk'
        ? '#6366f1'
        : '#94a3b8';

  const strokeWidth = selected ? 2.5 : 1.5;
  const strokeDasharray = edgeData?.type === 'inline' ? '6 3' : undefined;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const displayLabel = label ?? edgeData?.cardinality;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth,
          strokeDasharray,
        }}
        markerEnd={edgeData?.bidirectional ? undefined : 'url(#arrow)'}
      />
      {displayLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 10,
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              padding: '1px 6px',
              borderRadius: 4,
              background: 'white',
              border: `1px solid ${color}40`,
              color: '#6b7280',
              pointerEvents: 'none',
            }}
          >
            {displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
