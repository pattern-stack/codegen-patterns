import { useMemo } from 'react';
import type { ProjectApiSurface, YamlRef } from '@studio-shared';

import { edgeColor, edgeStyle } from '../graph/edge-kinds';
import { EmptyState, ErrorState, LoadingState, SectionLabel } from '../ui/primitives';
import { apiTabView } from './surface-view';
import type { OriginChip as OriginChipModel, SurfaceRow, SurfaceSection } from './surface-view';

/** The surface as the App holds it — fetched apart from the graph. */
export type SurfaceState =
  | { status: 'loading' }
  | { status: 'ready'; surface: ProjectApiSurface }
  | { status: 'error'; error: { title: string; detail?: string } };

export interface ApiTabProps {
  /** The selected graph node's id, or `null` when nothing is selected. */
  nodeId: string | null;
  surface: SurfaceState;
  onRetry: () => void;
  /** Open the YAML that declared an origin, at its line. */
  onReveal: (ref: YamlRef) => void;
  /** Whether the project has a file for `ref` — a chip without one is not a link. */
  canReveal: (ref: YamlRef) => boolean;
}

/**
 * What the selected entity generates — every repository method, service
 * method, use case, route and include, each with the declaration that caused
 * it (STUDIO-2 §4).
 *
 * Renders `surface-view.ts`'s rows and nothing else: names, kinds and origins
 * are the generator's; labels and order are `surface-kinds.ts`'s.
 */
