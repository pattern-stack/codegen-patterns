/**
 * Fixture: registry with two entries sharing the same `key`. Triggers
 * `pattern_entry_key_duplicate`.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const DuplicateEntryKeyPattern = defineOrchestrationPattern({
	name: 'DuplicateEntryKey',
	kind: 'orchestration',
	registry: {
		keyType: 'CrmAdapterDomain',
		valueType: 'ICrmPort',
		entries: [
			{ key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' },
			{ key: 'salesforce-crm', provider: 'AnotherSalesforceAdapter' },
		],
	},
});
