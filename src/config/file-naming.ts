/**
 * The emitted-file naming rule — the ONE statement of it (NAME-2, #695/#684).
 *
 *   The filesystem is kebab-case. The database is snake_case.
 *   TypeScript identifiers follow TypeScript convention.
 *
 * Every emitted directory name and every emitted file stem goes through this
 * module. A name stays snake_case only where it *is* a database identifier:
 * the `pgTable('…')` / `pgEnum('…')` argument, a column name, and the Drizzle
 * table export whose whole job is to mirror the SQL name. Those are built from
 * `EntityModuleNaming.plural`, which `module-tree.ts` deliberately leaves
 * untouched.
 *
 * Before this module the hyphens in `find-<entity>-by-id.use-case.ts` were
 * typed characters in ~18 template literals, so a multi-word entity emitted
 * `find-deal_state-by-id.use-case.ts` and single-word entities were kebab by
 * accident (#684).
 *
 * Readers: `module-tree.ts` (directories + the entity/module/repository files),
 * the hygen prompts through `templates/_shared/entity-naming.mjs`, and
 * `orchestration-generator.ts` for its pattern slugs.
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins, runtime dependencies and other
 * shipped modules — it imports nothing.
 */

/**
 * Split a name into lowercased words, whatever case it arrives in:
 * `deal_state` / `deal-state` / `dealState` / `DealState` → `['deal','state']`.
 */
function splitWords(input: string): string[] {
	if (!input) return [];
	return input
		// camelCase / PascalCase boundaries
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		// snake_case and kebab-case separators
		.replace(/[_-]+/g, ' ')
		.split(/\s+/)
		.filter((word) => word.length > 0)
		.map((word) => word.toLowerCase());
}

/** The one kebab-case primitive. `deal_state` → `deal-state`. */
export function kebab(input: string): string {
	return splitWords(input).join('-');
}

/**
 * A directory segment of an emitted path. `deal_states` → `deal-states`.
 *
 * NOT the table name: a module folder is a filesystem name, never read back as
 * an identifier. The table reaches Drizzle from the entity's declared `plural`.
 */
export function emittedDir(name: string): string {
	return kebab(name);
}

/**
 * A file stem, from its ordered parts.
 *
 *   emittedStem('find', 'deal_state', 'by-id')  → 'find-deal-state-by-id'
 *   emittedStem('list', 'deal_states')          → 'list-deal-states'
 *   emittedStem('deal_state')                   → 'deal-state'
 *
 * Passing the parts rather than a pre-joined string is what lets a future
 * user-chosen layout reorder or drop a segment at one call site instead of
 * rewriting a template literal (NAME-2 §5).
 */
export function emittedStem(...segments: string[]): string {
	return segments
		.filter((segment) => segment != null && segment !== '')
		.map((segment) => kebab(segment))
		.filter((segment) => segment !== '')
		.join('-');
}
