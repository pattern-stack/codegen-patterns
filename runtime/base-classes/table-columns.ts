/**
 * Column access on a widened Drizzle table.
 *
 * Lifted out of `base-repository.ts` by REL-2 (#587) because the scope
 * predicates now need it too, and `scope-filters.ts` cannot import from
 * `base-repository.ts` — that file imports the predicates. One definition, two
 * consumers, no cycle.
 */
import { getColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Resolve a column by its camelCase key on any Drizzle table.
 *
 * Reads the table's column map via `getColumns` (1.0's replacement for the
 * deprecated `getTableColumns`) rather than string-indexing the table type:
 * under a consumer tsconfig's `noUncheckedIndexedAccess` the lookup is
 * `PgColumn | undefined`, so a missing column is a checked case rather than an
 * `undefined` handed to `eq()` / `isNull()` that renders wrong SQL or fails
 * later with an opaque error.
 *
 * `owner` names the repository (or the relation) in the error so the throw
 * points at the declaration that is wrong.
 */
export function column(table: PgTable, name: string, owner: string): PgColumn {
  if (!hasColumn(table, name)) {
    throw new Error(`${owner}: table has no column '${name}'`);
  }
  return getColumns(table)[name] as PgColumn;
}

/**
 * Whether `name` is one of the table's OWN column keys. An own-property test,
 * not a lookup: the column map is a plain object, so `getColumns(t)['toString']`
 * is `Object.prototype.toString` — truthy, and a "column" that renders as a bind
 * parameter (`order by $1`), silently ignored. A caller-supplied key
 * (`?sort_by=…`) must be asked through here.
 */
export function hasColumn(table: PgTable, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(getColumns(table), name);
}
