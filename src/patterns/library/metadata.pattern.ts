/**
 * MetadataPattern — replaces `family: metadata`.
 *
 * Metadata entities represent history-tracked auxiliary rows attached to a
 * parent entity (audit trails, custom-field values, change logs). The base
 * classes expose entity-id + type scoped lookups and history listing.
 *
 * Class names, import paths, and inherited-method strings match the
 * legacy `FAMILY_MAP` entry verbatim.
 */

import { definePattern } from '../pattern-definition.js';

export const MetadataPattern = definePattern({
	name: 'Metadata',
	extends: ['Base'],
	repositoryClass: 'MetadataEntityRepository',
	serviceClass: 'MetadataEntityService',
	repositoryImport: '@shared/base-classes/metadata-entity-repository',
	serviceImport: '@shared/base-classes/metadata-entity-service',
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
		'findByEntityIdAndType, listByEntityId, listHistoryByEntityId',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
		'findByEntityIdAndType, listByEntityId, listHistoryByEntityId',
	],
	description:
		'History-tracked metadata rows — entity-id + type scoped lookups',
});
