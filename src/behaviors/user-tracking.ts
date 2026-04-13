/**
 * User Tracking Behavior
 *
 * Adds created_by and updated_by fields to track which user
 * created and last modified an entity.
 * These fields are automatically managed by BaseRepository when
 * a RepositoryContext with userId is provided.
 */

import type { BehaviorDefinition } from './types';

export const userTrackingBehavior: BehaviorDefinition = {
	name: 'user_tracking',
	description: 'Adds created_by and updated_by user reference fields',

	fields: [
		{
			name: 'created_by',
			camelName: 'createdBy',
			type: 'uuid',
			tsType: 'string | null',
			drizzleType: 'uuid',
			drizzleImports: ['uuid'],
			zodType: 'z.string().uuid().nullable()',
			nullable: true,
			foreignKey: 'users.id',
			ui: {
				label: 'Created By',
				type: 'reference',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
		{
			name: 'updated_by',
			camelName: 'updatedBy',
			type: 'uuid',
			tsType: 'string | null',
			drizzleType: 'uuid',
			drizzleImports: ['uuid'],
			zodType: 'z.string().uuid().nullable()',
			nullable: true,
			foreignKey: 'users.id',
			ui: {
				label: 'Updated By',
				type: 'reference',
				importance: 'tertiary',
				group: 'metadata',
				visible: false,
			},
		},
	],

	drizzleImports: ['uuid'],

	methods: ['applyUserTrackingOnCreate', 'applyUserTrackingOnUpdate'],

	configKey: 'userTracking',
};
