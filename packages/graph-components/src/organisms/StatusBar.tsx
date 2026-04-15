import type { StatusBarProps } from '../types/component-props.js';

export function StatusBar({ stats, warnings }: StatusBarProps) {
  return (
    <div className="flex items-center justify-between border-t border-[var(--graph-node-border)] bg-[var(--graph-panel-bg)] px-3 py-1.5 text-[var(--graph-font-size-sm)]">
      <div className="flex items-center gap-3">
        {stats.map((stat) => (
          <span key={stat.label} className="text-[var(--graph-badge-muted-text)]">
            <span className="font-medium">{stat.value}</span>{' '}
            <span>{stat.label}</span>
          </span>
        ))}
      </div>
      {warnings && warnings.length > 0 && (
        <div className="flex items-center gap-1 text-[var(--graph-badge-warning-text)]">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{warnings.length} warning{warnings.length !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
}
