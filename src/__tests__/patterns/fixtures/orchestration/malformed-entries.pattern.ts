/**
 * Fixture: registry with one well-formed and one malformed entry
 * (missing `provider`). Triggers `pattern_entry_malformed`.
 *
 * Note: the loader's `assertOrchestrationContribution` requires a
 * non-empty `entries[]`, so we keep at least one valid entry here and
 * exercise the validator's per-entry malformed check on the second one.
 * The "empty entries" loader-level case is exercised inline in the test
 * file via a literal definition that bypasses the loader.
 */

import type { OrchestrationPatternDefinition } from '../../../../patterns/pattern-definition.ts';

// Cast through unknown so TS lets us produce a deliberately malformed
// entry for the validator to flag. Real consumer code uses
// `defineOrchestrationPattern` which would catch this at compile time.
export const MalformedEntriesPattern: OrchestrationPatternDefinition = {
	name: 'MalformedEntries',
	kind: 'orchestration',
	registry: {
		keyType: 'CrmAdapterDomain',
		valueType: 'ICrmPort',
		entries: [
			{ key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' },
			{ key: 'hubspot-crm', provider: '' as unknown as string },
		],
	},
};
