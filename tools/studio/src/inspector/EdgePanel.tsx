import { useMemo } from 'react';
import type { ProjectApiSurface } from '@studio-shared';

import type { StudioEdgeData } from '../graph/edge-kinds';
import { EmptyState, SectionLabel } from '../ui/primitives';
import { Chip, Row } from './surface-rows';
import type { LinkProps } from './surface-rows';
import { edgePanelView } from './edge-view';
import type { EdgeGroup } from './edge-view';

export interface EdgePanelProps extends LinkProps {
  edge: StudioEdgeData;
  surface: ProjectApiSurface;
}

/**
 * What a selected edge's relation generates (STUDIO-2 §5): its methods on the
 * declaring entity, then on the other, then its inverse's, then the include
 * keys — rows printed from `edge-view.ts`, which reads the edge's
 * `relationId`, never its id.
 *
 * A relation chip takes its edge kind's colour, so the heading matches the
 * line that was clicked. A junction half, or a relation the surface does not
 * list, reads as such — never as an empty list.
 */
export function EdgePanel({ edge, surface, ...link }: EdgePanelProps) {
  const view = useMemo(() => edgePanelView(surface, edge), [surface, edge]);

  if (view.state === 'noRelation' || view.state === 'undescribed') {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 'var(--sp-3) var(--sp-3) 0' }}>
          <TreeRole edge={edge} />
        </div>
        <EmptyState title={view.title} body={view.body} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--sp-3)' }}>
      <TreeRole edge={edge} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          marginBottom: 'var(--sp-3)',
        }}
      >
        <Chip chip={view.relation} {...link} />
        <span style={{ fontSize: 11.5, color: 'var(--t-muted)' }}>
          {view.from} → {view.to} — what this relation generates
        </span>
      </div>

      {view.groups.map((group) => (
        <Group key={group.id} group={group} {...link} />
      ))}
    </div>
  );
}

/**
 * The line's place in the tree and why — `spine: on_delete: cascade` — exactly as
 * the adapter wrote it on the line (`treeReason`); the canvas tooltip prints
 * the same string.
 */
function TreeRole({ edge }: { edge: StudioEdgeData }) {
  return (
    <div
      data-testid="edge-tree-role"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--t-secondary)',
        marginBottom: 'var(--sp-2)',
      }}
    >
      {edge.treeReason}
    </div>
  );
}

function Group({ group, ...link }: { group: EdgeGroup } & LinkProps) {
  return (
    <section style={{ marginBottom: 'var(--sp-4)' }}>
      <SectionLabel>
        {group.heading}
        <span style={{ marginLeft: 'var(--sp-2)', color: 'var(--t-faint)', fontWeight: 500 }}>{group.rows.length}</span>
      </SectionLabel>
      {group.chip != null && (
        <div style={{ padding: '0 var(--sp-2) var(--sp-2)' }}>
          <Chip chip={group.chip} {...link} />
        </div>
      )}
      {group.rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--t-muted)', padding: '0 var(--sp-2)' }}>{group.empty}</div>
      )}
      {group.rows.map((row) => (
        <Row key={row.key} row={row} {...link} />
      ))}
    </section>
  );
}
