/**
 * Relation-key naming (REL-1 / REL-2), dependency-free so the hygen templates can import it from the published
 * package without pulling the relations emitter.
 */

/** snake_case / kebab-case → camelCase. Local by design (frontend emitter precedent). */
export function camelCase(input: string): string {
	return input.replace(/[-_\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A declared include path in RELATION-KEY form — each segment through `camelCase` (#742), so `fantasy_teams.owner`
 * is `fantasyTeams.owner`. What a client sends in `?include=`; the allowlist compile (`build-includes.ts`) walks the
 * same keys.
 */
export function includePathKey(declared: string): string {
	return declared
		.split('.')
		.map((s) => camelCase(s.trim()))
		.join('.');
}
