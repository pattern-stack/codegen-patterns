/**
 * The API surface vocabulary — one table per kind the derivation carries, read
 * by the API tab (and, in A5, the edge panel).
 *
 * `src/derived/api/types.ts` names every method kind, origin kind and result
 * shape the generator emits. What Studio *calls* each one, which section it
 * sits in and in what order it is listed is decided here, once. Nothing outside
 * this file branches on a kind literal: the view model (`surface-view.ts`)
 * looks a kind up here and the tab renders the descriptor it gets back.
 *
 * REL-3's navigator is one more service kind; READ-1 §2.5's variants are more
 * repository kinds; #679 retires the `unmodelled` rows. Each is an edit to
 * these tables — not a conditional in a component.
 *
 * No colour lives here. A relation-sourced origin borrows its edge kind's
 * colour from `graph/edge-kinds.ts`, so the chip and the line it explains are
 * the same colour by construction.
 */
import type { EntityApiSurface, Origin, ProjectApiSurface } from '@studio-shared';

import { formatIssuePath } from './yaml-issues';

// ── The derivation's own unions, read off its types (never restated) ───────

type RepositoryMethod = EntityApiSurface['repository']['methods'][number];
type ServiceMethod = EntityApiSurface['service']['methods'][number];
type UseCase = EntityApiSurface['useCases'][number];

export type RepositoryKind = RepositoryMethod['kind'];
export type ServiceKind = ServiceMethod['kind'];
export type UseCaseKind = UseCase['kind'];
export type Shape = RepositoryMethod['returns'];
export type ReadOptionsShape = RepositoryMethod['readOptions'];
export type UnmodelledKind = ProjectApiSurface['unmodelled'][number]['kind'];

// ── Sections ────────────────────────────────────────────────────────────────

export type SectionId = 'repository' | 'service' | 'useCases' | 'http' | 'includes';

export interface SectionDescriptor {
  id: SectionId;
  label: string;
  order: number;
  /** What the section says when the entity contributes nothing to it. */
  empty: string;
}

export const SURFACE_SECTIONS: Record<SectionId, SectionDescriptor> = {
  repository: { id: 'repository', label: 'Repository', order: 0, empty: 'No repository methods.' },
  service: { id: 'service', label: 'Service', order: 1, empty: 'No service methods.' },
  useCases: { id: 'useCases', label: 'Use cases', order: 2, empty: 'No use cases.' },
  http: { id: 'http', label: 'HTTP', order: 3, empty: 'No routes.' },
  includes: {
    id: 'includes',
    label: 'Includes',
    order: 4,
    // Charter I6: HTTP is closed by default, so an empty allowlist is a
    // statement about the API, not a missing answer.
    empty: 'No `api.includes` declared — `?include=` is closed.',
  },
};

// ── Method kinds ────────────────────────────────────────────────────────────

export interface KindDescriptor {
  /** The short tag shown on the row. */
  label: string;
  section: SectionId;
  /** Position within the section; rows of one kind keep the derivation's order. */
  order: number;
}

export const REPOSITORY_KINDS: Record<RepositoryKind, KindDescriptor> = {
  find_by_id: { label: 'by id', section: 'repository', order: 0 },
  find_by_ids: { label: 'by ids', section: 'repository', order: 1 },
  list: { label: 'list', section: 'repository', order: 2 },
  count: { label: 'count', section: 'repository', order: 3 },
  fk_finder: { label: 'FK finder', section: 'repository', order: 4 },
  finder: { label: 'finder', section: 'repository', order: 5 },
  finder_projection: { label: 'projection finder', section: 'repository', order: 6 },
  eav_upsert: { label: 'EAV upsert', section: 'repository', order: 7 },
  inherited: { label: 'inherited', section: 'repository', order: 8 },
};

export const SERVICE_KINDS: Record<ServiceKind, KindDescriptor> = {
  read: { label: 'read', section: 'service', order: 0 },
  finder: { label: 'finder', section: 'service', order: 1 },
  relation_one: { label: 'relation · one', section: 'service', order: 2 },
  relation_many: { label: 'relation · many', section: 'service', order: 3 },
  junction_list: { label: 'junction list', section: 'service', order: 4 },
  junction_attach: { label: 'junction attach', section: 'service', order: 5 },
  junction_detach: { label: 'junction detach', section: 'service', order: 6 },
  junction_set_primary: { label: 'junction primary', section: 'service', order: 7 },
  capability_forwarder: { label: 'capability', section: 'service', order: 8 },
  eav_read: { label: 'EAV read', section: 'service', order: 9 },
  eav_write: { label: 'EAV write', section: 'service', order: 10 },
  inherited: { label: 'inherited', section: 'service', order: 11 },
};

