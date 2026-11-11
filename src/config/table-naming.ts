/**
 * The SQL table name rule — the ONE statement of it (TABLE-0).
 *
 * An entity has two names that used to be one string:
 *
 *  - its **code names** — the Drizzle table export (`export const tickets`),
 *    the `db.query.<plural>` / relations-manifest key, the module folder and the
 *    class names. All of them come from `plural` (`src/config/module-tree.ts`).
 *  - its **SQL table name** — the `pgTable('…')` argument, and everything that
 *    names the table in the database: index and constraint names, the Electric
 *    shape's `table` param, the semantic model's `tableName`, a field-level
 *    `foreign_key: <table>.<column>`. That is this function.
 *
 * Resolution, first match wins:
 *
 *  1. `table_name:` on the entity (or junction) — the literal SQL name, used
 *     VERBATIM. No prefix is applied: an explicit name is the host's physical
 *     table, adopted as it is (a renamed `ticket` concept over a legacy `issues` table).
 *  2. `<prefix><plural>`, where the prefix is the entity's own `table_prefix:`
 *     if declared (`''` opts out), else the project's `tables.prefix`
 *     (`codegen.config.yaml`, default `''`).
 *
 * With neither set the SQL name is `plural` — byte-identical to the output
 * before the split.
 *
 * **ADR-0004 (swe-brain) seam.** ADR-0004 decided "bounded context as a table
 * prefix now (`<context>__<table>`), a Postgres schema later
 * (`pgSchema('<context>').table('<table>')`)". `table_prefix` is the literal
 * mechanism that decision needs: a context prefix is the value `'<context>__'`.
 * The deferred knob that derives it from `entity.context` (and later swaps the
 * prefix for a `pgSchema`) belongs HERE — it replaces step 2's prefix source,
 * and the `prefix`/`base` split it needs is already the shape of step 2. An
 * explicit `table_name` stays outside both: it names a table the host owns.
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins, runtime dependencies and other
 * shipped modules.
 */

import pluralize from 'pluralize';

/** The fields of an `entity:` block (or a junction YAML) the rule reads. */
export interface TableNamingSource {
	name: string;
	/** The declared plural; `pluralize(name)` for raw YAML that bypassed the schema (which requires it). */
	plural?: string;
	/** The literal SQL table name. */
	table_name?: string | null;
	/** Overrides the project's `tables.prefix` for this one table; `''` opts out. */
	table_prefix?: string | null;
}

/**
 * The SQL table name for an entity or junction. `projectPrefix` is the resolved
 * `tables.prefix` — required, never defaulted here: a caller that forgot to
 * thread the project config must not silently emit an unprefixed table.
 */
export function sqlTableName(source: TableNamingSource, projectPrefix: string): string {
	if (typeof projectPrefix !== 'string') {
		throw new Error(
			`[codegen] sqlTableName('${source.name}'): the project table prefix is required (got ${String(projectPrefix)}) — ` +
				'thread the resolved `tables.prefix` through; an absent one must not become an unprefixed (or "undefined…") table',
		);
	}
	if (source.table_name) return source.table_name;
	const prefix = source.table_prefix ?? projectPrefix;
	const plural = source.plural || pluralize.plural(source.name);
	return `${prefix}${plural}`;
}

/** Lowercase snake_case: what `table_name` and the resolved name must be. */
export const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A prefix: empty, or lowercase snake_case (trailing `_` / `__` allowed — `crm__`). */
export const TABLE_PREFIX_PATTERN = /^([a-z][a-z0-9_]*)?$/;
