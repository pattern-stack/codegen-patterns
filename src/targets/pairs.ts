/**
 * The supported data-layer pairs — the ONE table every reader of `target:` derives from (TGT-0, ADR-047):
 *
 * - the config schema (`TargetConfigSchema`, `src/schema/codegen-config.schema.ts`) is a union of these pairs, so
 *   validation and editor completion offer exactly them;
 * - the renderer binding (`TARGET_RENDERERS`, `src/targets/renderers.ts`) must have an entry for every row, and `tsc`
 *   refuses one missing (TGT-1: the rows carry no renderer, so the config schema imports none);
 * - the refusal of an unsupported pair names them.
 *
 * A pair is `(orm, database)` because the column text is the pair's (Drizzle's `pg-core` vs `sqlite-core`). Add a
 * row when a pair's renderer exists and passes the same gates — never a second list anywhere else.
 *
 * Hygen-safe: reached from the config schema and `entity-locals.js`; it imports nothing.
 */

export const TARGET_PAIRS = [
	{
		orm: 'drizzle',
		database: 'postgres',
		ormDescription: 'Drizzle ORM: tables, columns and repositories written against drizzle-orm',
		databaseDescription: 'PostgreSQL: pg-core column builders, node-postgres driver on Node',
	},
] as const;

/** The default pair, when `target:` is absent — the first row. */
export const DEFAULT_TARGET_PAIR = TARGET_PAIRS[0];

export type TargetOrm = (typeof TARGET_PAIRS)[number]['orm'];
export type TargetDatabase = (typeof TARGET_PAIRS)[number]['database'];

/** A pair's key, `<orm>/<database>` — also its renderer's folder under `src/targets/`. One per row, never the product. */
export type TargetPair = (typeof TARGET_PAIRS)[number] extends infer R
	? R extends { orm: infer O extends string; database: infer D extends string }
		? `${O}/${D}`
		: never
	: never;

/** The supported pairs as `target:` spells them, for messages and docs: `{ database: postgres, orm: drizzle }`. */
export function supportedTargetPairs(
	pairs: ReadonlyArray<{ readonly database: string; readonly orm: string }> = TARGET_PAIRS,
): string[] {
	return pairs.map((p) => `{ database: ${p.database}, orm: ${p.orm} }`);
}