export const USE_CASE_KINDS: Record<UseCaseKind, KindDescriptor> = {
  find_by_id: { label: 'find by id', section: 'useCases', order: 0 },
  list: { label: 'list', section: 'useCases', order: 1 },
  create: { label: 'create', section: 'useCases', order: 2 },
  update: { label: 'update', section: 'useCases', order: 3 },
  delete: { label: 'delete', section: 'useCases', order: 4 },
  find_by_id_with_fields: { label: 'find by id + fields', section: 'useCases', order: 5 },
  list_with_fields: { label: 'list + fields', section: 'useCases', order: 6 },
  query: { label: 'query', section: 'useCases', order: 7 },
  search: { label: 'search', section: 'useCases', order: 8 },
};

// ── Result shapes and read options ──────────────────────────────────────────

/** What follows the `→` in a row's signature. */
export const SHAPE_LABELS: Record<Shape, string> = {
  one: 'one',
  many: 'many',
  count: 'count',
  projection: 'projection',
  none: 'void',
  forwarded: 'forwarded',
};

/** The read-options flag on a repository read; `null` shows no flag. */
export const READ_OPTIONS_LABELS: Record<ReadOptionsShape, string | null> = {
  none: null,
  columns: 'columns',
  'columns+with': 'columns + with',
};

// ── Origins ─────────────────────────────────────────────────────────────────

/**
 * An origin as the tab classifies it. A `yaml` origin in a junction's YAML is
 * its own kind: what the reader needs to see is *which junction*, not a path
 * inside a file they did not select.
 */
export type OriginKind = 'base' | 'pattern' | 'capability' | 'yaml' | 'junction';

export interface OriginKindDescriptor {
  kind: OriginKind;
  /** Words before the origin's subject — `pattern Integrated`. */
  label: string;
  /** Position among the inherited groups. */
  order: number;
  /** Whether the chip opens the YAML that declared it. */
  linksToYaml: boolean;
}

export const ORIGIN_KINDS: Record<OriginKind, OriginKindDescriptor> = {
  yaml: { kind: 'yaml', label: '←', order: 0, linksToYaml: true },
  junction: { kind: 'junction', label: 'junction', order: 1, linksToYaml: true },
  capability: { kind: 'capability', label: 'capability', order: 2, linksToYaml: false },
  pattern: { kind: 'pattern', label: 'pattern', order: 3, linksToYaml: false },
  base: { kind: 'base', label: 'base', order: 4, linksToYaml: false },
};

export function originKind(origin: Origin): OriginKind {
  if (origin.from === 'yaml') return origin.at.doc.kind === 'junction' ? 'junction' : 'yaml';
  return origin.from;
}

/** What follows the label on an origin chip. Empty for `base`. */
export function originSubject(origin: Origin): string {
  switch (origin.from) {
    case 'base':
      return '';
    case 'pattern':
      return origin.pattern;
    case 'capability':
      return origin.capability;
    case 'yaml': {
      if (origin.at.doc.kind === 'junction') return origin.at.doc.name;
      const where = formatIssuePath(origin.at.path);
      return origin.at.note != null ? `${where} (${origin.at.note})` : where;
    }
  }
}

/** The YAML section a `relationships.<name>` origin lives under. */
export const RELATIONSHIPS_KEY = 'relationships';

// ── Nodes the derivation does not describe yet ──────────────────────────────

export interface UnmodelledDescriptor {
  /** What the node is, in the tab's heading. */
  label: string;
  /** The one-line answer the tab gives instead of a method list. */
  headline: string;
}

export const UNMODELLED_KINDS: Record<UnmodelledKind, UnmodelledDescriptor> = {
  relationship: { label: 'relationship', headline: 'not modelled yet (#679)' },
  junction: { label: 'junction', headline: 'not modelled yet (#679)' },
};
