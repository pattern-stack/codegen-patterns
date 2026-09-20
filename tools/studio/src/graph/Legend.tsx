import { EDGE_KIND_ORDER, EDGE_KIND_STYLES } from './edge-kinds';

/**
 * The graph legend, generated from `edge-kinds` rather than written beside it.
 * A legend maintained by hand drifts from the canvas the first time a kind
 * changes colour; this one cannot.
 */
export function Legend() {
  return (
    <div
      style={{
        position: 'absolute',
        left: 'var(--sp-3)',
        bottom: 'var(--sp-3)',
        zIndex: 5,
        background: 'color-mix(in srgb, var(--s-chrome) 92%, transparent)',
        border: '1px solid var(--s-line)',
        borderRadius: 'var(--r-lg)',
        padding: 'var(--sp-3)',
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'var(--t-muted)',
          marginBottom: 'var(--sp-2)',
        }}
      >
        Edges
      </div>
      <div style={{ display: 'grid', gap: 5 }}>
        {EDGE_KIND_ORDER.map((kind) => {
          const style = EDGE_KIND_STYLES[kind];
          return (
            <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
              <svg width={26} height={8} aria-hidden style={{ flex: '0 0 auto' }}>
                <line
                  x1={0}
                  y1={4}
                  x2={26}
                  y2={4}
                  stroke={style.color}
                  strokeWidth={style.width}
                  strokeDasharray={style.dash}
                />
              </svg>
              <span
                style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--t-secondary)' }}
              >
                {style.label}
              </span>
              <span style={{ fontSize: 10, color: 'var(--t-muted)' }}>{style.description}</span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 'var(--sp-4)',
          marginTop: 'var(--sp-3)',
          paddingTop: 'var(--sp-2)',
          borderTop: '1px solid var(--s-line)',
        }}
      >
        {[
          { glyph: '▣', label: 'entity', color: 'var(--graph-entity-color)' },
          { glyph: '◇', label: 'junction', color: 'var(--graph-relationship-color)' },
        ].map((n) => (
          <div key={n.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <span style={{ color: n.color, fontSize: 11 }}>{n.glyph}</span>
            <span style={{ fontSize: 10.5, color: 'var(--t-secondary)' }}>{n.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
