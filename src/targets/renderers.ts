/**
 * Each supported pair's renderers (TGT-1, ADR-047) — the one place a `(database, orm)` pair is bound to the code that
 * writes its text. `TARGET_PAIRS` (`./pairs.ts`) is the rows only, so the config schema that reads them imports no
 * renderer.
 *
 * Typed `{ [P in TargetPair]: … }`: `tsc` refuses a row of `TARGET_PAIRS` with no entry here, and an entry for a pair
 * the table lacks — a pair still cannot be accepted without its renderers, now checked at compile time.
 *
 * Hygen-safe: reached from `entity-locals.js` and the junction prompt.
 */

import type { TargetConfig } from '../schema/codegen-config.schema.js';
import type { ColumnRenderer } from './columns.js';
import type { ConstraintRenderer } from './constraints.js';
import { drizzlePostgresColumns } from './drizzle/postgres/columns.js';
import { drizzlePostgresConstraints } from './drizzle/postgres/constraints.js';
import { drizzleSqliteColumns } from './drizzle/sqlite/columns.js';
import { drizzleSqliteConstraints } from './drizzle/sqlite/constraints.js';
import { supportedTargetPairs, type TargetPair } from './pairs.js';

/** What one pair renders with. A renderer joins as its text moves behind the target (TGT-N). */
export interface PairRenderers {
	readonly columns: ColumnRenderer;
	readonly constraints: ConstraintRenderer;
}

export const TARGET_RENDERERS: { readonly [P in TargetPair]: PairRenderers } = {
	'drizzle/postgres': { columns: drizzlePostgresColumns, constraints: drizzlePostgresConstraints },
	'drizzle/sqlite': { columns: drizzleSqliteColumns, constraints: drizzleSqliteConstraints },
};

/**
 * The renderers for the project's resolved `target`. Required: the hygen prompts read `target` from the parsed config,
 * whose schema owns the defaults, so an absent target means the caller skipped the prompt — never a reason to fall
 * back to a renderer. A `(database, orm)` pair with no renderers is refused by name.
 */
export function renderersFor(target: TargetConfig | undefined, caller: string): PairRenderers {
	if (!target || typeof target.database !== 'string' || typeof target.orm !== 'string') {
		throw new Error(
			`${caller}: target must be the project's resolved \`target\` from codegen.config.yaml; ` +
				`got ${JSON.stringify(target)}.`,
		);
	}
	const renderers = (TARGET_RENDERERS as Partial<Record<string, PairRenderers>>)[`${target.orm}/${target.database}`];
	if (!renderers) {
		throw new Error(
			`${caller}: target { database: ${target.database}, orm: ${target.orm} } is not a supported pair ` +
				`(supported: ${supportedTargetPairs().join(', ')}).`,
		);
	}
	return renderers;
}
