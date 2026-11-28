/**
 * A choice made from a config value is a table keyed by the value, one typed row per option (Doug's rule, as
 * `TARGET_PAIRS` / `TARGET_RENDERERS`): a `Record` over the value's union, so `tsc` refuses a table missing a row, read
 * through this. A value the table has no row for is refused, naming the rows; never an if/else or a ternary on it.
 *
 * Hygen-safe: it imports nothing.
 */
export function rowFor<K extends string, R>(what: string, table: Readonly<Record<K, R>>, key: string): R {
	if (!Object.hasOwn(table, key)) {
		throw new Error(`${what} '${key}' has no row; the rows are: ${Object.keys(table).join(', ')}`);
	}
	return table[key as K];
}
