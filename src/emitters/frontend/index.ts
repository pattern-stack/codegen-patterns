/**
 * Frontend emitter — whole-set entry point (ADR-038, FE-2/FE-3).
 *
 * `emitFrontendSet` renders the complete frontend tree from the full entity set
 * in one pass, deterministically (entities are emitted name-sorted). The tree:
 * base files (query-client, config), the REST api client, collections, entity
 * hooks, the store (createStore + resolvers + lookups), field metadata, and the
 * root barrel.
 *
 * No CLI wiring lives here — FE-4 calls `emitFrontendSet` from the `entity new`
 * post-step and `gen-all`.
 */

import type { FrontendEmitContext } from './types';
import { buildClientGraph, type ClientGraph } from './graph-model';
import { emitGraph } from './emit-graph';
import { emitBase } from './emit-base';
import { emitApi } from './emit-api';
import { emitCollections } from './emit-collections';
import { emitEntities } from './emit-entities';
import { emitStore } from './emit-store';
import { emitFields } from './emit-fields';
import { emitProviders } from './emit-providers';
import { emitIndex } from './emit-index';

export type {
	CatalogCategoryConfig,
	FrontendEmitConfig,
	FrontendEmitContext,
	ParsedEntity,
	ProviderCatalogInput,
	SyncMode,
} from './types';
export { resolveSyncMode, sortEntities } from './types';
export {
	loadFrontendEmitContext,
	loadProviderCatalogInputs,
	mapFrontendEmitConfig,
} from './load-context';
export type {
	FrontendConfigInput,
	LoadFrontendEmitContextResult,
} from './load-context';
export { generatedBanner, withBanner } from './emit-utils';
export { FRONTEND_EMITTED_DEPS } from './deps';
export type { FrontendEmittedDeps } from './deps';
export {
	buildQueryClientFile,
	buildConfigFile,
	emitBase,
} from './emit-base';
export {
	buildClientFile,
	buildEntityApiFile,
	buildApiIndexFile,
	emitApi,
} from './emit-api';
export {
	buildCollectionFile,
	buildCollectionsIndexFile,
	emitCollections,
} from './emit-collections';
export {
	buildEntityHooksFile,
	buildEntitiesIndexFile,
	emitEntities,
} from './emit-entities';
export {
	buildStoreIndexFile,
	buildResolversFile,
	buildLookupsFile,
	buildStoreModuleIndexFile,
	resolvableRels,
	emitStore,
} from './emit-store';
export {
	buildFieldMetaTypeFile,
	buildEntityFieldsFile,
	buildFieldsIndexFile,
	emitFields,
} from './emit-fields';
export {
	buildProvidersFile,
	emitProviders,
} from './emit-providers';
export {
	buildRootIndexFile,
	buildVersionPairingComment,
	emitIndex,
} from './emit-index';
export {
	buildClientGraph,
	junctionCollectionEntry,
	accessorNodes,
	CrossSyncModeHopError,
} from './graph-model';
export type {
	ClientGraph,
	ClientGraphNode,
	ClientRelation,
	JunctionCollectionEntry,
} from './graph-model';
export {
	buildGraphFile,
	buildEntityGraphFile,
	buildGraphIndexFile,
	emitGraph,
	graphJunctions,
	GRAPH_DIR,
	GRAPH_FILE,
	ReservedRelationAliasError,
} from './emit-graph';
export type { EmitGraphResult } from './emit-graph';
export {
	DEFAULT_TEXTAREA_THRESHOLD,
	deriveFieldMeta,
	formatLabel,
	inferUiType,
	inferUiImportance,
	isEntityRefField,
} from './field-meta';
export type {
	DerivedFieldMeta,
	FieldImportance,
	FieldType,
	InferenceOptions,
} from './field-meta';

/**
 * Emit the full frontend set into `outDir`. Returns every written path in a
 * deterministic order. Re-running with the same context produces byte-identical
 * output.
 */
export function emitFrontendSet(ctx: FrontendEmitContext, outDir: string): string[] {
	// The client relation graph is built ONCE, before anything is written, and
	// threaded through every step that needs it. Two reasons it has to be first:
	// the cross-mode check throws (FE-REL §4.4), so a set with an unbuildable hop
	// must fail before a partial tree lands on disk; and the junction collections
	// `emit-collections` writes are the ones `graph/` imports, so both steps have
	// to be looking at the same projection.
	const graph: ClientGraph | null = ctx.definitions ? buildClientGraph(ctx) : null;
	const graphResult = emitGraph(ctx, outDir, graph);

	return [
		...emitBase(ctx, outDir),
		...emitApi(ctx, outDir),
		...emitCollections(ctx, outDir, graph),
		...emitEntities(ctx, outDir),
		...emitStore(ctx, outDir),
		...emitFields(ctx, outDir),
		...emitProviders(ctx, outDir),
		...graphResult.written,
		...emitIndex(ctx, outDir, graphResult.written.length > 0),
	];
}

/**
 * Emit the full set and return what the graph step produced alongside the
 * written paths — the CLI surfaces the graph's warnings and deferrals.
 */
export function emitFrontendSetWithGraph(
	ctx: FrontendEmitContext,
	outDir: string,
): { written: string[]; graph: ClientGraph | null } {
	const graph: ClientGraph | null = ctx.definitions ? buildClientGraph(ctx) : null;
	const graphResult = emitGraph(ctx, outDir, graph);
	const written = [
		...emitBase(ctx, outDir),
		...emitApi(ctx, outDir),
		...emitCollections(ctx, outDir, graph),
		...emitEntities(ctx, outDir),
		...emitStore(ctx, outDir),
		...emitFields(ctx, outDir),
		...emitProviders(ctx, outDir),
		...graphResult.written,
		...emitIndex(ctx, outDir, graphResult.written.length > 0),
	];
	return { written, graph };
}
