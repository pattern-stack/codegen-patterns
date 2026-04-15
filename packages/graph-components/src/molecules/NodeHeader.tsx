import type { NodeHeaderProps } from '../types/component-props.js';
import { Icon } from '../atoms/Icon.js';
import { Badge } from '../atoms/Badge.js';

export function NodeHeader({ icon, label, badge, subtitle, selected }: NodeHeaderProps) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 ${
        selected ? 'border-l-2 border-l-[var(--graph-node-selected-border)]' : ''
      }`}
    >
      <Icon name={icon} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-[var(--graph-font-size-md)]">{label}</span>
          {badge && <Badge {...badge} />}
        </div>
        {subtitle && (
          <span className="block truncate text-[var(--graph-font-size-sm)] text-[var(--graph-badge-muted-text)]">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}
