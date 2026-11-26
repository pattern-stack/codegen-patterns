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
import type {
	CheckFact,
	ColumnReferenceFact,
	ForeignKeyFact,
	IndexFact,
	UniqueFact,
} from '../derived/constraints/types.js';
import type { TargetConfig } from '../schema/codegen-config.schema.js';
import type { TargetPair } from './pairs.js';
import { renderersFor } from './renderers.js';

/** A pair's constraint renderer; generic over the pair's key, as `ColumnRenderer` is. */
export interface ConstraintRenderer<P extends string = TargetPair> {
	readonly pair: P;
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
	/** A uniqueness rule, with the builder it calls and the pair's note on it (`null` when there is nothing to say). */
	unique(unique: UniqueFact, tableParam: string): RenderedConstraint;
	/** A composite foreign key, as an entry of the extra-config callback. */
	foreignKey(foreignKey: ForeignKeyFact, tableParam: string): string;
	/** A CHECK, as an entry of the extra-config callback. */
	check(check: CheckFact, tableParam: string): string;
}

/** One extra-config entry as the pair writes it. */
export interface RenderedConstraint {
	readonly expr: string;
	/** The builder the entry calls — also the key of its import. */
	readonly builder: string;
	readonly comment: string | null;
}

/** The constraint renderer for the project's resolved `target` (`renderersFor`: required; an unsupported pair refused). */
export function constraintRendererFor(target: TargetConfig | undefined, caller: string): ConstraintRenderer {
	return renderersFor(target, caller).constraints;
}
