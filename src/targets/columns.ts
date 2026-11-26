/**
 * Column renderers, keyed by the project's data layer: the `(orm, database)` pair from `target:` in
 * `codegen.config.yaml` (TGT-0, ADR-047). A renderer turns {@link FieldFacts} into that pair's column text — the
 * text really differs per pair (Drizzle's `pg-core` vs `sqlite-core`), so the pair, not either key alone, is what
 * selects it. Each pair's renderer lives at `src/targets/<orm>/<database>/columns.ts`.
 *
 * Which renderer a pair uses is bound in `./renderers.ts` (TGT-1). One pair today. The {@link RenderedColumn} shape is what `drizzle/postgres` needs and what the templates print;
 * it is not generalised until a second renderer exists and shows what the two share (ADR-047).
 *
 * Hygen-safe: reached from `entity-locals.js` and the junction prompt.
 */

import type { FieldFacts } from '../derived/columns/types.js';
import type { TargetConfig } from '../schema/codegen-config.schema.js';
import type { TargetPair } from './pairs.js';
import { renderersFor } from './renderers.js';

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

/**
 * The column renderer for the project's resolved `target` (`renderersFor`, `./renderers.ts`): required, and a pair
 * with no renderer is refused by name.
 */
export function columnRendererFor(target: TargetConfig | undefined, caller: string): ColumnRenderer {
	return renderersFor(target, caller).columns;
}
