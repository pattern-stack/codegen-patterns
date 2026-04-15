import type { FieldRowProps } from '../types/component-props.js';

const badgeLabels: Record<NonNullable<FieldRowProps['badge']>, string> = {
  pk: 'PK',
  fk: 'FK',
  required: 'req',
  nullable: 'null',
  unique: 'uniq',
  indexed: 'idx',
};

export function FieldRow({ name, type, value, badge, muted }: FieldRowProps) {
  return (
    <div
      className={`flex items-center gap-2 py-0.5 px-1 font-[var(--graph-font-family)] text-[var(--graph-font-size-sm)] ${
        muted ? 'opacity-50' : ''
      }`}
    >
      {badge && (
        <span className="shrink-0 rounded bg-[var(--graph-badge-muted-bg)] px-1 text-[10px] font-mono text-[var(--graph-badge-muted-text)]">
          {badgeLabels[badge]}
        </span>
      )}
      <span className="font-mono font-medium truncate">{name}</span>
      {type && (
        <span className="ml-auto shrink-0 font-mono text-[var(--graph-badge-muted-text)]">
          {type}
        </span>
      )}
      {value && !type && (
        <span className="ml-auto shrink-0 truncate text-[var(--graph-badge-default-text)]">
          {value}
        </span>
      )}
    </div>
  );
}
