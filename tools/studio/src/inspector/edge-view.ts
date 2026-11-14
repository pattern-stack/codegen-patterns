/**
 * The edge panel's view model — a drawn edge's relation turned into rows the
 * panel can print without deciding anything (STUDIO-2 §5).
 *
 * The edge carries `relationId`, set where the adapter built it; the surface
 * keys `relations` by the same string. Groups, labels and order come from
 * `surface-kinds.ts`; each row is the entity surface's own entry for the
 * method, so a method reads the same here as on the API tab.
 *
 * Pure: no React, no DOM, no network. Unit-tested in
 * `../__tests__/edge-view.test.ts` against real `project surface --json`
 * payloads of the demo.
 */
import type { EntityApiSurface, ProjectApiSurface, RelationApiSurface, YamlRef } from '@studio-shared';

import type { StudioEdgeData, StudioEdgeKind } from '../graph/edge-kinds';
import {
  EDGE_GROUPS,
  EDGE_INVERSE_MISSING,
  EDGE_METHOD_MISSING,
  EDGE_PANEL_STATES,
  REPOSITORY_KINDS,
  SERVICE_KINDS,
} from './surface-kinds';
import type { EdgeGroupId } from './surface-kinds';
import { methodRefText, originChip, signature } from './surface-view';
import type { OriginChip, SurfaceRow } from './surface-view';

type MethodRef = RelationApiSurface['generates'][number];

export interface EdgeGroup {
  id: EdgeGroupId;
  /** `on contact`, `inverse`, `Include keys`. */
  heading: string;
  /** The heading's relation chip, for the inverse group. */
  chip?: OriginChip;
  rows: SurfaceRow[];
  empty: string;
}

export type EdgePanelView =
  | { state: 'relation'; relation: OriginChip; from: string; to: string; groups: EdgeGroup[] }
  | { state: 'noRelation'; title: string; body: string }
  | { state: 'undescribed'; relationId: string; title: string; body: string };

/** The panel's edge — only what it reads off a drawn edge. */
export type PanelEdge = Pick<StudioEdgeData, 'relationId'>;

// ── Rows ────────────────────────────────────────────────────────────────────

type GeneratedMethod = Pick<
  EntityApiSurface['repository']['methods'][number] | EntityApiSurface['service']['methods'][number],
  'name' | 'params' | 'returns' | 'origin'
>;

/** The entity surface's own entry for a generated method, with its kind's label. */
function lookup(surface: ProjectApiSurface, ref: MethodRef): { m: GeneratedMethod; kindLabel: string } | undefined {
  const entity: EntityApiSurface | undefined = surface.entities[ref.entity];
  if (ref.layer === 'repository') {
    const m = entity?.repository.methods.find((x) => x.name === ref.method);
    return m ? { m, kindLabel: REPOSITORY_KINDS[m.kind].label } : undefined;
  }
  const m = entity?.service.methods.find((x) => x.name === ref.method);
  return m ? { m, kindLabel: SERVICE_KINDS[m.kind].label } : undefined;
}

/** One generated method, as its entity's surface describes it. */
function methodRow(surface: ProjectApiSurface, ref: MethodRef): SurfaceRow {
  const key = `edge.${methodRefText(ref)}`;
  const found = lookup(surface, ref);
  if (!found) {
    return { key, name: ref.method, signature: ref.method, flags: [EDGE_METHOD_MISSING], calls: methodRefText(ref), shadows: [] };
  }
  const { m, kindLabel } = found;
  return {
    key,
    name: m.name,
    signature: signature(m.name, m.params, m.returns),
    kindLabel,
    flags: [],
    calls: methodRefText(ref),
    origin: originChip(surface, m.origin),
    shadows: [],
  };
}

