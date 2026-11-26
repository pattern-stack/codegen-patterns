/**
 * The derived table facts — every column a generated table has, whatever made it, before any target renders it
 * (TGT-2a, ADR-047; the table-level sibling of `src/derived/columns/` and `src/derived/constraints/`).
 *
 * Types only: zero runtime imports (type imports only).
 *
 * Deliberately NOT here: ORM, builder or DDL text. A column fact says what the column stores (`kind`), whether it may
 * be NULL, its default and its rules; each target writes it (`src/targets/<orm>/<database>/`, and the database-level
 * DDL in `src/targets/<database>/`).
 *
 * Room left on purpose (PROPOSAL-value-objects, #952), nothing built for it yet:
 * - `path` is the field path and `name` the column, so a value object's prefixed columns (`delivered_at` for
 *   `['delivered', 'at']`) are ordinary facts;
 * - a table's primary key is a list of columns, not a hard-wired `id` (value-object identity, phase 2);
 * - an `order:` column (`seq`, an autoincrement that isn't the key) and a second unique integer column (#952's short
 *   ids) are ordinary integer facts.
 */

/** What made a column. */
export type ColumnOrigin =
	| 'id'
	| 'inherited' // a child's copy of its base's kind / tenant column (RFC-0006)
	| 'match' // a `match:`-derived local column (RFC-0006 §2.4)
	| 'belongs_to'
	| 'field'
	| 'behavior:external_id_tracking'
	| 'behavior:timestamps'
	| 'behavior:soft_delete'
	| 'tenant';

/**
 * What a column stores, independent of any database: `instant` is a point in time (a YAML `datetime`), `json` any JSON
 * value. Each target maps a kind to its own type (Postgres `timestamp`, SQLite ISO `TEXT`, …).
 */
export type ColumnKind = 'uuid' | 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'instant' | 'json' | 'enum';

/** A column's database default. `now` is the current instant (or date); `value` a literal, JSON-able. */
export type ColumnDefault = { readonly now: true } | { readonly value: unknown };

export interface ColumnFact {
	/** The SQL column name. */
	readonly name: string;
	/** The TypeScript property. */
	readonly prop: string;
	/** The field path the column stores (`['email']`; a value object's column has a longer one). */
	readonly path: readonly string[];
	readonly origin: ColumnOrigin;
	readonly kind: ColumnKind;
	/** An array of `kind` (`string_array`). */
	readonly isArray: boolean;
	readonly nullable: boolean;
	/** `null`: no database default. */
	readonly default: ColumnDefault | null;
	/** The allowed values of an `enum` column; `null` for any other kind. */
	readonly choices: readonly string[] | null;
	/** `max_length` of a `string` column; `null` otherwise. */
	readonly maxLength: number | null;
	/** An `instant` keeps its time zone (#796); `null` for any other kind. */
	readonly withTimezone: boolean | null;
	/** The id comes from the application when the row is created (a uuid the database does not make). */
	readonly generatedId: boolean;
}
