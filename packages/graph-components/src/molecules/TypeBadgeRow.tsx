import { useState } from 'react';
import type { TypeBadgeRowProps } from '../types/component-props.js';
import { TypePill } from '../atoms/TypePill.js';

export function TypeBadgeRow({ types, maxVisible }: TypeBadgeRowProps) {
  const [expanded, setExpanded] = useState(false);

  const visible = !expanded && maxVisible ? types.slice(0, maxVisible) : types;
  const remaining = types.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((typePill) => (
        <TypePill key={typePill.label} {...typePill} />
      ))}
      {remaining > 0 && !expanded && (
        <button
          type="button"
          className="text-[var(--graph-font-size-sm)] text-[var(--graph-badge-primary-text)] hover:underline"
          onClick={() => setExpanded(true)}
        >
          +{remaining} more
        </button>
      )}
    </div>
  );
}
