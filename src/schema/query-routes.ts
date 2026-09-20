/**
 * Finder-method names derived from a `queries:` declaration.
 *
 * REL-2 (#587) needs these in TypeScript to validate an `api.includes` route key
 * (§5.1: the route keys are `find_by_id`, `list`, and one per `queries:` entry by
 * its finder name). The same derivation already exists three times in the hygen
 * half — `templates/entity/new/prompt.js`, `clean-lite-ps/prompt-extension.js` and
 * `templates/relationship/new/prompt.js` — which is a pre-existing triplication
 * this file does not fix; #711 tracks collapsing all four onto one `.mjs` twin,
 * the pattern `src/config/runtime-mode.mjs` already uses.
 *
 * A unit test pins this against the emitted method names so the copies cannot
 * drift silently while the allowlist trusts this one.
 */

/** `field_definition_id` → `FieldDefinitionId`. */
function pascalCase(input: string): string {
	return input
		.split(/[-_\s]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

/** The declaration shape this reads — the by/select halves of a `queries:` entry. */
export interface QueryMethodNameInput {
	by?: readonly string[] | undefined;
	select?: readonly string[] | undefined;
}

/**
 * `findByUserIdAndAccountId` / `findEmailsByOpportunityId`.
 *
 * With a `select:` projection the picked fields come first and are pluralised;
 * otherwise it is `findBy` + the `by:` columns joined by `And`.
 */
export function deriveQueryMethodName(query: QueryMethodNameInput): string {
	const byPart = (query.by ?? []).map(pascalCase).join('And');
	const selectFields = query.select ?? [];
	if (selectFields.length > 0) {
		const selectPart = `${selectFields.map(pascalCase).join('And')}s`;
		return `find${selectPart}By${byPart}`;
	}
	return `findBy${byPart}`;
}
