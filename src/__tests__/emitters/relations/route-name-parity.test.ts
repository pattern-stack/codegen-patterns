/**
 * A name the TS and hygen halves must agree on — REL-2 §5 (#587).
 *
 * The allowlist is validated in TypeScript (it needs the whole relation graph)
 * but consumed by hygen templates that only see one entity's YAML, so the
 * emitted map's constant (`ACCOUNTS_API_INCLUDES`) crosses that boundary: it is
 * rendered by `emit-includes.ts#includesConstName` and imported by the
 * controller under the name `entity-locals.js` computes as `apiIncludesConst`.
 * A silent disagreement would be a generated project that does not compile.
 *
 * The finder route key used to be the second such name. Since ADR-046 B2 (#711)
 * there is one rule for it — `finderName` in `src/derived/api/names.ts`, read by
 * `build-includes.ts#readRouteKeys` and by the templates' locals alike — so
 * there is nothing left to compare; the parity gate
 * (`src/__tests__/derived/api-surface-parity.test.ts`) checks the emitted names.
 * ADR-046 B3 gives the constant one owner too and deletes this file.
 */
import { describe, expect, it } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain-ESM hygen extension, no types
import { buildBackendLocals } from '../../../../templates/entity/new/backend/entity-locals.js';
import { PROJECT_CONFIG_LOCALS } from '../../backend/_entity-lookup';
import { includesConstName } from '../../../emitters/relations/emit-includes';

const baseEntity = {
	entity: { name: 'account', plural: 'accounts' },
	fields: {
		name: { type: 'string', required: true },
		user_id: { type: 'uuid', required: true },
		external_ref: { type: 'string' },
	},
	relationships: {
		contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
	},
};

describe('the allowlist constant name matches on both sides', () => {
	for (const [plural, expected] of [
		['accounts', 'ACCOUNTS_API_INCLUDES'],
		['opportunityContacts', 'OPPORTUNITY_CONTACTS_API_INCLUDES'],
		['persons', 'PERSONS_API_INCLUDES'],
	] as const) {
		it(`${plural} → ${expected}`, () => {
			expect(includesConstName(plural)).toBe(expected);
			const locals = buildBackendLocals(
				{ ...baseEntity, entity: { ...baseEntity.entity, plural } },
				{ ...PROJECT_CONFIG_LOCALS },
			) as { apiIncludesConst: string };
			expect(locals.apiIncludesConst).toBe(expected);
		});
	}
});
