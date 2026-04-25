/**
 * Fixture: happy-path orchestration pattern with one primary registry +
 * one co-keyed sibling. Used for the byte-identical golden test in
 * `src/__tests__/patterns/orchestration-emission.test.ts`.
 *
 * Carries the import-path fields (Phase 3-2 / O-3) so the generator has
 * everything it needs to emit. The `name` on the co-keyed sibling is the
 * locked Phase 3-2 / O-1 contract.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const CrmPortsPattern = defineOrchestrationPattern({
	name: 'CrmPorts',
	kind: 'orchestration',
	registry: {
		keyType: 'CrmAdapterDomain',
		keyTypeImport: '@/modules/crm/constants/adapter-domains',
		valueType: 'ICrmPort',
		valueTypeImport: '@/integrations/ports/crm.port',
		entries: [
			{
				key: 'salesforce-crm',
				provider: 'SalesforceCrmAdapter',
				providerImport: '@/integrations/salesforce/salesforce-crm.adapter',
			},
			{
				key: 'hubspot-crm',
				provider: 'HubSpotCrmAdapter',
				providerImport: '@/integrations/hubspot/hubspot-crm.adapter',
			},
		],
	},
	coKeyedRegistries: [
		{
			name: 'auth',
			keyType: 'CrmAdapterDomain',
			keyTypeImport: '@/modules/crm/constants/adapter-domains',
			valueType: 'IAuthStrategy',
			valueTypeImport: '@/integrations/ports/auth-strategy.port',
			entries: [
				{
					key: 'salesforce-crm',
					provider: 'SalesforceAuthStrategy',
					providerImport: '@/integrations/salesforce/salesforce-auth.strategy',
				},
				{
					key: 'hubspot-crm',
					provider: 'HubSpotAuthStrategy',
					providerImport: '@/integrations/hubspot/hubspot-auth.strategy',
				},
			],
		},
	],
	dispatcher: {
		className: 'CrmPortsDispatcher',
		assemblySlot: 'build',
	},
	description: 'CRM adapter dispatch by domain.',
});
