/**
 * The junction naming rule — the ONE statement of it (JUNC-0, #678; charter I1).
 *
 * A junction's name is its endpoints in `between:` order, `<left>_<right>`, and
 * its plural (export / module folder) is `pluralize(name)`. Neither has a YAML
 * override: `JunctionDefinitionSchema` is `.strict()` and declares no `name`
 * (GATE-1, #599). Its SQL table name is the shared table rule over that plural
 * (`junctionTableName`, TABLE-0): `table:` / `table_prefix:` reach the
 * database name only.
 *
 * Readers: the schema's `deriveJunctionName`, the roles validator
 * (`junctionNamesFor`), the barrel generator, and the hygen prompts through
 * `templates/_shared/junction-fan-out.mjs` (`junctionNaming`).
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins, runtime dependencies and other
 * shipped modules.
 */

import path from 'node:path';
import pluralize from 'pluralize';
import { sqlTableName } from './table-naming.js';
import { entityModuleNaming } from './module-tree.js';
import { emittedStem } from './file-naming.js';

export function junctionName(between: readonly [string, string]): string {
	return `${between[0]}_${between[1]}`;
}

export function junctionPlural(name: string): string {
	return pluralize(name);
}

/**
 * A junction's `.wiring.ts` under plain wiring (PW-3c): `<modules_dir>/<plural>/<name>.wiring.ts`. The junction prompt
 * writes it and the composition imports it, both from here.
 */
export function junctionWiringFile(name: string, modulesDir: string): string {
	const moduleDir = path.posix.normalize(entityModuleNaming({ name, plural: junctionPlural(name) }, modulesDir).moduleDir);
	return `${moduleDir}/${emittedStem(name)}.wiring.ts`;
}

/** The junction-YAML keys the SQL table name reads. */
export interface JunctionTableSource {
	between: readonly [string, string];
	table?: string | null;
	table_prefix?: string | null;
}

/**
 * A junction's SQL table name — `sqlTableName` over the derived name/plural
 * (TABLE-0). `projectPrefix` is the resolved `tables.prefix`, required.
 */
export function junctionTableName(def: JunctionTableSource, projectPrefix: string): string {
	const name = junctionName(def.between);
	return sqlTableName(
		{ name, plural: junctionPlural(name), table: def.table, table_prefix: def.table_prefix },
		projectPrefix,
	);
}
