import type { GraphLegendProps } from '../types/component-props.js';
import { Icon } from '../atoms/Icon.js';

const positionClasses: Record<NonNullable<GraphLegendProps['position']>, string> = {
  'bottom-left': 'bottom-3 left-3',
  'bottom-right': 'bottom-3 right-3',
  'top-left': 'top-3 left-3',
  'top-right': 'top-3 right-3',
};

export function GraphLegend({ items, position = 'bottom-left' }: GraphLegendProps) {
  if (items.length === 0) return null;

  return (
    <div
      className={`absolute ${positionClasses[position]} rounded-lg border border-[var(--graph-node-border)] bg-[var(--graph-panel-bg)] px-3 py-2 shadow-sm`}
    >
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-2 text-[var(--graph-font-size-sm)]">
            <span style={{ color: item.color }}>
              <Icon name={item.icon} size="sm" />
            </span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
