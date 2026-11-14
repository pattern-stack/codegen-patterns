/**
 * The API tab's view model — a derived surface turned into rows the tab can
 * print without deciding anything.
 *
 * Every label, section and order comes from `surface-kinds.ts`; every name,
 * kind and origin comes from the generator's derivation, fetched from
 * `GET /api/surface`. This file only arranges them: it never builds a method
 * name, never decides whether something is emitted, and never reads a YAML
 * file.
 *
 * Pure: no React, no DOM, no network. Unit-tested in
 * `../__tests__/surface-view.test.ts` against a real `project surface --json`
 * payload of the demo.
 */
import type { EntityApiSurface, Origin, ProjectApiSurface, YamlRef } from '@studio-shared';

import type { StudioEdgeKind } from '../graph/edge-kinds';
import {
  ORIGIN_KINDS,
  READ_OPTIONS_LABELS,
  RELATIONSHIPS_KEY,
  REPOSITORY_KINDS,
  SERVICE_KINDS,
  SHAPE_LABELS,
  SURFACE_SECTIONS,
  UNMODELLED_KINDS,
  USE_CASE_KINDS,
  originKind,
  originSubject,
} from './surface-kinds';
import type { KindDescriptor, OriginKind, SectionId } from './surface-kinds';

type MethodRef = EntityApiSurface['useCases'][number]['calls'];

export interface OriginChip {
  kind: OriginKind;
  /** `← relationships.account`, `pattern Integrated`, `base`. */
  text: string;
  /** The declaration to open, when the chip links to YAML. */
  yaml?: YamlRef;
  /** The edge kind whose colour the chip borrows — set for a relation origin. */
  edgeKind?: StudioEdgeKind;
}

export interface SurfaceRow {
  key: string;
  name: string;
  /** `findByAccountId(id, opts) → many`, `GET /contacts`. */
  signature: string;
  /** The kind's tag from `surface-kinds.ts`. */
  kindLabel?: string;
  flags: string[];
  /** What the row calls — `contact.repository.findByAccountId`. */
  calls?: string;
  origin?: OriginChip;
  /** Declarations that resolved to the same name and lost, under the winner. */
  shadows: OriginChip[];
}

export interface InheritedGroup {
  origin: OriginChip;
  rows: SurfaceRow[];
}

export interface SurfaceSection {
  id: SectionId;
  label: string;
  /** Rows in the generated class body, in the table's kind order. */
  rows: SurfaceRow[];
  /** `emitted: false` rows — on a base class or mixin, grouped by origin. */
  inherited: InheritedGroup[];
  /** Set when the section is switched off rather than empty (HTTP off). */
  off?: { text: string; origin?: OriginChip };
  empty: string;
}

export type ApiTabView =
  | { state: 'entity'; entity: string; className: string; sections: SurfaceSection[]; warnings: string[] }
  | { state: 'unmodelled'; name: string; kindLabel: string; headline: string; reason: string }
  | { state: 'undescribed'; name: string };

// ── Origins ─────────────────────────────────────────────────────────────────

/** The REL-1 relation an entity's `relationships.<name>` declaration is. */
function relationKindFor(surface: ProjectApiSurface, ref: YamlRef): StudioEdgeKind | undefined {
  if (ref.doc.kind !== 'entity' || ref.path[0] !== RELATIONSHIPS_KEY || ref.path.length < 2) return undefined;
  const id = `${ref.doc.name}.${RELATIONSHIPS_KEY}.${String(ref.path[1])}`;
  return surface.relations.find((r) => r.id === id)?.kind;
}

function yamlChip(surface: ProjectApiSurface, ref: YamlRef): OriginChip {
  return originChip(surface, { from: 'yaml', at: ref });
}

export function originChip(surface: ProjectApiSurface, origin: Origin): OriginChip {
  const kind = originKind(origin);
  const descriptor = ORIGIN_KINDS[kind];
  const subject = originSubject(origin);
  const text = subject === '' ? descriptor.label : `${descriptor.label} ${subject}`;
  const chip: OriginChip = { kind, text };

  if (origin.from === 'yaml') {
    if (descriptor.linksToYaml) chip.yaml = origin.at;
    chip.edgeKind = kind === 'junction' ? 'junction' : relationKindFor(surface, origin.at);
  }
  return chip;
}

