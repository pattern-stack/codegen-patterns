/**
 * Parser Module
 *
 * Exports entity and relationship loading and parsing utilities.
 */

export {
	loadEntities,
	loadRelationships,
	resolveReferences,
	resolveRelationshipReferences,
	loadEntityFromYaml,
	loadRelationshipFromYaml,
	type LoadEntitiesResult,
	type LoadRelationshipsResult,
} from './load-entities';
