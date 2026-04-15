import type { SearchFilterBarProps } from '../types/component-props.js';

export function SearchFilterBar({
  query,
  onQueryChange,
  filters,
  onFilterToggle,
}: SearchFilterBarProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--graph-node-border)] bg-[var(--graph-panel-bg)] px-3 py-2">
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search..."
        className="min-w-0 flex-1 bg-transparent text-[var(--graph-font-size-md)] outline-none placeholder:text-[var(--graph-badge-muted-text)]"
      />
      {filters.length > 0 && (
        <div className="flex items-center gap-1 border-l border-[var(--graph-node-border)] pl-2">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => onFilterToggle(filter.key)}
              className={`rounded-md px-2 py-0.5 text-[var(--graph-font-size-sm)] font-medium transition-colors ${
                filter.active
                  ? 'bg-[var(--graph-badge-primary-bg)] text-[var(--graph-badge-primary-text)]'
                  : 'text-[var(--graph-badge-muted-text)] hover:bg-[var(--graph-badge-default-bg)]'
              }`}
            >
              {filter.label}
              {filter.count != null && (
                <span className="ml-1 opacity-60">{filter.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
