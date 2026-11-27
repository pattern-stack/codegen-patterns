/**
 * The derived constraint facts — what a declared constraint IS, before any target renders it (TGT-1, ADR-047; the
 * sibling of `src/derived/columns/`).
 *
 * Types only: zero runtime imports (type imports only).
 *
 * Deliberately NOT here: ORM or builder text — no builder call (`index('…').on(…)`, `.references(…)`), no
 * template-literal syntax, no table-callback parameter. A fact names tables, columns and properties; a constraint
 * renderer (`src/targets/<orm>/<database>/constraints.ts`) writes them in its pair's syntax. SQL that every SQL pair
 * shares IS a fact: a referential action's spelling (`'set null'`), and the text of a predicate or CHECK expression
 * (`IS NULL OR …`), carried as segments around the column references a renderer writes in its own syntax. Each fact is added when its
 * constraint's text moves behind the target, never ahead of it.
 */

import type { ReferentialAction } from './on-delete.js';
import type { PredicateSegment } from './predicate.js';

/**
 * A column's reference to another table's column: a `belongs_to` foreign key, a junction endpoint, or a field's
 * `foreign_key: <table>.<column>` (#354) when codegen owns the target (#636: a host-owned target gets no reference at
 * all, so no fact).
 */
export interface ColumnReferenceFact {
	/** The referencing column of this table (the SQL name). Postgres's renderer prints the suffix on the column and
	 *  does not read it; the SQLite DDL needs it. */
	readonly column: string;
	/** The referenced table's generated export — its `plural`, NOT its SQL name (TABLE-0). */
	readonly targetExport: string;
	/** The referenced table's SQL name (TABLE-0) — what DDL names; a table's facts stand alone (TGT-2b). */
	readonly targetTable: string;
	/** The referenced column's SQL name. */
	readonly targetColumn: string;
	/**
	 * The referenced column's property on the target export. `id` for a `belongs_to` / junction endpoint. For a field
	 * `foreign_key: <table>.<column>` it is the column as the YAML writes it, which is the property only while that
	 * column is a single word (`id`) — the pre-TGT-1 behaviour, kept byte-identical; a snake_case target column is a
	 * known gap, not changed here.
	 */
	readonly targetProp: string;
	/** The referential action, when the relationship declares one (`belongs_to`, junction endpoints). */
	readonly onDelete?: ReferentialAction;
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
	/** The same columns' SQL names, in order. */
	readonly columns: readonly string[];
	/** The referenced table's generated export — its `plural` (TABLE-0). */
	readonly targetExport: string;
	/** The referenced table's SQL name. */
	readonly targetTable: string;
	/** The TypeScript properties of the referenced columns, in the same order. */
	readonly targetProps: readonly string[];
	/** The referenced columns' SQL names, in the same order. */
	readonly targetColumns: readonly string[];
	readonly onDelete: ReferentialAction;
}

/** A CHECK over this table's columns: a boolean SQL expression, tokenized. */
export interface CheckFact {
	/** The constraint name, a SQL identifier. */
	readonly name: string;
	readonly expression: readonly PredicateSegment[];
}

/**
 * One constraint of a table, tagged by what it is: the facts a table's renderers each write (TGT-2a). The DDL renders
 * the whole list; the Drizzle templates render each where it sits.
 */
export type ConstraintFact =
	| { readonly kind: 'reference'; readonly fact: ColumnReferenceFact }
	| { readonly kind: 'index'; readonly fact: IndexFact }
	| { readonly kind: 'unique'; readonly fact: UniqueFact }
	| { readonly kind: 'foreignKey'; readonly fact: ForeignKeyFact }
	| { readonly kind: 'check'; readonly fact: CheckFact };
