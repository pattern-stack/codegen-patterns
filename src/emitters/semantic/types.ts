/**
 * Semantic emitter — shared types (SEM-2, ADR-045).
 *
 * The `AggregateModel` is a CROSS-ENTITY file: one model per schema, rendered
 * from the full entity + junction set in one pass. So, like the frontend
 * emitter (ADR-038) and the relations manifest (REL-1), this is a whole-set TS
 * emitter rather than a hygen template.
 *
 * The context carries `ParsedEntity` rather than the raw `EntityDefinition`:
 * SEM-1 put the analytics tags on `ParsedField.analytics` /
 * `ParsedEntity.analytics` precisely so downstream emitters read one shape.
 * Naming still comes from the cross-entity registry — the target entity's own
 * `plural`, never a re-pluralized string.
 *
 * `SemanticModel` below is the INTERMEDIATE shape: a fully-resolved, ordered
 * description of what `model.ts` will contain, with no rendering concerns. All
 * of the mapping semantics live in `build-model.ts`; `emit-model.ts` only
 * prints this.
 */

import type { ParsedEntity } from '../../analyzer/types';
import type { EntityRegistryEntry } from '../../parser/entity-registry';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';

export type { EntityRegistryEntry } from '../../parser/entity-registry';

/** The context the builders consume. Constructible in tests without fs. */
export interface SemanticEmitContext {
	/** Cross-entity naming registry, name-sorted. The only naming source. */
	entities: EntityRegistryEntry[];
	/** Parsed entities keyed by entity name — fields, tags, relationships. */
	parsed: Map<string, ParsedEntity>;
	/** Junction definitions, sorted by derived junction name. */
	junctions: JunctionDefinition[];
}

/** The aggregation vocabulary — mirrors the consuming package's `Agg`. */
export type Agg = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';

/** Mirrors the consuming package's `Additivity`. */
export type Additivity = 'additive' | 'semi' | 'non';

/** Mirrors the consuming package's `AggColType`. */
export type AggColType =
	| 'number'
	| 'string'
	| 'boolean'
	| 'datetime'
	| 'json'
	| 'uuid'
	| 'enum';

/**
 * One relationship edge, in the shape both `EntityDescriptor.relationships`
 * and `AggEntity.rels` take.
 *
 * `has_one` is emitted faithfully. The consuming package does not know the kind
 * yet (query-surface#40) — see docs/specs/SEM-2.md S7 and the conformance
 * test's named expectation.
 */
export interface SemanticRelationship {
	kind: 'belongs_to' | 'has_many' | 'has_one';
	/** Registry key of the target — an entity name, never a table name. */
	target: string;
	/** FK column (db/snake). For `has_many` / `has_one` it lives on the target. */
	fk: string;
}

/** One field's analytics tags, in `AggFieldMeta` shape. */
export interface SemanticField {
	/** Field key — the db/snake column name, which is also the catalog key head. */
	key: string;
	type: AggColType;
	role?: 'measure' | 'dimension';
	agg?: Agg;
	aggs?: Agg[];
	additivity?: Additivity;
	time?: boolean;
	/** Always emitted explicitly rather than leaning on the package's default. */
	column: string;
	hasDeclaredDomain?: boolean;
}

/** One entity (or junction) as it will appear in `registry` and `analytics`. */
export interface SemanticEntity {
	/** Registry key: the entity name, or the derived junction name. */
	name: string;
	/** Identifier exported by the generated schema barrel (`entity.plural`). */
	tableVar: string;
	/** Physical table name, for `AggEntity.table`. */
	tableName: string;
	primaryKey: string;
	/** Relationship key → edge. Keys are the YAML relationship names verbatim. */
	relationships: Record<string, SemanticRelationship>;
	/** Field key → tags. Ordered by key. */
	fields: Record<string, SemanticField>;
	/** db names of the text columns worth full-text matching. */
	searchableColumns: string[];
	/** `'junction'` for a junction table; `'entity'` otherwise. */
	kind: 'entity' | 'junction';
	/**
	 * A junction's real primary key — composite, `(<a>_id, <b>_id[, role])`. The
	 * package's descriptor holds a single key column, so `primaryKey` stays `'id'`
	 * (a column that does not exist, failing loudly if read) and this is printed
	 * beside it. Absent for entities. See #689.
	 */
	compositeKey?: string[];
}

/** A composite metric, mirroring the package's non-atomic `MeasureDef` kinds. */
export type SemanticMetric =
	| { name: string; kind: 'ratio'; numerator: string; denominator: string; label?: string }
	| { name: string; kind: 'derived'; expr: DerivedExprNode; label?: string }
	| {
			name: string;
			kind: 'cumulative';
			measure: string;
			order_by: string;
			partition_by?: string;
			label?: string;
	  };

/** The closed 4-op expression tree, mirroring the package's `DerivedExpr`. */
export type DerivedExprNode =
	| { ref: string }
	| { lit: number }
	| { op: '+' | '-' | '*' | '/'; left: DerivedExprNode; right: DerivedExprNode };

/** The fully-resolved model, ready to print. Ordering is already total. */
export interface SemanticModel {
	entities: SemanticEntity[];
	/** Composite catalog entries, sorted by name. Atomic entries are NOT here. */
	metrics: SemanticMetric[];
	/** Non-fatal problems (unresolvable targets, junction endpoints). */
	warnings: string[];
}

/** Name-sort registry entries so emission order never depends on the filesystem. */
export function sortEntities(entries: EntityRegistryEntry[]): EntityRegistryEntry[] {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}
