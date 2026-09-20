/**
 * The shared control vocabulary.
 *
 * Every pane draws from these so spacing, type and focus behave the same
 * everywhere. Styling is inline against the tokens in `index.css` rather than
 * utility classes, because these sit next to `@xyflow/react` and CodeMirror,
 * both of which inject their own stylesheets.
 */
import type { CSSProperties, ReactNode } from 'react';

// ── Button ──────────────────────────────────────────────────────────────────

export type ButtonTone = 'default' | 'primary' | 'danger' | 'ghost';

const buttonTones: Record<ButtonTone, CSSProperties> = {
  default: { background: 'var(--s-raised)', color: 'var(--t-primary)', borderColor: 'var(--s-line-strong)' },
  primary: { background: 'var(--accent-strong)', color: '#04122b', borderColor: 'var(--accent-strong)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)', borderColor: 'var(--danger)' },
  ghost: { background: 'transparent', color: 'var(--t-secondary)', borderColor: 'transparent' },
};

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  size?: 'sm' | 'md';
  title?: string;
  type?: 'button' | 'submit';
  /** Rendered before the label — a glyph, a spinner, a status dot. */
  icon?: ReactNode;
  style?: CSSProperties;
}

export function Button({
  children,
  onClick,
  tone = 'default',
  disabled,
  size = 'md',
  title,
  type = 'button',
  icon,
  style,
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        height: size === 'sm' ? 24 : 30,
        padding: size === 'sm' ? '0 var(--sp-2)' : '0 var(--sp-3)',
        borderRadius: 'var(--r-md)',
        // Longhand: the tone below supplies `borderColor`, and mixing it with
        // the `border` shorthand lets the two disagree across a rerender.
        borderWidth: 1,
        borderStyle: 'solid',
        fontFamily: 'inherit',
        fontSize: size === 'sm' ? 11.5 : 12.5,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 120ms ease, border-color 120ms ease',
        ...buttonTones[tone],
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export interface TabSpec<Id extends string> {
  id: Id;
  label: string;
  /** Small count or status shown after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<Id extends string> {
  tabs: readonly TabSpec<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Rendered at the right end of the bar. */
  trailing?: ReactNode;
}

export function Tabs<Id extends string>({ tabs, active, onSelect, trailing }: TabsProps<Id>) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 'var(--h-tabbar)',
        flex: '0 0 var(--h-tabbar)',
        borderBottom: '1px solid var(--s-line)',
        background: 'var(--s-chrome)',
        paddingInline: 'var(--sp-2)',
        gap: 'var(--sp-1)',
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            disabled={tab.disabled}
            onClick={() => onSelect(tab.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--sp-2)',
              background: 'transparent',
              border: 'none',
              // The indicator is an inset shadow rather than a border, so
              // switching tabs cannot move the text by a pixel.
              boxShadow: isActive ? 'inset 0 -2px 0 var(--accent)' : 'none',
              color: isActive ? 'var(--t-primary)' : 'var(--t-muted)',
              cursor: tab.disabled ? 'not-allowed' : 'pointer',
              opacity: tab.disabled ? 0.4 : 1,
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: isActive ? 600 : 500,
              padding: '0 var(--sp-3)',
            }}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
      {trailing != null && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          {trailing}
        </div>
      )}
    </div>
  );
}

// ── Counter badge ───────────────────────────────────────────────────────────

export function CountBadge({ count, tone = 'default' }: { count: number; tone?: 'default' | 'danger' }) {
  if (count <= 0) return null;
  return (
    <span
      style={{
        minWidth: 16,
        padding: '0 4px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        textAlign: 'center',
        background: tone === 'danger' ? 'var(--danger-soft)' : 'var(--s-raised)',
        color: tone === 'danger' ? 'var(--danger)' : 'var(--t-secondary)',
      }}
    >
      {count}
    </span>
  );
}

// ── Section heading ─────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: 'var(--t-muted)',
        marginBottom: 'var(--sp-2)',
      }}
    >
      {children}
    </div>
  );
}

// ── Form controls ───────────────────────────────────────────────────────────

const fieldStyle: CSSProperties = {
  width: '100%',
  height: 28,
  padding: '0 var(--sp-2)',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--s-line-strong)',
  background: 'var(--s-canvas)',
  color: 'var(--t-primary)',
  fontFamily: 'inherit',
  fontSize: 12.5,
};

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 'var(--sp-3)' }}>
      <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--t-secondary)', marginBottom: 'var(--sp-1)' }}>
        {label}
      </div>
      {children}
      {hint != null && (
        <div style={{ fontSize: 11, color: 'var(--t-muted)', marginTop: 'var(--sp-1)' }}>{hint}</div>
      )}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  monospace,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...fieldStyle, fontFamily: monospace ? 'var(--font-mono)' : 'inherit' }}
    />
  );
}

export function Select({
  value,
  onChange,
  choices,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: readonly { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...fieldStyle, cursor: 'pointer' }}
    >
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        fontSize: 12.5,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-5)',
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: '2px solid var(--s-line-strong)',
        borderTopColor: 'var(--accent)',
        animation: 'studio-spin 700ms linear infinite',
      }}
    />
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <Centered>
      <Spinner size={20} />
      <div style={{ color: 'var(--t-secondary)' }}>{label}</div>
    </Centered>
  );
}

export function EmptyState({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <Centered>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-secondary)' }}>{title}</div>
      {body != null && (
        <div style={{ fontSize: 12, color: 'var(--t-muted)', maxWidth: 380, lineHeight: 1.6 }}>{body}</div>
      )}
    </Centered>
  );
}

export function ErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <Centered>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>{title}</div>
      {detail != null && detail !== '' && (
        <pre
          style={{
            margin: 0,
            maxWidth: 480,
            maxHeight: 180,
            overflow: 'auto',
            textAlign: 'left',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--t-muted)',
            background: 'var(--s-canvas)',
            border: '1px solid var(--s-line)',
            borderRadius: 'var(--r-md)',
            padding: 'var(--sp-3)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {detail}
        </pre>
      )}
      {onRetry != null && (
        <Button onClick={onRetry} tone="primary">
          Retry
        </Button>
      )}
    </Centered>
  );
}

/** A small coloured dot — run status, connection status, diff status. */
export function Dot({ color, title }: { color: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flex: '0 0 auto',
      }}
    />
  );
}
