/**
 * Template sites that still derive a name inline (ADR-046) — each named, counted and owned by an issue.
 *
 * This list ONLY SHRINKS. A count must match exactly: when a site is migrated the lint fails until its entry is
 * lowered or deleted, and a new site is never added here — it reads the derivation (`src/derived/api/`) instead.
 * Checked by `no-name-derivation-in-templates.test.ts`.
 *
 * Patterns (ids are stable; the test defines each):
 *   inline-camel-case    `.replace(/_([a-z])/g` — a hand-rolled snake → camel
 *   charat-upper-case    `.charAt(0).toUpperCase()` in an `.ejs.t` — a hand-rolled capitalisation
 *   string-built-finder  `` `findBy${ `` or `findBy<%` — a finder name assembled in place
 *   local-case-helper    a local `camelCase` / `pascalCase` definition
 */

export interface AllowlistEntry {
	/** Repo-relative template file. */
	file: string;
	pattern: 'inline-camel-case' | 'charat-upper-case' | 'string-built-finder' | 'local-case-helper';
	/** Exact number of sites; asserted present and exact. */
	count: number;
	/** What removes it. */
	issue: string;
}

export const NO_NAME_DERIVATION_ALLOWLIST: readonly AllowlistEntry[] = [
	// ── The entity backend — ADR-046 Phase B empties these ─────────────────
	{ file: 'templates/entity/new/backend/entity-locals.js', pattern: 'string-built-finder', count: 2, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/backend/entity-locals.js', pattern: 'local-case-helper', count: 1, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/backend/repository.ejs.t', pattern: 'charat-upper-case', count: 3, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/backend/repository.ejs.t', pattern: 'string-built-finder', count: 3, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/backend/service.ejs.t', pattern: 'inline-camel-case', count: 4, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/backend/service.ejs.t', pattern: 'string-built-finder', count: 2, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/prompt.js', pattern: 'inline-camel-case', count: 1, issue: 'ADR-046 Phase B' },
	{ file: 'templates/entity/new/prompt.js', pattern: 'local-case-helper', count: 1, issue: 'ADR-046 Phase B' },

	// `relationship new`'s copy of the `queries:` finder name — B2 deletes it (#711).
	{ file: 'templates/relationship/new/prompt.js', pattern: 'string-built-finder', count: 1, issue: 'ADR-046 Phase B (B2, #711)' },

	// ── Junction and relationship pipelines — converge under #679 ──────────
	{ file: 'templates/_shared/junction-fan-out.mjs', pattern: 'inline-camel-case', count: 1, issue: '#679' },
	{ file: 'templates/_shared/junction-fan-out.mjs', pattern: 'local-case-helper', count: 2, issue: '#679' },
	{ file: 'templates/junction/new/prompt.js', pattern: 'inline-camel-case', count: 1, issue: '#679' },
	{ file: 'templates/junction/new/prompt.js', pattern: 'local-case-helper', count: 2, issue: '#679' },
	{ file: 'templates/junction/new/repository.ejs.t', pattern: 'string-built-finder', count: 2, issue: '#679' },
	{ file: 'templates/junction/new/service.ejs.t', pattern: 'string-built-finder', count: 9, issue: '#679' },
	{ file: 'templates/relationship/new/prompt.js', pattern: 'inline-camel-case', count: 1, issue: '#679' },
	{ file: 'templates/relationship/new/prompt.js', pattern: 'local-case-helper', count: 2, issue: '#679' },

	// ── Elsewhere ──────────────────────────────────────────────────────────
	{ file: 'templates/broadcast/new/bridge-listener.ejs.t', pattern: 'charat-upper-case', count: 2, issue: 'unfiled (drafted at S1)' },
];
