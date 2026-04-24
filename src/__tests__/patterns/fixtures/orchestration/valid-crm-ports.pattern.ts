/**
 * Fixture: happy-path orchestration pattern with one registry, two
 * entries, and a dispatcher block.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const CrmPortsPattern = defineOrchestrationPattern({
	name: 'CrmPorts',
	kind: 'orchestration',
	registry: {
		keyType: 'CrmAdapterDomain',
		valueType: 'ICrmPort',
		entries: [
			{ key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' },
			{ key: 'hubspot-crm', provider: 'HubSpotCrmAdapter' },
		],
	},
	dispatcher: {
		className: 'CrmPortsDispatcher',
		assemblySlot: 'build',
	},
	description: 'CRM adapter dispatch by domain.',
});
