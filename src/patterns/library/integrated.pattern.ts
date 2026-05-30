/**
 * IntegratedPattern — adds external-system integration columns and methods.
 *
 * Replaces the legacy `family: integrated` entry in
 * `templates/entity/new/clean-lite-ps/prompt-extension.js`. Class names,
 * import paths, and inherited-method comment lines are preserved verbatim
 * so PATTERN-5's template swap produces byte-identical output for
 * pre-existing `family: integrated` fixtures.
 *
 * Implies `external_id_tracking` — the behavior that contributes the
 * `external_id`, `provider`, and `provider_metadata` columns to the table.
 * An entity declaring `pattern: Integrated` need not re-declare the behavior.
 */

import { definePattern } from '../pattern-definition.js';

export const IntegratedPattern = definePattern({
	name: 'Integrated',
	extends: ['Base'],
	repositoryClass: 'IntegratedEntityRepository',
	serviceClass: 'IntegratedEntityService',
	repositoryImport: '@shared/base-classes/integrated-entity-repository',
	serviceImport: '@shared/base-classes/integrated-entity-service',
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
		'findByExternalId, findManyByExternalIds, findAllByUserId, findVisibleByUserId',
		'integrationUpsertOne, findByExternalIdProjected, softDeleteByExternalId, integrationUpsert',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
		'findByExternalId, findAllByUserId, findVisibleByUserId',
	],
	impliedBehaviors: ['external_id_tracking'],
	description: 'External CRM/system integration columns and integrationUpsert methods',
});
