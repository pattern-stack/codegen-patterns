/**
 * Two names the TS and hygen halves must agree on — REL-2 §5 (#587).
 *
 * The allowlist is validated in TypeScript (it needs the whole relation graph)
 * but consumed by hygen templates that only see one entity's YAML. Two names
 * therefore cross that boundary, and a silent disagreement in either would be a
 * generated project that does not compile:
 *
 *  1. the finder route key (`findByUserId`) — validated by `readRouteKeys`,
 *     emitted as a method name by `prompt-extension.js#deriveQueryMethodName`;
 *  2. the emitted map's constant (`ACCOUNTS_API_INCLUDES`) — rendered by
 *     `emit-includes.ts#includesConstName`, imported by the controller under the
 *     name `prompt-extension.js` computes as `apiIncludesConst`.
 *
 * These assertions are the seam. #711 tracks collapsing the four copies of the
 * finder-name derivation onto one `.mjs` twin, the pattern
 * `src/config/runtime-mode.mjs` already uses; until then this is what keeps them
 * honest.
 */
import { describe, expect, it } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain-ESM hygen extension, no types
import { buildCleanLitePsLocals } from '../../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import { includesConstName } from '../../../emitters/relations/emit-includes';
import { deriveQueryMethodName } from '../../../schema/query-routes';

const baseEntity = {
	entity: { name: 'account', plural: 'accounts', table: 'accounts' },
	fields: {
		name: { type: 'string', required: true },
		user_id: { type: 'uuid', required: true },
		external_ref: { type: 'string' },
	},
	relationships: {
		contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
	},
};

describe('finder route keys match the method names hygen emits', () => {
	const cases: Array<{ query: Record<string, unknown>; expected: string }> = [
		{ query: { by: ['user_id'] }, expected: 'findByUserId' },
		{ query: { by: ['user_id', 'external_ref'] }, expected: 'findByUserIdAndExternalRef' },
		{ query: { by: ['name'], unique: true }, expected: 'findByName' },
		{
			query: { by: ['user_id'], select: ['external_ref'] },
			expected: 'findExternalRefsByUserId',
		},
	];

	for (const { query, expected } of cases) {
		it(`${JSON.stringify(query)} → ${expected}`, () => {
			// The TS derivation the allowlist validates against…
			expect(deriveQueryMethodName(query as { by?: string[]; select?: string[] })).toBe(
				expected,
			);
			// …and the name the template actually emits for the same declaration.
			const locals = buildCleanLitePsLocals(
				{ ...baseEntity, queries: [query] },
				{},
			) as { processedQueries: Array<{ methodName: string }> };
			expect(locals.processedQueries[0]?.methodName).toBe(expected);
		});
	}
});

describe('the allowlist constant name matches on both sides', () => {
	for (const [plural, expected] of [
		['accounts', 'ACCOUNTS_API_INCLUDES'],
		['opportunityContacts', 'OPPORTUNITY_CONTACTS_API_INCLUDES'],
		['persons', 'PERSONS_API_INCLUDES'],
	] as const) {
		it(`${plural} → ${expected}`, () => {
			expect(includesConstName(plural)).toBe(expected);
			const locals = buildCleanLitePsLocals(
				{ ...baseEntity, entity: { ...baseEntity.entity, plural } },
				{},
			) as { apiIncludesConst: string };
			expect(locals.apiIncludesConst).toBe(expected);
		});
	}
});
