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
  const col: PgColumn | undefined = getColumns(table)[name];
  if (!col) {
    throw new Error(`${owner}: table has no column '${name}'`);
  }
  return col;
}
