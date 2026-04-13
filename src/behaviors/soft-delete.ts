/**
 * Soft Delete Behavior
 *
 * Adds deleted_at field for soft delete functionality.
 * Records are marked as deleted instead of being removed from the database.
 * BaseRepository automatically filters soft-deleted records in queries.
 */

import type { BehaviorDefinition } from './types';

export const softDeleteBehavior: BehaviorDefinition = {
	name: 'soft_delete',
	description: 'Adds deleted_at field for soft delete functionality',

	fields: [
		{
			name: 'deleted_at',
			camelName: 'deletedAt',
			type: 'datetime',
			tsType: 'Date | null',
			drizzleType: 'timestamp',
			drizzleImports: ['timestamp'],
			zodType: 'z.coerce.date().nullable()',
			nullable: true,
			ui: {
				label: 'Deleted At',
				type: 'datetime',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
	],

	drizzleImports: ['timestamp'],

	methods: [
		'softDelete',
		'restore',
		'findWithDeleted',
		'findOnlyDeleted',
		'baseQuery', // Modified to filter deleted records
	],

	configKey: 'softDelete',
};
