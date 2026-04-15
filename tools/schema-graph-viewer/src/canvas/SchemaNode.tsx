import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNodeData } from '@pattern-stack/graph-components';

/**
 * Custom ReactFlow node that renders schema entities and relationships.
 *
 * This is the ReactFlow integration layer. It wraps GraphNode from the
 * component library (when available) and adds ReactFlow-specific handles.
 * Until GraphNode is ready, it renders a basic card representation.
 */
export const SchemaNode = memo(function SchemaNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData;
  const isRelationship = nodeData.kind === 'relationship';

  const borderColor = selected
    ? '#3b82f6'
    : isRelationship
      ? '#f59e0b'
      : '#6366f1';

  const bgColor = isRelationship ? '#fffbeb' : '#f0f0ff';

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div
        style={{
          background: bgColor,
          border: `2px solid ${borderColor}`,
          borderRadius: 8,
          padding: '8px 12px',
          minWidth: isRelationship ? 200 : 240,
          fontSize: 13,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          boxShadow: selected ? `0 0 0 2px ${borderColor}40` : '0 1px 3px rgba(0,0,0,0.08)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 14 }}>
            {isRelationship ? '◇' : '■'}
          </span>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{nodeData.label}</span>
          {nodeData.group && (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 9999,
                background: '#e5e7eb',
                color: '#6b7280',
                marginLeft: 'auto',
              }}
            >
              {nodeData.group}
            </span>
          )}
        </div>

        {/* Relationship: from → to */}
        {isRelationship && nodeData.from && nodeData.to && (
          <div style={{ fontSize: 11, color: '#92400e', marginBottom: 4 }}>
            {nodeData.from} → {nodeData.to}
          </div>
        )}

        {/* Fields (collapsed) */}
        {nodeData.fields && nodeData.fields.length > 0 && (
          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 4, marginTop: 4 }}>
            {nodeData.fields.slice(0, 6).map((f) => (
              <div
                key={f.name}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  padding: '1px 0',
                  color: f.system ? '#9ca3af' : '#374151',
                }}
              >
                <span>
                  {f.role === 'pk' ? '🔑 ' : f.role === 'fk' ? '🔗 ' : ''}
                  {f.name}
                </span>
                {f.type && <span style={{ color: '#9ca3af' }}>{f.type}</span>}
              </div>
            ))}
            {nodeData.fields.length > 6 && (
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                +{nodeData.fields.length - 6} more
              </div>
            )}
          </div>
        )}

        {/* Behaviors */}
        {nodeData.behaviors && nodeData.behaviors.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {nodeData.behaviors.map((b) => (
              <span
                key={b}
                style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#dbeafe',
                  color: '#1d4ed8',
                }}
              >
                {b}
              </span>
            ))}
          </div>
        )}

        {/* Types (for relationships) */}
        {nodeData.types && nodeData.types.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {nodeData.types.map((t) => (
              <span
                key={t.name}
                style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#fef3c7',
                  color: '#92400e',
                }}
              >
                {t.name}
                {t.direction === 'bidirectional' ? ' ↔' : t.direction === 'directed' ? ' →' : ''}
              </span>
            ))}
          </div>
        )}

        {/* Flags */}
        {nodeData.flags && nodeData.flags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {nodeData.flags.map((f) => (
              <span
                key={f}
                style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#fce7f3',
                  color: '#9d174d',
                }}
              >
                {f}
              </span>
            ))}
          </div>
        )}

        {/* Footer counts */}
        <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 10, color: '#9ca3af' }}>
          {nodeData.fieldCount != null && <span>{nodeData.fieldCount} fields</span>}
          {nodeData.queryCount != null && nodeData.queryCount > 0 && (
            <span>{nodeData.queryCount} queries</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  );
});
