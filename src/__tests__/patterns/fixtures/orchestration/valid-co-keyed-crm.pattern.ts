/**
 * Fixture: co-keyed orchestration pattern — primary registry plus one
 * sibling registry that shares the primary's keyType.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const CrmPortsCoKeyedPattern = defineOrchestrationPattern({
	name: 'CrmPortsCoKeyed',
	kind: 'orchestration',
	registry: {
		keyType: 'CrmAdapterDomain',
		valueType: 'ICrmPort',
		entries: [
			{ key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' },
			{ key: 'hubspot-crm', provider: 'HubSpotCrmAdapter' },
		],
	},
	coKeyedRegistries: [
		{
			keyType: 'CrmAdapterDomain',
			valueType: 'ICrmAuthStrategy',
			entries: [
				{ key: 'salesforce-crm', provider: 'SalesforceCrmAuthStrategy' },
				{ key: 'hubspot-crm', provider: 'HubSpotCrmAuthStrategy' },
			],
		},
	],
});
