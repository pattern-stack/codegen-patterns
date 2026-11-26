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
