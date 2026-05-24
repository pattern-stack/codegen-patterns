/**
 * SyncedPattern — adds external-system sync columns and methods.
 *
 * Replaces the legacy `family: synced` entry in
 * `templates/entity/new/clean-lite-ps/prompt-extension.js`. Class names,
 * import paths, and inherited-method comment lines are preserved verbatim
 * so PATTERN-5's template swap produces byte-identical output for
 * pre-existing `family: synced` fixtures.
 *
 * Implies `external_id_tracking` — the behavior that contributes the
 * `external_id`, `provider`, and `provider_metadata` columns to the table.
 * An entity declaring `pattern: Synced` need not re-declare the behavior.
 */

import { definePattern } from '../pattern-definition.js';

export const SyncedPattern = definePattern({
	name: 'Synced',
	extends: ['Base'],
	repositoryClass: 'SyncedEntityRepository',
	serviceClass: 'SyncedEntityService',
	repositoryImport: '@shared/base-classes/synced-entity-repository',
	serviceImport: '@shared/base-classes/synced-entity-service',
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
		'findByExternalId, findManyByExternalIds, findAllByUserId, findVisibleByUserId',
		'syncUpsertOne, findByExternalIdProjected, softDeleteByExternalId, syncUpsert',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
		'findByExternalId, findAllByUserId, findVisibleByUserId',
	],
	impliedBehaviors: ['external_id_tracking'],
	description: 'External CRM/system sync columns and syncUpsert methods',
});