function includeRow(owner: string, inc: RelationApiSurface['includeKeys'][number]): SurfaceRow {
  return {
    key: `edge.include.${owner}.${inc.table}.${inc.key}`,
    name: `${inc.table}.${inc.key}`,
    signature: `${inc.table}.${inc.key}`,
    flags: [],
    calls: owner,
    shadows: [],
  };
}

// ── The relation chip ───────────────────────────────────────────────────────

/**
 * The declaration a relation came from, read off the provenance of a method it
 * generates on its declaring entity — the derivation's own answer, so the
 * relation id is never taken apart to rebuild a YAML path.
 */
function declarationOf(surface: ProjectApiSurface, relation: RelationApiSurface): YamlRef | undefined {
  for (const ref of relation.generates) {
    const origin = lookup(surface, ref)?.m.origin;
    if (origin?.from === 'yaml' && origin.at.doc.kind === 'entity' && origin.at.doc.name === relation.from) {
      return origin.at;
    }
  }
  return undefined;
}

/** A relation as a chip: its id, its edge kind's colour, a link to its declaration. */
export function relationChip(surface: ProjectApiSurface, relation: RelationApiSurface): OriginChip {
  const yaml = declarationOf(surface, relation);
  const edgeKind: StudioEdgeKind = relation.kind;
  return { kind: 'yaml', text: relation.id, edgeKind, ...(yaml ? { yaml } : {}) };
}

// ── The panel ───────────────────────────────────────────────────────────────

function group(id: EdgeGroupId, subject: string, rows: SurfaceRow[], extra: Partial<EdgeGroup> = {}): EdgeGroup {
  const d = EDGE_GROUPS[id];
  return { id, heading: subject === '' ? d.label : `${d.label} ${subject}`, rows, empty: d.empty, ...extra };
}

/**
 * What the panel shows for a drawn edge.
 *
 * A junction half carries no `relationId` and reads as such. An inline edge
 * whose relation the surface does not list is `undescribed` — never an empty
 * method list, which would read as "this relation generates nothing".
 */
export function edgePanelView(surface: ProjectApiSurface, edge: PanelEdge): EdgePanelView {
  if (edge.relationId == null) return { state: 'noRelation', ...EDGE_PANEL_STATES.noRelation };

  const relation = surface.relations.find((r) => r.id === edge.relationId);
  if (!relation) {
    const d = EDGE_PANEL_STATES.undescribed;
    return { state: 'undescribed', relationId: edge.relationId, title: `${edge.relationId} ${d.title}`, body: d.body };
  }

  const inverse = relation.inverseOf != null ? surface.relations.find((r) => r.id === relation.inverseOf) : undefined;
  const own = relation.generates.map((ref) => ({ ref, row: methodRow(surface, ref) }));

  const groups: Record<EdgeGroupId, EdgeGroup> = {
    declaring: group(
      'declaring',
      relation.from,
      own.filter(({ ref }) => ref.entity === relation.from).map(({ row }) => row),
    ),
    other: group(
      'other',
      relation.to,
      own.filter(({ ref }) => ref.entity !== relation.from).map(({ row }) => row),
    ),
    inverse:
      relation.inverseOf == null
        ? group('inverse', '', [])
        : inverse == null
          ? group('inverse', relation.inverseOf, [], { empty: `${relation.inverseOf} ${EDGE_INVERSE_MISSING}` })
          : group(
              'inverse',
              '',
              inverse.generates.map((ref) => methodRow(surface, ref)),
              { chip: relationChip(surface, inverse) },
            ),
    includes: group('includes', '', [
      ...relation.includeKeys.map((inc) => includeRow(relation.id, inc)),
      ...(inverse ? inverse.includeKeys.map((inc) => includeRow(inverse.id, inc)) : []),
    ]),
  };

  return {
    state: 'relation',
    relation: relationChip(surface, relation),
    from: relation.from,
    to: relation.to,
    groups: Object.values(EDGE_GROUPS)
      .sort((a, b) => a.order - b.order)
      .map((d) => groups[d.id]),
  };
}
