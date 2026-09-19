/**
 * Semantic emitter — the vendored type mirror (SEM-2, PLAN §5.3 fallback).
 *
 * The consuming package (`@pattern-stack/query-surface`) is not published yet
 * (query-surface#40), so the emitted model cannot import its types. PLAN §5.3
 * planned for exactly this: emit a VERBATIM mirror of the vocabulary — the
 * ADR-040 precedent, where a shared vocabulary lives in more than one home and
 * the copies are kept honest by a conformance test rather than by hope.
 *
 * `src/__tests__/emitters/semantic/conformance.test.ts` compares these
 * declarations against the sibling checkout when one is present, and skips with
 * a printed reason when it is not.
 *
 * RETIRING THIS FILE (SEM-4) is not a one-line change. The list, measured by
 * flipping `TYPES_MODULE` alone and recording what goes red, is in
 * docs/specs/SEM-2.md §4 "Retiring the mirror". In short: the constant; the
 * `types.ts` branch in `index.ts` (TS2367 once the constant changes); delete
 * this file and `conformance.test.ts`; the `'./types'` pins in
 * `emit-model.test.ts`; the golden `snapshot/types.ts` + regenerated
 * `index.ts` / `model.ts`; the smoke's `types.ts` assertion and its
 * `RUNTIME_DEPS` (TS2307 without the package); the peer + dev dependency.
 * The emitted barrel needs nothing — it re-exports from `TYPES_MODULE`.
 */

import { GENERATED_BANNER } from './emit-model';

/**
 * The mirrored vocabulary.
 *
 * `EntityDescriptor` is deliberately REDUCED: the package's carries `eav`,
 * `fieldMeta` and `computed` typed against package-internal modules that SEM-2
 * does not populate. An emitted model has to be ASSIGNABLE TO the package's
 * type, not identical to it.
 */
export function buildSemanticTypes(): string {
	return `${GENERATED_BANNER}import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

// Verbatim mirror of @pattern-stack/query-surface's model vocabulary. Replaced
// by a package import when it publishes (query-surface#40); until then a
// conformance test in the generator keeps this file honest.

export type Agg = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';

export type Additivity = 'additive' | 'semi' | 'non';

export type AggColType = 'number' | 'string' | 'boolean' | 'datetime' | 'json' | 'uuid' | 'enum';

/** Per-field analytics tags. */
export interface AggFieldMeta {
  type: AggColType;
  role?: 'measure' | 'dimension';
  /** default aggregation for a measure */
  agg?: Agg;
  /** allowed aggregations; yields one \`field.agg\` catalog entry per listed agg */
  aggs?: Agg[];
  /** additive (sum/avg/min/max ok) | semi (not summable over time) | non (never sum) */
  additivity?: Additivity;
  /** marks the time axis (semi-additive measures may not be summed across it) */
  time?: boolean;
  /** physical column; defaults to the field key */
  column?: string;
  /** a dimension whose value domain is declared (pg enum / choices) */
  hasDeclaredDomain?: boolean;
}

/** One edge of the cardinality graph. \`has_one\` is a codegen extension pending
 *  query-surface#40; the package knows \`belongs_to\` and \`has_many\` today. */
export interface AggRelationship {
  kind: 'belongs_to' | 'has_many' | 'has_one';
  target: string;
  fk: string;
}

export interface AggEntity {
  table: string;
  pk: string;
  rels: Record<string, AggRelationship>;
  fields: Record<string, AggFieldMeta>;
}

export type AggRegistry = Record<string, AggEntity>;

export type RelDescriptor =
  | { kind: 'belongs_to'; target: string; fk: string }
  | { kind: 'has_many'; target: string; fk: string }
  | { kind: 'has_one'; target: string; fk: string };

/** Entity-level semantics. \`kind: 'junction'\` marks a pairing table. */
export interface EntityMeta {
  kind?: 'entity' | 'junction';
  summary?: string;
}

/** Reduced mirror — SEM-2 populates this subset; the package's type carries
 *  further optional members (eav, fieldMeta, computed) it does not. */
export interface EntityDescriptor {
  name: string;
  table: PgTable;
  primaryKey: string;
  columns: Record<string, PgColumn>;
  relationships: Record<string, RelDescriptor>;
  searchableColumns: string[];
  meta?: EntityMeta;
}

/** A per-row arithmetic expression over atomic catalog measures. */
export type DerivedExpr =
  | { ref: string }
  | { lit: number }
  | { op: '+' | '-' | '*' | '/'; left: DerivedExpr; right: DerivedExpr };

export interface AtomicMeasureDef {
  kind: 'atomic';
  on: string;
  agg: Agg;
  source: string;
  additivity: Additivity;
  label?: string;
}

export interface RatioMeasureDef {
  kind: 'ratio';
  numerator: string;
  denominator: string;
  label?: string;
}

export interface CumulativeMeasureDef {
  kind: 'cumulative';
  measure: string;
  order_by: string;
  partition_by?: string;
  label?: string;
}

export interface DerivedMeasureDef {
  kind: 'derived';
  expr: DerivedExpr;
  label?: string;
}

export type MeasureDef =
  | AtomicMeasureDef
  | RatioMeasureDef
  | CumulativeMeasureDef
  | DerivedMeasureDef;

export type MeasureCatalog = Record<string, MeasureDef>;

/** The model the aggregate engine runs against. Host-supplied. */
export interface AggregateModel {
  registry: Record<string, EntityDescriptor>;
  analytics: AggRegistry;
  tables: Record<string, PgTable>;
  colByDbName: Record<string, Record<string, PgColumn>>;
  catalog?: MeasureCatalog;
}
`;
}