function shadowsOf(surface: ProjectApiSurface, origin: Origin): OriginChip[] {
  return origin.from === 'yaml' ? (origin.shadows ?? []).map((ref) => yamlChip(surface, ref)) : [];
}

// ── Rows ────────────────────────────────────────────────────────────────────

export function methodRefText(ref: MethodRef): string {
  return `${ref.entity}.${ref.layer}.${ref.method}`;
}

export function signature(name: string, params: { name: string }[], returns: keyof typeof SHAPE_LABELS): string {
  return `${name}(${params.map((p) => p.name).join(', ')}) → ${SHAPE_LABELS[returns]}`;
}

/** Stable sort by the kind's table order — rows of one kind keep the derivation's order. */
function byKindOrder<T>(items: T[], descriptor: (item: T) => KindDescriptor): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => descriptor(a.item).order - descriptor(b.item).order || a.index - b.index)
    .map(({ item }) => item);
}

/** `emitted: false` rows, grouped by their origin's chip, groups in origin-kind order. */
function groupInherited(rows: { row: SurfaceRow; origin: OriginChip }[]): InheritedGroup[] {
  const groups = new Map<string, InheritedGroup>();
  for (const { row, origin } of rows) {
    const group = groups.get(origin.text) ?? { origin, rows: [] };
    group.rows.push(row);
    groups.set(origin.text, group);
  }
  return [...groups.values()].sort(
    (a, b) => ORIGIN_KINDS[a.origin.kind].order - ORIGIN_KINDS[b.origin.kind].order,
  );
}

function section(id: SectionId, rows: SurfaceRow[], inherited: InheritedGroup[] = []): SurfaceSection {
  const d = SURFACE_SECTIONS[id];
  return { id, label: d.label, rows, inherited, empty: d.empty };
}

function repositorySection(surface: ProjectApiSurface, e: EntityApiSurface): SurfaceSection {
  const kinds = (m: EntityApiSurface['repository']['methods'][number]) => REPOSITORY_KINDS[m.kind];
  const toRow = (m: EntityApiSurface['repository']['methods'][number]): SurfaceRow => {
    const flags: string[] = [];
    if (m.unique) flags.push('unique');
    if (m.order) flags.push(`order ${m.order.column} ${m.order.direction}`);
    if (m.limit) flags.push('limit');
    const read = READ_OPTIONS_LABELS[m.readOptions];
    if (read != null) flags.push(read);
    return {
      key: `repository.${m.name}`,
      name: m.name,
      signature: signature(m.name, m.params, m.returns),
      kindLabel: kinds(m).label,
      flags,
      origin: originChip(surface, m.origin),
      shadows: shadowsOf(surface, m.origin),
    };
  };
  const methods = byKindOrder(e.repository.methods, kinds);
  return section(
    'repository',
    methods.filter((m) => m.emitted).map(toRow),
    groupInherited(
      methods.filter((m) => !m.emitted).map((m) => ({ row: toRow(m), origin: originChip(surface, m.origin) })),
    ),
  );
}

function serviceSection(surface: ProjectApiSurface, e: EntityApiSurface): SurfaceSection {
  const kinds = (m: EntityApiSurface['service']['methods'][number]) => SERVICE_KINDS[m.kind];
  const toRow = (m: EntityApiSurface['service']['methods'][number]): SurfaceRow => ({
    key: `service.${m.name}`,
    name: m.name,
    signature: signature(m.name, m.params, m.returns),
    kindLabel: kinds(m).label,
    flags: [],
    calls: m.delegatesTo ? methodRefText(m.delegatesTo) : undefined,
    origin: originChip(surface, m.origin),
    shadows: shadowsOf(surface, m.origin),
  });
  const methods = byKindOrder(e.service.methods, kinds);
  return section(
    'service',
    methods.filter((m) => m.emitted).map(toRow),
    groupInherited(
      methods.filter((m) => !m.emitted).map((m) => ({ row: toRow(m), origin: originChip(surface, m.origin) })),
    ),
  );
}

