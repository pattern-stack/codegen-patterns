/**
 * Semantic node data — domain facts, no presentation coupling.
 * This is what adapters produce. Components consume this and
 * internally decide how to render it (which atoms, which layout).
 *
 * T is the source-specific payload (ParsedEntity, DatabaseRecord, etc.)
 */
export interface GraphNodeData<T = unknown> {
  id: string;
  label: string;
  subtitle?: string;
  kind: 'entity' | 'relationship' | 'record';

  /** Visual grouping — family, entity type, category */
  group?: string;

  /** Fields as domain data, not component props */
  fields?: {
    name: string;
    type?: string;
    value?: string;
    role?: 'pk' | 'fk' | 'required' | 'nullable';
    system?: boolean;
  }[];

  /** Behaviors / flags as strings, not Badge props */
  behaviors?: string[];
  flags?: string[];

  /** Relationship-specific (semantic, not presentational) */
  from?: string;
  to?: string;
  selfReferential?: boolean;
  types?: {
    name: string;
    direction?: 'directed' | 'bidirectional' | 'inverse';
    inverseName?: string;
  }[];

  /** Counts */
  fieldCount?: number;
  queryCount?: number;

  /** Extensible metadata */
  metadata?: Record<string, unknown>;

  /** Source payload (for detail panel) */
  source?: T;
}
