import type { GraphNodeProps } from '../types/component-props.js';
import { NodeHeader } from '../molecules/NodeHeader.js';
import { FieldList } from '../molecules/FieldList.js';
import { BehaviorBadgeRow } from '../molecules/BehaviorBadgeRow.js';
import { TypeBadgeRow } from '../molecules/TypeBadgeRow.js';
import { DirectionIndicator } from '../atoms/DirectionIndicator.js';
import { Badge } from '../atoms/Badge.js';

function EntityContent({ data, compact }: Pick<GraphNodeProps, 'data' | 'compact'>) {
  return (
    <>
      {data.fields && data.fields.length > 0 && (
        <div className="border-t border-[var(--graph-node-border)] px-2 py-1.5">
          <FieldList
            fields={data.fields.map((f) => ({
              name: f.name,
              type: f.type,
              badge: f.role === 'pk' ? 'pk' : f.role === 'fk' ? 'fk' : f.role === 'required' ? 'required' : f.role === 'nullable' ? 'nullable' : undefined,
              muted: f.system,
            }))}
            maxVisible={compact ? 3 : 8}
            compact={compact}
          />
        </div>
      )}
      {data.behaviors && data.behaviors.length > 0 && (
        <div className="border-t border-[var(--graph-node-border)] px-2 py-1.5">
          <BehaviorBadgeRow behaviors={data.behaviors} />
        </div>
      )}
    </>
  );
}

function RelationshipContent({ data, compact }: Pick<GraphNodeProps, 'data' | 'compact'>) {
  return (
    <>
      {data.from && data.to && (
        <div className="border-t border-[var(--graph-node-border)] px-2 py-1.5">
          <DirectionIndicator
            from={data.from}
            to={data.to}
            selfReferential={data.selfReferential}
          />
        </div>
      )}
      {data.types && data.types.length > 0 && (
        <div className="border-t border-[var(--graph-node-border)] px-2 py-1.5">
          <TypeBadgeRow
            types={data.types.map((t) => ({
              label: t.name,
              direction: t.direction,
            }))}
            maxVisible={compact ? 2 : undefined}
          />
        </div>
      )}
      {data.flags && data.flags.length > 0 && (
        <div className="border-t border-[var(--graph-node-border)] px-2 py-1.5 flex flex-wrap gap-1">
          {data.flags.map((flag) => (
            <Badge key={flag} label={flag} variant="info" size="sm" />
          ))}
        </div>
      )}
    </>
  );
}

function RecordContent({ data, compact }: Pick<GraphNodeProps, 'data' | 'compact'>) {
  return (
    <>
      {data.fields && data.fields.length > 0 && (
        <div className="border-t border-[var(--graph-node-border)] px-2 py-1.5">
          <FieldList
            fields={data.fields.map((f) => ({
              name: f.name,
              value: f.value,
              type: f.type,
              muted: f.system,
            }))}
            maxVisible={compact ? 3 : 8}
            compact={compact}
          />
        </div>
      )}
    </>
  );
}

const kindIcon = {
  entity: 'entity',
  relationship: 'relationship',
  record: 'person',
} as const;

const kindBorderColor = {
  entity: 'var(--graph-entity-color)',
  relationship: 'var(--graph-relationship-color)',
  record: 'var(--graph-record-color)',
} as const;

export function GraphNode<T = unknown>({
  data,
  selected,
  dimmed,
  compact,
  onClick,
  onHover,
}: GraphNodeProps<T>) {
  const borderColor = selected
    ? 'var(--graph-node-selected-border)'
    : kindBorderColor[data.kind];

  return (
    <div
      className={`min-w-[180px] max-w-[280px] rounded-lg border bg-[var(--graph-node-bg)] font-[var(--graph-font-family)] shadow-sm transition-all ${
        dimmed ? 'opacity-40' : ''
      } ${onClick ? 'cursor-pointer' : ''}`}
      style={{ borderColor }}
      onClick={onClick}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <NodeHeader
        icon={kindIcon[data.kind]}
        label={data.label}
        subtitle={data.subtitle}
        badge={
          data.group
            ? { label: data.group, variant: 'muted' as const }
            : undefined
        }
        selected={selected}
      />
      {data.kind === 'entity' && <EntityContent data={data} compact={compact} />}
      {data.kind === 'relationship' && <RelationshipContent data={data} compact={compact} />}
      {data.kind === 'record' && <RecordContent data={data} compact={compact} />}
      {(data.fieldCount != null || data.queryCount != null) && (
        <div className="flex gap-2 border-t border-[var(--graph-node-border)] px-2 py-1 text-[10px] text-[var(--graph-badge-muted-text)]">
          {data.fieldCount != null && <span>{data.fieldCount} fields</span>}
          {data.queryCount != null && <span>{data.queryCount} queries</span>}
        </div>
      )}
    </div>
  );
}
