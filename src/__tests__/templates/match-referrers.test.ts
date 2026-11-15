import { describe, expect, it } from 'bun:test';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { matchReferrers } from '../../../templates/_shared/inheritance.mjs';

describe('matchReferrers', () => {
	it('throws without a lookup instead of answering "no referrers"', () => {
		expect(() => matchReferrers(null, 'communication')).toThrow(/needs an entity lookup/);
	});

	it('an empty lookup has no referrers', () => {
		expect(matchReferrers(entityLookupFrom([]), 'communication')).toEqual([]);
	});
});
