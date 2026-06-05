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
import { emitBase } from './emit-base';
import { emitApi } from './emit-api';
import { emitCollections } from './emit-collections';
import { emitEntities } from './emit-entities';
import { emitStore } from './emit-store';
import { emitFields } from './emit-fields';
import { emitIndex } from './emit-index';

export type {
	FrontendEmitConfig,
	FrontendEmitContext,
	ParsedEntity,
	SyncMode,
} from './types';
export { resolveSyncMode, sortEntities } from './types';
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
	buildRootIndexFile,
	buildVersionPairingComment,
	emitIndex,
} from './emit-index';
export {
	deriveFieldMeta,
	formatLabel,
	inferUiType,
	inferUiImportance,
	isEntityRefField,
} from './field-meta';
export type {
	DerivedFieldMeta,
	FieldType,
	FieldImportance,
} from './field-meta';

/**
 * Emit the full frontend set into `outDir`. Returns every written path in a
 * deterministic order. Re-running with the same context produces byte-identical
 * output.
 */
export function emitFrontendSet(ctx: FrontendEmitContext, outDir: string): string[] {
	return [
		...emitBase(ctx, outDir),
		...emitApi(ctx, outDir),
		...emitCollections(ctx, outDir),
		...emitEntities(ctx, outDir),
		...emitStore(ctx, outDir),
		...emitFields(ctx, outDir),
		...emitIndex(ctx, outDir),
	];
}
