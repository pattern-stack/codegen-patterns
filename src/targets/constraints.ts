/**
 * Constraint renderers, keyed by the project's `(database, orm)` pair (TGT-1, ADR-047): constraint facts
 * (`src/derived/constraints/`) → that pair's text. Bound per pair in `./renderers.ts`; each lives at
 * `src/targets/<orm>/<database>/constraints.ts`.
 *
 * The interface is what `drizzle/postgres` needs and the templates print, grown one constraint kind at a time as its
 * text moves behind the target. It is not generalised until a second renderer exists (ADR-047 decision 8).
 *
 * Hygen-safe: reached from `entity-locals.js` and the junction prompt.
 */

import type { PredicateSegment } from '../derived/constraints/predicate.js';
import type { ColumnReferenceFact, IndexFact } from '../derived/constraints/types.js';
import type { TargetConfig } from '../schema/codegen-config.schema.js';
import type { TargetPair } from './pairs.js';
import { renderersFor } from './renderers.js';

export interface ConstraintRenderer {
	readonly pair: TargetPair;
	/**
	 * A tokenized predicate as the body of the pair's raw-SQL expression, its column references written against the
	 * table callback's parameter (`tableParam`, required).
	 */
	predicate(segments: readonly PredicateSegment[], tableParam: string): string;
	/**
	 * The suffix a column's builder chain gains to reference another table's column: a field `foreign_key:`, a
	 * `belongs_to`, a junction endpoint.
	 */
	columnReference(reference: ColumnReferenceFact): string;
	/** A plain index, as an entry of the table's extra-config callback over `tableParam`. */
	index(index: IndexFact, tableParam: string): string;
}

/** The constraint renderer for the project's resolved `target` (`renderersFor`: required; an unsupported pair refused). */
export function constraintRendererFor(target: TargetConfig | undefined, caller: string): ConstraintRenderer {
	return renderersFor(target, caller).constraints;
}
