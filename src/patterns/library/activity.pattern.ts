/**
 * ActivityPattern — replaces `family: activity`.
 *
 * Activity entities represent time-bounded interactions (calls, meetings,
 * emails). The base repository/service expose date-range + opportunity +
 * user-scoped lookups on top of the standard CRUD methods.
 *
 * Class names, import paths, and inherited-method strings match the
 * legacy `FAMILY_MAP` entry verbatim so PATTERN-5's template swap produces
 * byte-identical output.
 */

import { definePattern } from '../pattern-definition.js';

export const ActivityPattern = definePattern({
	name: 'Activity',
	extends: ['Base'],
	repositoryClass: 'ActivityEntityRepository',
	serviceClass: 'ActivityEntityService',
	repositoryImport: '@shared/base-classes/activity-entity-repository',
	serviceImport: '@shared/base-classes/activity-entity-service',
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
		'findByDateRange, findByUserId, findByOpportunityId, findRecentByOpportunityId',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
		'findByDateRange, findByUserId, findByOpportunityId, findRecentByOpportunityId',
	],
	description:
		'Time-bounded interaction entities — date-range + opportunity scoped lookups',
});
