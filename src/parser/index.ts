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
	loadJunctionFromYaml,
	type LoadEntitiesResult,
	type LoadRelationshipsResult,
} from './load-entities';

export {
	validateProviders,
	collectEntitySurfaces,
	resolveImportRef,
	type LoadedProvider,
	type ValidateProvidersOptions,
	type ImportRefResolution,
} from './validate-providers';

export {
	loadProviderFromYaml,
	loadProvidersFromYaml,
	type LoadProviderResult,
	type ProviderLoadResult,
	type ProviderLoadError,
} from '../utils/yaml-loader';
