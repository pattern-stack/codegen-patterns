/**
 * The junction naming rule — the ONE statement of it (JUNC-0, #678; charter I1).
 *
 * A junction's name is its endpoints in `between:` order, `<left>_<right>`, and
 * its table / module folder is `pluralize(name)`. Neither has a YAML override:
 * `JunctionDefinitionSchema` is `.strict()` and declares no `name` / `table`
 * (GATE-1, #599).
 *
 * Readers: the schema's `deriveJunctionName`, the roles validator
 * (`junctionNamesFor`), the barrel generator, and the hygen prompts through
 * `templates/_shared/junction-fan-out.mjs` (`junctionNaming`).
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins, runtime dependencies and other
 * shipped modules.
 */

import pluralize from 'pluralize';

export function junctionName(between: readonly [string, string]): string {
	return `${between[0]}_${between[1]}`;
}

export function junctionPlural(name: string): string {
	return pluralize(name);
}
