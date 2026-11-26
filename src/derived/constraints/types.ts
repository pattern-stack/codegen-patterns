/**
 * The derived constraint facts — what a declared constraint IS, before any target renders it (TGT-1, ADR-047; the
 * sibling of `src/derived/columns/`).
 *
 * Types only: zero runtime imports (type imports only).
 *
 * Deliberately NOT here: source text of any kind — no builder call (`index('…').on(…)`, `.references(…)`), no SQL
 * keyword syntax, no table-callback parameter. A fact names tables, columns and properties; a constraint renderer
 * (`src/targets/<orm>/<database>/constraints.ts`) writes them in its pair's syntax. Each fact is added when its
 * constraint's text moves behind the target, never ahead of it.
 */

import type { OnDeleteAction } from './on-delete.js';
import type { PredicateSegment } from './predicate.js';

/**
 * A column's reference to another table's column: a `belongs_to` foreign key, a junction endpoint, or a field's
 * `foreign_key: <table>.<column>` (#354) when codegen owns the target (#636: a host-owned target gets no reference at
 * all, so no fact).
 */
export interface ColumnReferenceFact {
	/** The referenced table's generated export — its `plural`, NOT its SQL name (TABLE-0). */
	readonly targetExport: string;
	/** The referenced column, as the YAML names it. */
	readonly targetColumn: string;
	/** The referential action, when the relationship declares one (`belongs_to`, junction endpoints). */
	readonly onDelete?: OnDeleteAction;
}

/** A plain (non-unique) index over columns of this table. */
export interface IndexFact {
	/** The index name, a SQL identifier (`<table>_<column>_idx`). */
	readonly name: string;
	/** The TypeScript properties of the indexed columns, in order. */
	readonly props: readonly string[];
}

/**
 * A uniqueness rule over columns of this table: a field's `unique: true`, a `unique_indexes:` entry, or the
 * `unique(id, …)` another table's composite foreign key points at (RFC-0006).
 */
export interface UniqueFact {
	/** The constraint / index name, a SQL identifier. */
	readonly name: string;
	/** The TypeScript properties of the covered columns, in order (the tenant column first when tenant-scoped). */
	readonly props: readonly string[];
	/** The `where:` predicate of a partial unique, tokenized; `null` when the rule covers every row. */
	readonly where: readonly PredicateSegment[] | null;
	/** NULLs compare equal (`nulls_not_distinct`, default on a tenant-scoped entity: the NULL tenant is one partition). */
	readonly nullsNotDistinct: boolean;
	/** A UNIQUE constraint other tables' foreign keys reference, rather than a unique index. */
	readonly referenced: boolean;
	/** Declared on a tenant-scoped entity, so the rule is per tenant (the renderer explains the NULL tenant). */
	readonly tenantScoped: boolean;
}

/** A foreign key over several columns of this table (RFC-0006: `match:`, and a child's kind / tenant keys). */
export interface ForeignKeyFact {
	/** The constraint name, a SQL identifier. */
	readonly name: string;
	/** The TypeScript properties of this table's columns, in order. */
	readonly props: readonly string[];
	/** The referenced table's generated export — its `plural` (TABLE-0). */
	readonly targetExport: string;
	/** The TypeScript properties of the referenced columns, in the same order. */
	readonly targetProps: readonly string[];
	readonly onDelete: OnDeleteAction;
}

/** A CHECK over this table's columns: a boolean SQL expression, tokenized. */
export interface CheckFact {
	/** The constraint name, a SQL identifier. */
	readonly name: string;
	readonly expression: readonly PredicateSegment[];
}
