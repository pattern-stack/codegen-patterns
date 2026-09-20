import { useEffect, useRef, useState } from 'react';
import { EDGE_KIND_ORDER, EDGE_KIND_STYLES } from './edge-kinds';

const NODE_KINDS = [
  { glyph: '▣', label: 'entity', color: 'var(--graph-entity-color)' },
  { glyph: '◇', label: 'junction', color: 'var(--graph-relationship-color)' },
];

/**
 * The graph legend, generated from `edge-kinds` rather than written beside it.
 * A legend maintained by hand drifts from the canvas the first time a kind
 * changes colour; this one cannot.
 *
 * It collapses to a chip, because expanded it covers the bottom-left of the
 * canvas — on a short viewport that is a node the reader wanted to see. The
 * swatches stay visible while collapsed, so the chip is still a key.
 *
 * `roomy` decides the default. On a laptop canvas the expanded panel took a
 * third of the height and sat on top of the junction card, which is the node a
 * relations demo exists to show — so there it starts collapsed. Once the reader
 * has toggled it themselves that choice sticks, including across resizes:
 * a panel that re-opened every time the window changed would be worse than one
 * that opened in the wrong place once.
 */
export function Legend({ roomy }: { roomy: boolean }) {
  const [open, setOpen] = useState(roomy);
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) setOpen(roomy);
  }, [roomy]);

  return (
    <div
      style={{
        position: 'absolute',
        left: 'var(--sp-3)',
        bottom: 'var(--sp-3)',
        zIndex: 5,
        background: 'color-mix(in srgb, var(--s-chrome) 92%, transparent)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--s-line)',
        borderRadius: 'var(--r-lg)',
        backdropFilter: 'blur(6px)',
        maxWidth: 380,
      }}
    >
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          width: '100%',
          padding: 'var(--sp-2) var(--sp-3)',
          background: 'transparent',
          border: 'none',
          color: 'var(--t-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}
      >
        <span>Legend</span>
        {/* Collapsed, the swatches are the legend — the chip still reads as a
            key rather than as a button that hid one. */}
        {!open && (
          <span style={{ display: 'flex', gap: 3 }} aria-hidden>
            {EDGE_KIND_ORDER.map((kind) => (
              <svg key={kind} width={12} height={8}>
                <line
                  x1={0}
                  y1={4}
                  x2={12}
                  y2={4}
                  stroke={EDGE_KIND_STYLES[kind].color}
                  strokeWidth={EDGE_KIND_STYLES[kind].width}
                  strokeDasharray={EDGE_KIND_STYLES[kind].dash}
                />
              </svg>
            ))}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>{open ? '▾' : '▴'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 var(--sp-3) var(--sp-3)' }}>
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
                    style={{
                      flex: '0 0 auto',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'var(--t-secondary)',
                    }}
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
            {NODE_KINDS.map((n) => (
              <div key={n.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
                <span style={{ color: n.color, fontSize: 11 }}>{n.glyph}</span>
                <span style={{ fontSize: 10.5, color: 'var(--t-secondary)' }}>{n.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
