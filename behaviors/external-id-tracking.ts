/**
 * External ID Tracking Behavior
 *
 * Adds external_id, provider, and provider_metadata fields to track
 * records that are synced from external systems (e.g., Salesforce, HubSpot).
 */

import type { BehaviorDefinition } from './types';

export const externalIdTrackingBehavior: BehaviorDefinition = {
	name: 'external_id_tracking',
	description: 'Adds external_id, provider, and provider_metadata fields for external system sync tracking',

	fields: [
		{
			name: 'external_id',
			camelName: 'externalId',
			type: 'string',
			tsType: 'string | null',
			drizzleType: 'varchar',
			drizzleImports: ['varchar', 'index'],
			zodType: 'z.string().nullable()',
			nullable: true,
			ui: {
				label: 'External ID',
				type: 'text',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
		{
			name: 'provider',
			camelName: 'provider',
			type: 'string',
			tsType: 'string | null',
			drizzleType: 'varchar',
			drizzleImports: ['varchar'],
			zodType: 'z.string().nullable()',
			nullable: true,
			ui: {
				label: 'Provider',
				type: 'text',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
		{
			name: 'provider_metadata',
			camelName: 'providerMetadata',
			type: 'json',
			tsType: 'unknown | null',
			drizzleType: 'jsonb',
			drizzleImports: ['jsonb'],
			zodType: 'z.unknown().nullable()',
			nullable: true,
			ui: {
				label: 'Provider Metadata',
				type: 'json',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
	],

	drizzleImports: ['varchar', 'jsonb', 'index'],

	configKey: 'externalIdTracking',
};
