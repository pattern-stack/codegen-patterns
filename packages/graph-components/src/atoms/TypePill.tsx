import type { TypePillProps } from '../types/component-props.js';

const directionSymbols: Record<NonNullable<TypePillProps['direction']>, string> = {
  directed: '\u2192',
  bidirectional: '\u2194',
  inverse: '\u2190',
};

export function TypePill({ label, direction, active, onClick }: TypePillProps) {
  const base =
    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[var(--graph-font-size-sm)] font-medium transition-colors';
  const interactive = onClick ? 'cursor-pointer hover:opacity-80' : '';
  const activeClass = active
    ? 'bg-[var(--graph-badge-primary-bg)] text-[var(--graph-badge-primary-text)] border-[var(--graph-badge-primary-border)]'
    : 'bg-[var(--graph-badge-default-bg)] text-[var(--graph-badge-default-text)] border-[var(--graph-badge-default-border)]';

  return (
    <button
      type="button"
      className={`${base} ${activeClass} ${interactive}`}
      onClick={onClick}
      disabled={!onClick}
    >
      {direction && (
        <span className="text-[10px]">{directionSymbols[direction]}</span>
      )}
      {label}
    </button>
  );
}
