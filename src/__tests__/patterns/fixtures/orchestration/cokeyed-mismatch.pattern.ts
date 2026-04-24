/**
 * Fixture: orchestration pattern whose co-keyed registry has a different
 * `keyType` than the primary registry. Triggers
 * `pattern_cokeyed_keytype_mismatch`.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const CoKeyedMismatchPattern = defineOrchestrationPattern({
	name: 'CoKeyedMismatch',
	kind: 'orchestration',
	registry: {
		keyType: 'CrmAdapterDomain',
		valueType: 'ICrmPort',
		entries: [{ key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' }],
	},
	coKeyedRegistries: [
		{
			keyType: 'AnotherKeySpace',
			valueType: 'ICrmAuthStrategy',
			entries: [
				{ key: 'salesforce-crm', provider: 'SalesforceCrmAuthStrategy' },
			],
		},
	],
});