function useCaseSection(surface: ProjectApiSurface, e: EntityApiSurface): SurfaceSection {
  const kinds = (u: EntityApiSurface['useCases'][number]) => USE_CASE_KINDS[u.kind];
  return section(
    'useCases',
    byKindOrder(e.useCases, kinds).map((u) => ({
      key: `useCases.${u.className}`,
      name: u.className,
      signature: u.className,
      kindLabel: kinds(u).label,
      flags: [],
      calls: methodRefText(u.calls),
      origin: originChip(surface, u.origin),
      shadows: shadowsOf(surface, u.origin),
    })),
  );
}

function httpSection(surface: ProjectApiSurface, e: EntityApiSurface): SurfaceSection {
  const s = section(
    'http',
    e.http.routes.map((r) => {
      const flags: string[] = [];
      if (r.operationId != null) flags.push(`operationId ${r.operationId}`);
      if (r.includeRoute != null) flags.push(`?include= ${r.includeRoute}`);
      return {
        key: `http.${r.verb} ${r.path}`,
        name: `${r.verb} ${r.path}`,
        signature: `${r.verb} ${r.path}`,
        flags,
        calls: `${r.controller}.${r.handler} → ${r.useCase}`,
        origin: originChip(surface, r.origin),
        shadows: shadowsOf(surface, r.origin),
      };
    }),
  );
  if (!e.http.enabled) {
    s.off = {
      text: 'HTTP off — no controller is generated',
      origin: e.http.disabledBy ? yamlChip(surface, e.http.disabledBy) : undefined,
    };
  }
  return s;
}

function includesSection(e: EntityApiSurface): SurfaceSection {
  const rows: SurfaceRow[] = (e.http.includes ?? []).flatMap((inc) =>
    inc.paths.map((p) => ({
      key: `includes.${inc.route}.${p.path}`,
      name: p.path,
      signature: `${inc.route} · ${p.path}`,
      flags: [`depth ${p.depth}`, `max ${inc.maxDepth}`],
      calls: e.http.includesConst,
      shadows: [],
    })),
  );
  return section('includes', rows);
}

const SECTION_BUILDERS: Record<SectionId, (surface: ProjectApiSurface, e: EntityApiSurface) => SurfaceSection> = {
  repository: repositorySection,
  service: serviceSection,
  useCases: useCaseSection,
  http: httpSection,
  includes: (_surface, e) => includesSection(e),
};

export function entitySections(surface: ProjectApiSurface, e: EntityApiSurface): SurfaceSection[] {
  return Object.values(SURFACE_SECTIONS)
    .sort((a, b) => a.order - b.order)
    .map((d) => SECTION_BUILDERS[d.id](surface, e));
}

// ── The tab ─────────────────────────────────────────────────────────────────

/**
 * What the API tab shows for a graph node.
 *
 * An `unmodelled` entry wins over an entity of the same name — a
 * `pattern: Junction` entity is listed there, and its module is not what the
 * surface describes. A node the surface neither describes nor lists is
 * `undescribed`, never an empty method list: an absent answer must not read
 * as "this generates no API".
 */
export function apiTabView(surface: ProjectApiSurface, nodeId: string): ApiTabView {
  const unmodelled = surface.unmodelled.find((u) => u.name === nodeId);
  if (unmodelled) {
    const d = UNMODELLED_KINDS[unmodelled.kind];
    return { state: 'unmodelled', name: nodeId, kindLabel: d.label, headline: d.headline, reason: unmodelled.reason };
  }
  const entity = surface.entities[nodeId];
  if (!entity) return { state: 'undescribed', name: nodeId };
  return {
    state: 'entity',
    entity: entity.entity,
    className: entity.className,
    sections: entitySections(surface, entity),
    warnings: surface.warnings,
  };
}
