/**
 * Column renderers, keyed by the project's data layer: the `(orm, database)` pair from `target:` in
 * `codegen.config.yaml` (TGT-0, ADR-047). A renderer turns {@link FieldFacts} into that pair's column text — the
 * text really differs per pair (Drizzle's `pg-core` vs `sqlite-core`), so the pair, not either key alone, is what
 * selects it. Each pair's renderer lives at `src/targets/<orm>/<database>/columns.ts`.
 *
 * One entry today. The {@link RenderedColumn} shape is what `drizzle/postgres` needs and what the templates print;
 * it is not generalised until a second renderer exists and shows what the two share (ADR-047).
 *
 * Hygen-safe: reached from `entity-locals.js` and the junction prompt.
 */

import type { FieldFacts } from '../derived/columns/types.js';
import type { TargetConfig } from '../schema/codegen-config.schema.js';
import { supportedTargetPairs, TARGET_PAIRS, type TargetPair } from './pairs.js';

export type { TargetPair } from './pairs.js';

/** One field's column, as the backend templates print it. */
export interface RenderedColumn {
	/** The builder the column calls (`text`, `varchar`, `enum`, …) — also the key of its import. */
	readonly drizzleType: string;
	/** The full column expression (`varchar('email', { length: 255 }).notNull()`). */
	readonly drizzleChain: string;
	/** The TypeScript type of the column in the select model. */
	readonly tsType: string;
}

export interface ColumnRenderer {
	readonly pair: TargetPair;
	render(field: FieldFacts): RenderedColumn;
	/** The module import a column builder (a {@link RenderedColumn.drizzleType}) needs; `undefined` when it needs none. */
	importFor(drizzleType: string): string | undefined;
	/**
	 * A timestamp column's builder call, `withTimezone` decided by the caller (`fieldWithTimezone` /
	 * `behaviorWithTimezone`) — the behavior and junction time columns the templates print directly (TGT-1).
	 */
	timestampColumn(column: string, withTimezone: boolean): string;
}

/** Every supported pair's column renderer, built from {@link TARGET_PAIRS} — the one table (never a second list). */
export const COLUMN_RENDERERS: Readonly<Record<TargetPair, ColumnRenderer>> = Object.fromEntries(
	TARGET_PAIRS.map((p) => [`${p.orm}/${p.database}`, p.columns]),
) as Record<TargetPair, ColumnRenderer>;

/**
 * The column renderer for the project's resolved `target`. Required: the hygen prompts read `target` from the parsed
 * config, whose schema owns the defaults, so an absent target means the caller skipped the prompt — never a reason to
 * fall back to a renderer. A `(database, orm)` pair with no renderer is refused by name.
 */
export function columnRendererFor(target: TargetConfig | undefined, caller: string): ColumnRenderer {
	if (!target || typeof target.database !== 'string' || typeof target.orm !== 'string') {
		throw new Error(
			`${caller}: target must be the project's resolved \`target\` from codegen.config.yaml; ` +
				`got ${JSON.stringify(target)}.`,
		);
	}
	const renderer = (COLUMN_RENDERERS as Partial<Record<string, ColumnRenderer>>)[`${target.orm}/${target.database}`];
	if (!renderer) {
		throw new Error(
			`${caller}: target { database: ${target.database}, orm: ${target.orm} } is not a supported pair ` +
				`(supported: ${supportedTargetPairs().join(', ')}).`,
		);
	}
	return renderer;
}
