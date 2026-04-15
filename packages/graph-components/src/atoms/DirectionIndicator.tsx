import type { DirectionIndicatorProps } from '../types/component-props.js';

export function DirectionIndicator({ from, to, selfReferential }: DirectionIndicatorProps) {
  if (selfReferential) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--graph-font-size-sm)] text-[var(--graph-badge-muted-text)]">
        <span className="font-medium">{from}</span>
        <span>&#8634;</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-[var(--graph-font-size-sm)] text-[var(--graph-badge-muted-text)]">
      <span className="font-medium">{from}</span>
      <span>&rarr;</span>
      <span className="font-medium">{to}</span>
    </span>
  );
}
