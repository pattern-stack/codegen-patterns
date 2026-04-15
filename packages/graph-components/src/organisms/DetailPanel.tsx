import type { DetailPanelProps } from '../types/component-props.js';
import { NodeHeader } from '../molecules/NodeHeader.js';
import { FieldList } from '../molecules/FieldList.js';
import { BehaviorBadgeRow } from '../molecules/BehaviorBadgeRow.js';
import { TypeBadgeRow } from '../molecules/TypeBadgeRow.js';
import { DirectionIndicator } from '../atoms/DirectionIndicator.js';
import { Badge } from '../atoms/Badge.js';

const kindIcon = {
  entity: 'entity',
  relationship: 'relationship',
  record: 'person',
} as const;

export function DetailPanel<T = unknown>({
  node,
  onClose,
  width = 360,
}: DetailPanelProps<T>) {
  if (!node) return null;

  return (
    <div
      className="flex h-full flex-col border-l border-[var(--graph-node-border)] bg-[var(--graph-panel-bg)] font-[var(--graph-font-family)]"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--graph-node-border)] px-3 py-2">
        <NodeHeader
          icon={kindIcon[node.kind]}
          label={node.label}
          subtitle={node.subtitle}
          badge={
            node.group
              ? { label: node.group, variant: 'muted' as const }
              : undefined
          }
        />
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-[var(--graph-badge-muted-text)] hover:bg-[var(--graph-badge-default-bg)]"
          aria-label="Close detail panel"
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Direction (relationships) */}
        {node.from && node.to && (
          <div className="border-b border-[var(--graph-node-border)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
              Direction
            </div>
            <DirectionIndicator
              from={node.from}
              to={node.to}
              selfReferential={node.selfReferential}
            />
          </div>
        )}

        {/* Types (relationships) */}
        {node.types && node.types.length > 0 && (
          <div className="border-b border-[var(--graph-node-border)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
              Types
            </div>
            <TypeBadgeRow
              types={node.types.map((t) => ({
                label: t.name,
                direction: t.direction,
              }))}
            />
          </div>
        )}

        {/* Fields */}
        {node.fields && node.fields.length > 0 && (
          <div className="border-b border-[var(--graph-node-border)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
              Fields ({node.fields.length})
            </div>
            <FieldList
              fields={node.fields.map((f) => ({
                name: f.name,
                type: f.type,
                value: f.value,
                badge: f.role === 'pk' ? 'pk' : f.role === 'fk' ? 'fk' : f.role === 'required' ? 'required' : f.role === 'nullable' ? 'nullable' : undefined,
                muted: f.system,
              }))}
            />
          </div>
        )}

        {/* Behaviors */}
        {node.behaviors && node.behaviors.length > 0 && (
          <div className="border-b border-[var(--graph-node-border)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
              Behaviors
            </div>
            <BehaviorBadgeRow behaviors={node.behaviors} />
          </div>
        )}

        {/* Flags */}
        {node.flags && node.flags.length > 0 && (
          <div className="border-b border-[var(--graph-node-border)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
              Flags
            </div>
            <div className="flex flex-wrap gap-1">
              {node.flags.map((flag) => (
                <Badge key={flag} label={flag} variant="info" size="sm" />
              ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        {node.metadata && Object.keys(node.metadata).length > 0 && (
          <div className="px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
              Metadata
            </div>
            <div className="space-y-0.5 font-mono text-[var(--graph-font-size-sm)]">
              {Object.entries(node.metadata).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-2">
                  <span className="text-[var(--graph-badge-muted-text)]">{key}</span>
                  <span className="truncate">{String(value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer stats */}
      {(node.fieldCount != null || node.queryCount != null) && (
        <div className="flex gap-3 border-t border-[var(--graph-node-border)] px-3 py-2 text-[var(--graph-font-size-sm)] text-[var(--graph-badge-muted-text)]">
          {node.fieldCount != null && <span>{node.fieldCount} fields</span>}
          {node.queryCount != null && <span>{node.queryCount} queries</span>}
        </div>
      )}
    </div>
  );
}
