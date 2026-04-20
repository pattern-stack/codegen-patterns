/**
 * Analyzer Module
 *
 * Exports graph building, consistency checking, statistics,
 * transitive suggestion, and manifest utilities.
 */

export {
	buildDomainGraph,
	getRelatedEntities,
	findOrphanEntities,
	findCircularDependencies,
	buildEntityNodes,
	topoSortEntities,
} from './graph-builder';

export { checkConsistency } from './consistency-checker';

export {
	computeStatistics,
	getFieldBreakdown,
	getUiMetadataCoverage,
} from './statistics';

export { suggestTransitiveRelationships } from './transitive-suggester';

export {
	getManifestDir,
	getManifestPaths,
	computeEntityFilesHash,
	readManifest,
	writeManifest,
	isManifestStale,
	buildManifest,
	updateSuggestionStatus,
	updateAllSuggestionStatus,
	getPendingSuggestions,
} from './manifest';

export { serializeDomainGraph } from './serialize-graph';
export type { SerializedDomainGraph } from './serialize-graph';

export * from './types';
