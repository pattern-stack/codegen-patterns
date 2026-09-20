/**
 * The relationship vocabulary — one registry, read by the form, the option
 * panel, the preview header and the legend.
 *
 * #679 collapses `pattern: Junction` and `relationship:` into one concept.
 * When it lands, the split below stops being true, and the cost of that has to
 * be editing these descriptors — not chasing a four-way conditional through
 * every component that shows a kind. So nothing outside this file branches on
 * a kind literal: consumers iterate `RELATIONSHIP_KINDS` and read the fields.
 *
 * Adding a kind means one entry here. Merging two means deleting one.
 */
import type { RelationshipKind, RelationshipOptions } from '@studio-shared';

/** Every option the contract exposes, as a form control description. */
export type OptionId = keyof RelationshipOptions;

export type OptionControl =
  | { control: 'text'; placeholder: string }
  | { control: 'boolean'; default: boolean }
  | { control: 'select'; choices: readonly string[]; default: string }
  | { control: 'list'; placeholder: string };

export interface OptionDescriptor {
  id: OptionId;
  label: string;
  /** Shown under the control — why an author would set it. */
  hint: string;
  spec: OptionControl;
}

/**
 * Option descriptors, keyed by id. A kind names the ids that apply to it; the
 * copy lives here once so two kinds sharing an option cannot describe it
 * differently.
 */
export const RELATIONSHIP_OPTIONS: Record<OptionId, OptionDescriptor> = {
  name: {
    id: 'name',
    label: 'Name',
    hint: 'Overrides the derived relationship (and foreign key) name.',
    spec: { control: 'text', placeholder: 'derived from the target' },
  },
  inverse: {
    id: 'inverse',
    label: 'Inverse',
    hint: 'Accessor emitted on the target entity for the other direction.',
    spec: { control: 'text', placeholder: 'derived from the source' },
  },
  through: {
    id: 'through',
    label: 'Through',
    hint: 'The junction that carries the association.',
    spec: { control: 'text', placeholder: 'derived from both entity names' },
  },
  required: {
    id: 'required',
    label: 'Required',
    hint: 'Makes the foreign key column NOT NULL.',
    spec: { control: 'boolean', default: false },
  },
  onDelete: {
    id: 'onDelete',
    label: 'On delete',
    hint: 'What happens to this row when the target row is deleted.',
    spec: {
      control: 'select',
      choices: ['restrict', 'cascade', 'set_null', 'no_action'],
      default: 'restrict',
    },
  },
  types: {
    id: 'types',
    label: 'Types',
    hint: 'Relationship subtypes — one enum value per association row.',
    spec: { control: 'list', placeholder: 'employed_by, advises, board_member' },
  },
  temporal: {
    id: 'temporal',
    label: 'Temporal',
    hint: 'Emits validity columns so an association can start and end.',
    spec: { control: 'boolean', default: true },
  },
  sourced: {
    id: 'sourced',
    label: 'Sourced',
    hint: 'Emits provenance columns — where the association came from.',
    spec: { control: 'boolean', default: true },
  },
};

export interface RelationshipKindDescriptor {
  id: RelationshipKind;
  label: string;
  /** One line, shown beside the choice — what the model gains. */
  description: string;
  /** Cardinality this kind draws, for the preview header and the legend. */
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  /**
   * The edge kind the graph draws for it. Ties the form to
   * `../graph/edge-kinds` without either importing the other's literals.
   */
  edgeKind: 'belongs_to' | 'has_many' | 'has_one' | 'junction';
  /** Which options apply, in the order the form shows them. */
  options: OptionId[];
  /** Where the YAML lands — shown before the preview arrives. */
  writes: string;
}

export const RELATIONSHIP_KINDS: readonly RelationshipKindDescriptor[] = [
  {
    id: 'belongs_to',
    label: 'belongs_to',
    description: 'Foreign key on the source, pointing at one target row.',
    cardinality: 'N:1',
    edgeKind: 'belongs_to',
    options: ['name', 'inverse', 'required', 'onDelete'],
    writes: "the source entity's YAML",
  },
  {
    id: 'has_many',
    label: 'has_many',
    description: 'Inverse of a foreign key — many target rows per source row.',
    cardinality: '1:N',
    edgeKind: 'has_many',
    options: ['name', 'inverse'],
    writes: "the source entity's YAML",
  },
  {
    id: 'has_one',
    label: 'has_one',
    description: 'Inverse of a foreign key — at most one target row.',
    cardinality: '1:1',
    edgeKind: 'has_one',
    options: ['name', 'inverse'],
    writes: "the source entity's YAML",
  },
  {
    id: 'many_to_many',
    label: 'many-to-many',
    description: 'Association through a junction, which can carry its own facts.',
    cardinality: 'N:M',
    edgeKind: 'junction',
    options: ['through', 'name', 'types', 'temporal', 'sourced'],
    writes: 'a junction definition',
  },
];

export function kindDescriptor(id: RelationshipKind): RelationshipKindDescriptor {
  const found = RELATIONSHIP_KINDS.find((k) => k.id === id);
  if (!found) throw new Error(`Unknown relationship kind: ${id}`);
  return found;
}

/** The option descriptors a kind shows, in order. */
export function optionsFor(id: RelationshipKind): OptionDescriptor[] {
  return kindDescriptor(id).options.map((o) => RELATIONSHIP_OPTIONS[o]);
}

/**
 * Drop the options that do not apply to `kind`, and the ones left at their
 * default — the server derives everything it is not told, so sending a
 * redundant key would put noise in the previewed YAML.
 */
export function pruneOptions(
  kind: RelationshipKind,
  draft: Record<string, unknown>,
): RelationshipOptions | undefined {
  const out: Record<string, unknown> = {};

  for (const descriptor of optionsFor(kind)) {
    const value = draft[descriptor.id];
    const { spec } = descriptor;

    if (spec.control === 'text') {
      if (typeof value === 'string' && value.trim()) out[descriptor.id] = value.trim();
    } else if (spec.control === 'boolean') {
      if (typeof value === 'boolean' && value !== spec.default) out[descriptor.id] = value;
    } else if (spec.control === 'select') {
      if (typeof value === 'string' && value && value !== spec.default) out[descriptor.id] = value;
    } else {
      const items = parseList(value);
      if (items.length > 0) out[descriptor.id] = items;
    }
  }

  return Object.keys(out).length > 0 ? (out as RelationshipOptions) : undefined;
}

/** A comma- or newline-separated list field, trimmed and de-duplicated. */
export function parseList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  for (const part of value.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}
