import { useMemo } from 'react';
import type { ProjectApiSurface, YamlRef } from '@studio-shared';

import type { StudioEdgeData } from '../graph/edge-kinds';
import { EdgePanel } from './EdgePanel';
import { EmptyState, ErrorState, LoadingState, SectionLabel } from '../ui/primitives';
import { apiTabView } from './surface-view';
import type { SurfaceSection } from './surface-view';
import { Chip, Row } from './surface-rows';
import type { LinkProps } from './surface-rows';

/** The surface as the App holds it — fetched apart from the graph. */
export type SurfaceState =
  | { status: 'loading' }
  | { status: 'ready'; surface: ProjectApiSurface }
  | { status: 'error'; error: { title: string; detail?: string } };

export interface ApiTabProps {
  /** The selected graph node's id, or `null` when nothing is selected. */
  nodeId: string | null;
  /** The selected edge — the tab shows what its relation generates (STUDIO-2 §5). */
  edge?: StudioEdgeData | null;
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
export function ApiTab({ nodeId, edge = null, surface, onRetry, onReveal, canReveal }: ApiTabProps) {
  const view = useMemo(
    () => (surface.status === 'ready' && nodeId != null ? apiTabView(surface.surface, nodeId) : null),
    [surface, nodeId],
  );

  // A failed derivation is said first: when the server is gone the graph (and
  // with it the selection) goes too, and "nothing selected" would hide why.
  if (surface.status === 'error') {
    return <ErrorState title={surface.error.title} detail={surface.error.detail} onRetry={onRetry} />;
  }
  if (nodeId == null && edge == null) {
    return (
      <EmptyState
        title="Nothing selected"
        body="Click an entity in the graph to see what it generates, or an edge to see what its relation generates."
      />
    );
  }
  if (surface.status === 'loading') return <LoadingState label="Deriving the API surface…" />;
  if (edge != null) {
    return <EdgePanel edge={edge} surface={surface.surface} onReveal={onReveal} canReveal={canReveal} />;
  }
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
