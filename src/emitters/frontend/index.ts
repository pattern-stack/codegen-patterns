/**
 * Frontend emitter — whole-set entry point (ADR-038, FE-2).
 *
 * `emitFrontendSet` renders the frontend tree from the full entity set in one
 * pass, deterministically (entities are emitted name-sorted). FE-2 scope:
 * base files (query-client, config), the REST api client, and collections.
 * FE-3 extends this with entities/store/fields/barrels.
 *
 * No CLI wiring lives here — FE-4 calls `emitFrontendSet` from the `entity new`
 * post-step and `gen-all`.
 */

import type { FrontendEmitContext } from './types';
import { emitBase } from './emit-base';
import { emitApi } from './emit-api';
import { emitCollections } from './emit-collections';

export type {
	FrontendEmitConfig,
	FrontendEmitContext,
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

/**
 * Emit the FE-2 slice of the frontend set (base + api + collections) into
 * `outDir`. Returns every written path in a deterministic order. Re-running
 * with the same context produces byte-identical output.
 */
export function emitFrontendSet(ctx: FrontendEmitContext, outDir: string): string[] {
	return [
		...emitBase(ctx, outDir),
		...emitApi(ctx, outDir),
		...emitCollections(ctx, outDir),
	];
}
