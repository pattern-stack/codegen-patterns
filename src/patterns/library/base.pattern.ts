/**
 * BasePattern — identity pattern for the `extends` chain.
 *
 * Contributes no columns, no implied behaviors, and no config. Its only
 * purpose is to anchor the inheritance hierarchy so every other pattern
 * can declare `extends: ['Base']` and codegen can resolve that to a
 * concrete `BaseRepository` / `BaseService` reference.
 *
 * Matches the existing `family: base` entry in
 * `templates/entity/new/clean-lite-ps/prompt-extension.js` verbatim.
 */

import { definePattern } from '../pattern-definition.js';

export const BasePattern = definePattern({
	name: 'Base',
	repositoryClass: 'BaseRepository',
	serviceClass: 'BaseService',
	repositoryImport: '@shared/base-classes/base-repository',
	serviceImport: '@shared/base-classes/base-service',
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
	],
	description: 'Identity pattern — base CRUD, no extra columns or methods',
});