export function ApiTab({ nodeId, surface, onRetry, onReveal, canReveal }: ApiTabProps) {
  const view = useMemo(
    () => (surface.status === 'ready' && nodeId != null ? apiTabView(surface.surface, nodeId) : null),
    [surface, nodeId],
  );

  // A failed derivation is said first: when the server is gone the graph (and
  // with it the selection) goes too, and "nothing selected" would hide why.
  if (surface.status === 'error') {
    return <ErrorState title={surface.error.title} detail={surface.error.detail} onRetry={onRetry} />;
  }
  if (nodeId == null) {
    return <EmptyState title="Nothing selected" body="Click an entity in the graph to see what it generates." />;
  }
  if (surface.status === 'loading') return <LoadingState label="Deriving the API surface…" />;
  if (view == null) return null;

  if (view.state === 'unmodelled') {
    return (
      <EmptyState
        title={`${view.name} — ${view.headline}`}
        body={
          <>
            The generator does not describe this {view.kindLabel}'s module yet, so there is no surface to show — this
            is not a statement that it generates nothing.
            <br />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{view.reason}</span>
          </>
        }
      />
    );
  }
  if (view.state === 'undescribed') {
    return (
      <EmptyState
        title={`${view.name} is not in the derived surface`}
        body="The surface neither describes this node nor lists it as unmodelled. That is a gap in the derivation, not an empty API."
      />
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--sp-3)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{view.className}</span>
        <span style={{ fontSize: 11.5, color: 'var(--t-muted)' }}>what the generator emits for {view.entity}</span>
      </div>

      {view.warnings.length > 0 && (
        <div
          style={{
            marginBottom: 'var(--sp-3)',
            padding: 'var(--sp-2) var(--sp-3)',
            border: '1px solid var(--warn)',
            borderRadius: 'var(--r-md)',
            color: 'var(--warn)',
            fontSize: 11.5,
          }}
        >
          {view.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {view.sections.map((section) => (
        <Section key={section.id} section={section} onReveal={onReveal} canReveal={canReveal} />
      ))}
    </div>
  );
}

interface LinkProps {
  onReveal: (ref: YamlRef) => void;
  canReveal: (ref: YamlRef) => boolean;
}

function Section({ section, ...link }: { section: SurfaceSection } & LinkProps) {
  const inheritedCount = section.inherited.reduce((n, g) => n + g.rows.length, 0);
  return (
    <section style={{ marginBottom: 'var(--sp-4)' }}>
      <SectionLabel>
        {section.label}
        <span style={{ marginLeft: 'var(--sp-2)', color: 'var(--t-faint)', fontWeight: 500 }}>
          {section.rows.length}
          {inheritedCount > 0 ? ` + ${inheritedCount} inherited` : ''}
        </span>
      </SectionLabel>

      {section.off != null && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: 'var(--sp-2)',
            marginBottom: 'var(--sp-2)',
            borderRadius: 'var(--r-md)',
            background: 'var(--s-raised)',
            fontSize: 12,
            color: 'var(--t-secondary)',
          }}
        >
          <span style={{ fontWeight: 600 }}>{section.off.text}</span>
          {section.off.origin != null && <Chip chip={section.off.origin} {...link} />}
        </div>
      )}

      {section.rows.length === 0 && section.off == null && (
        <div style={{ fontSize: 12, color: 'var(--t-muted)', padding: '0 var(--sp-2)' }}>{section.empty}</div>
      )}

      {section.rows.map((row) => (
        <Row key={row.key} row={row} {...link} />
      ))}

      {section.inherited.map((group) => (
        <details key={group.origin.text} style={{ marginTop: 'var(--sp-2)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--t-muted)', padding: '2px var(--sp-2)' }}>
            Inherited from <Chip chip={group.origin} {...link} /> — {group.rows.length}, not in the generated class
            body
          </summary>
          <div style={{ opacity: 0.75 }}>
            {group.rows.map((row) => (
              <Row key={row.key} row={row} {...link} hideOrigin />
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

function Row({ row, hideOrigin = false, ...link }: { row: SurfaceRow; hideOrigin?: boolean } & LinkProps) {
  return (
    <div
      style={{
        padding: '5px var(--sp-2)',
        borderBottom: '1px solid var(--s-line)',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--t-primary)',
            // The signature is the row's content — it wraps rather than hide
            // its result shape behind an ellipsis.
            overflowWrap: 'anywhere',
          }}
        >
          {row.signature}
        </span>
        {!hideOrigin && row.origin != null && <Chip chip={row.origin} {...link} />}
      </div>

      {(row.kindLabel != null || row.flags.length > 0 || row.calls != null) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-1)', fontSize: 11 }}>
          {row.kindLabel != null && <Tag strong>{row.kindLabel}</Tag>}
          {row.flags.map((f) => (
            <Tag key={f}>{f}</Tag>
          ))}
          {row.calls != null && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--t-muted)' }}>→ {row.calls}</span>
          )}
        </div>
      )}

      {row.shadows.map((shadow) => (
        <div
          key={shadow.text}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            paddingLeft: 'var(--sp-3)',
            fontSize: 11,
            color: 'var(--t-muted)',
          }}
        >
          <span>shadows</span>
          <Chip chip={shadow} {...link} muted />
          <span>— resolved to the same name and lost</span>
        </div>
      ))}
    </div>
  );
}

function Tag({ children, strong = false }: { children: string; strong?: boolean }) {
  return (
    <span
      style={{
        padding: '0 5px',
        borderRadius: 'var(--r-sm)',
        background: strong ? 'var(--accent-soft)' : 'var(--s-raised)',
        color: strong ? 'var(--accent)' : 'var(--t-secondary)',
        lineHeight: '16px',
      }}
    >
      {children}
    </span>
  );
}

/**
 * An origin. A relation origin takes its edge kind's colour, so the chip
 * matches the line on the canvas it explains; every other origin is neutral.
 * A YAML origin is a link to its declaration's line.
 */
function Chip({ chip, onReveal, canReveal, muted = false }: { chip: OriginChipModel; muted?: boolean } & LinkProps) {
  const tint = chip.edgeKind != null ? edgeColor(edgeStyle(chip.edgeKind)) : undefined;
  const ref = chip.yaml;
  const linked = ref != null && canReveal(ref);
  const style = {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 6px',
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: muted ? 'dashed' : 'solid',
    borderColor: tint ?? 'var(--s-line-strong)',
    background: 'transparent',
    color: tint ?? 'var(--t-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    lineHeight: '16px',
    whiteSpace: 'nowrap' as const,
  };

  if (!linked) return <span style={style}>{chip.text}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        // Inside a <summary>, a click would also toggle the group.
        e.preventDefault();
        onReveal(ref);
      }}
      title={`Open the ${ref.doc.kind} ${ref.doc.name} YAML at this declaration`}
      style={{ ...style, cursor: 'pointer' }}
    >
      {chip.text}
    </button>
  );
}
