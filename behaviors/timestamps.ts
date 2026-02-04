/**
 * Timestamps Behavior
 *
 * Adds created_at and updated_at fields to track entity lifecycle.
 * These fields are automatically managed by BaseRepository.
 */

import type { BehaviorDefinition } from './types';

export const timestampsBehavior: BehaviorDefinition = {
	name: 'timestamps',
	description: 'Adds created_at and updated_at timestamp fields',

	fields: [
		{
			name: 'created_at',
			camelName: 'createdAt',
			type: 'datetime',
			tsType: 'Date',
			drizzleType: 'timestamp',
			drizzleImports: ['timestamp'],
			zodType: 'z.coerce.date()',
			nullable: false,
			default: 'now()',
			ui: {
				label: 'Created At',
				type: 'datetime',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
		{
			name: 'updated_at',
			camelName: 'updatedAt',
			type: 'datetime',
			tsType: 'Date',
			drizzleType: 'timestamp',
			drizzleImports: ['timestamp'],
			zodType: 'z.coerce.date()',
			nullable: false,
			default: 'now()',
			ui: {
				label: 'Updated At',
				type: 'datetime',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
	],

	drizzleImports: ['timestamp'],

	methods: ['applyTimestampsOnCreate', 'applyTimestampsOnUpdate'],

	configKey: 'timestamps',
};
