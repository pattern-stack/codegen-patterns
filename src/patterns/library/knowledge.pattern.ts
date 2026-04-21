/**
 * KnowledgePattern — replaces `family: knowledge`.
 *
 * Knowledge entities hold long-form content with a workflow status and
 * semantic-search support (vectors, pending/approved states). The base
 * classes expose `semanticSearch`, pending-by-opportunity lookups, and
 * batch status updates.
 *
 * Class names, import paths, and inherited-method strings match the
 * legacy `FAMILY_MAP` entry verbatim.
 */

import { definePattern } from '../pattern-definition.js';

export const KnowledgePattern = definePattern({
	name: 'Knowledge',
	extends: ['Base'],
	repositoryClass: 'KnowledgeEntityRepository',
	serviceClass: 'KnowledgeEntityService',
	repositoryImport: '@shared/base-classes/knowledge-entity-repository',
	serviceImport: '@shared/base-classes/knowledge-entity-service',
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
		'semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
		'semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch',
	],
	description: 'Knowledge entities — semantic search + workflow status',
});
