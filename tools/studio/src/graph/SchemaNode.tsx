import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNodeData } from '@pattern-stack/graph-components';

/** How many fields a card shows before it collapses into a count. */
const VISIBLE_FIELDS = 7;

const ROLE_GLYPH: Record<string, string> = { pk: '◆', fk: '→' };

/**
 * A schema entity or junction, as a card on the canvas.
 *
 * Card height is derived from the same field cap the layout uses
 * (`../layout/elk-layout`), so elk reserves the space the card actually takes
 * and nothing overlaps after the first paint.
 */
export const SchemaNode = memo(function SchemaNode({ data, selected }: NodeProps) {
  const node = data as unknown as GraphNodeData & { dimmed?: boolean };
  const isJunction = node.kind === 'relationship';
  const accent = isJunction ? 'var(--graph-relationship-color)' : 'var(--graph-entity-color)';
  const hidden = node.fields ? node.fields.length - VISIBLE_FIELDS : 0;

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--s-panel)',
          border: `1px solid ${selected ? accent : 'var(--s-line)'}`,
          borderLeft: `3px solid ${accent}`,
          borderRadius: 'var(--r-lg)',
          // Selection is a ring, never a width change — a card must not resize
          // under the cursor and shove its neighbours.
          boxShadow: selected ? `0 0 0 2px color-mix(in srgb, ${accent} 35%, transparent)` : 'none',
          opacity: node.dimmed ? 0.28 : 1,
          transition: 'opacity 140ms ease, box-shadow 140ms ease',
          overflow: 'hidden',
          fontFamily: 'var(--font-ui)',
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: 'var(--sp-2) var(--sp-3)',
            borderBottom: '1px solid var(--s-line)',
          }}
        >
          <span style={{ color: accent, fontSize: 11 }}>{isJunction ? '◇' : '▣'}</span>
          <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--t-primary)' }}>
            {node.label}
          </span>
          {node.group != null && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 999,
                background: 'var(--s-raised)',
                color: 'var(--t-muted)',
              }}
            >
              {node.group}
            </span>
          )}
        </div>

        {isJunction && node.from != null && node.to != null && (
          <div
            style={{
              padding: '3px var(--sp-3)',
              fontSize: 10.5,
              color: 'var(--graph-relationship-color)',
              fontFamily: 'var(--font-mono)',
              borderBottom: '1px solid var(--s-line)',
            }}
          >
            {node.from} ↔ {node.to}
          </div>
        )}

        {node.fields != null && node.fields.length > 0 && (
          <div style={{ padding: 'var(--sp-1) var(--sp-3)', flex: 1, minHeight: 0 }}>
            {node.fields.slice(0, VISIBLE_FIELDS).map((f) => (
              <div
                key={f.name}
                style={{
                  display: 'flex',
                  gap: 'var(--sp-2)',
                  fontSize: 10.5,
                  fontFamily: 'var(--font-mono)',
                  lineHeight: '17px',
                  color: f.system === true ? 'var(--t-muted)' : 'var(--t-secondary)',
                }}
              >
                <span style={{ width: 8, color: f.role === 'fk' ? accent : 'var(--t-muted)' }}>
                  {f.role != null ? (ROLE_GLYPH[f.role] ?? '') : ''}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                {f.type != null && <span style={{ color: 'var(--t-muted)' }}>{f.type}</span>}
              </div>
            ))}
            {hidden > 0 && (
              <div style={{ fontSize: 10, color: 'var(--t-muted)', lineHeight: '17px' }}>
                +{hidden} more
              </div>
            )}
          </div>
        )}

        {((node.behaviors?.length ?? 0) > 0 || (node.flags?.length ?? 0) > 0) && (
          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-1)',
              flexWrap: 'wrap',
              padding: 'var(--sp-1) var(--sp-3) var(--sp-2)',
            }}
          >
            {[...(node.flags ?? []), ...(node.behaviors ?? [])].map((b) => (
              <span
                key={b}
                style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--s-raised)',
                  color: 'var(--t-muted)',
                }}
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  );
});
