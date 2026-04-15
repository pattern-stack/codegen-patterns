import type { BadgeProps } from '../types/component-props.js';

const variantClasses: Record<BadgeProps['variant'], string> = {
  default:
    'bg-[var(--graph-badge-default-bg)] text-[var(--graph-badge-default-text)] border-[var(--graph-badge-default-border)]',
  primary:
    'bg-[var(--graph-badge-primary-bg)] text-[var(--graph-badge-primary-text)] border-[var(--graph-badge-primary-border)]',
  success:
    'bg-[var(--graph-badge-success-bg)] text-[var(--graph-badge-success-text)] border-[var(--graph-badge-success-border)]',
  warning:
    'bg-[var(--graph-badge-warning-bg)] text-[var(--graph-badge-warning-text)] border-[var(--graph-badge-warning-border)]',
  error:
    'bg-[var(--graph-badge-error-bg)] text-[var(--graph-badge-error-text)] border-[var(--graph-badge-error-border)]',
  info:
    'bg-[var(--graph-badge-info-bg)] text-[var(--graph-badge-info-text)] border-[var(--graph-badge-info-border)]',
  muted:
    'bg-[var(--graph-badge-muted-bg)] text-[var(--graph-badge-muted-text)] border-[var(--graph-badge-muted-border)]',
};

const sizeClasses: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-[var(--graph-font-size-sm)]',
  md: 'px-2 py-0.5 text-[var(--graph-font-size-md)]',
};

export function Badge({ label, variant, size = 'sm', icon }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium leading-none ${variantClasses[variant]} ${sizeClasses[size]}`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {label}
    </span>
  );
}
