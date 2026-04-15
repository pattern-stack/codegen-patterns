import { useState } from 'react';
import type { FieldListProps, FieldRowProps } from '../types/component-props.js';
import { FieldRow } from '../atoms/FieldRow.js';

export function FieldList({ fields, groups, maxVisible, compact }: FieldListProps) {
  const [expanded, setExpanded] = useState(false);

  const renderFields = (items: FieldRowProps[]) => {
    const visible = !expanded && maxVisible ? items.slice(0, maxVisible) : items;
    const remaining = items.length - visible.length;

    return (
      <>
        {visible.map((field) => (
          <FieldRow key={field.name} {...field} />
        ))}
        {remaining > 0 && !expanded && (
          <button
            type="button"
            className="w-full px-1 py-0.5 text-left text-[var(--graph-font-size-sm)] text-[var(--graph-badge-primary-text)] hover:underline"
            onClick={() => setExpanded(true)}
          >
            +{remaining} more
          </button>
        )}
      </>
    );
  };

  return (
    <div className={`flex flex-col ${compact ? 'gap-0' : 'gap-0.5'}`}>
      {groups ? (
        groups.map((group) => {
          const groupFields = fields.filter(group.filter);
          if (groupFields.length === 0) return null;
          return (
            <div key={group.label}>
              <div className="px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--graph-badge-muted-text)]">
                {group.label}
              </div>
              {renderFields(groupFields)}
            </div>
          );
        })
      ) : (
        renderFields(fields)
      )}
    </div>
  );
}
