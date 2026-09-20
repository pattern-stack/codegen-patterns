/**
 * Relations emitter — whole-set entry point (ADR-044, REL-1).
 *
 * `emitRelationsManifest` renders `<generated>/relations.ts` — one
 * `defineRelations()` over the generated schema barrel — from the full entity +
 * junction set in one pass. It is a CROSS-ENTITY file, so it is a whole-set TS
 * emitter (the ADR-038 precedent), never a hygen inject.
 *
 * The CLI calls it from the `entity new` / `junction new` / `relationship new`
 * post-steps, wherever `regenerateBarrels` runs. `project init` calls
 * `emptyRelationsManifest` for the same file before any entity exists.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildRelationGraph } from './build-graph';
import { buildIncludeAllowlists } from './build-includes';
import { API_INCLUDES_FILE, buildApiIncludes } from './emit-includes';
import { buildRelationsManifest, RELATIONS_MANIFEST_FILE } from './emit-manifest';
import { DEFAULT_SCOPE_FILTERS_IMPORT } from './emit-manifest';
import type { RelationsEmitContext } from './types';

export type { ColumnRef, RelationEdge, RelationsEmitContext } from './types';
export { camelCase, RelationKeyCollisionError, sortEntities } from './types';
export { buildRelationGraph, entityScope, junctionIdentity } from './build-graph';
export type { RelationGraph } from './build-graph';
export {
	buildIncludeAllowlists,
	IncludeAllowlistError,
	readRouteKeys,
} from './build-includes';
export type {
	CompiledEntityIncludes,
	CompiledIncludePath,
	CompiledIncludeRoute,
} from './build-includes';
export { API_INCLUDES_FILE, buildApiIncludes, includesConstName } from './emit-includes';
export {
	buildRelationsManifest,
	buildRelationsManifestFromContext,
	DEFAULT_SCOPE_FILTERS_IMPORT,
	emptyRelationsManifest,
	RELATIONS_MANIFEST_FILE,
	scopeConstName,
} from './emit-manifest';
export {
	loadEntityDefinitions,
	loadJunctionDefinitions,
	loadRelationsEmitContext,
} from './load-context';
export type {
	LoadRelationsEmitContextResult,
	RelationsConfigInput,
} from './load-context';

export interface EmitRelationsResult {
	/** Absolute path of the written manifest. */
	file: string;
	/** Planned content — always populated, useful for dry-run reports. */
	content: string;
	/** Absolute path of the written HTTP include allowlist (REL-2 §5). */
	includesFile: string;
	/** Planned allowlist content. Always populated; whole-set, like the manifest. */
	includesContent: string;
	/** Non-fatal problems (unresolvable targets / junction endpoints, skipped transitive relationships). */
	warnings: string[];
	/** True when both files were actually written to disk. */
	written: boolean;
}

/**
 * Emit the manifest into `outDir`. Complete-file write, deterministic for a
 * given context, safe to re-run.
 *
 * Throws {@link RelationKeyCollisionError} when two declarations claim the same
 * relation key on one table — the manifest is load-bearing for compilation, so
 * that is a hard failure, not a warning (docs/specs/REL-1.md §3).
 */
export function emitRelationsManifest(
	ctx: RelationsEmitContext,
	outDir: string,
	opts: { dryRun?: boolean } = {},
): EmitRelationsResult {
	// One graph, two files. The allowlist resolves dot paths against the SAME
	// edges the manifest emits, so an allowlist can never name a relation the
	// manifest does not carry (charter I1 — one derivation, not two).
	const graph = buildRelationGraph(ctx);
	const content = buildRelationsManifest(
		graph,
		'./schema',
		ctx.scopeFiltersImport ?? DEFAULT_SCOPE_FILTERS_IMPORT,
	);
	const includesContent = buildApiIncludes(buildIncludeAllowlists(ctx, graph));

	const file = path.resolve(outDir, RELATIONS_MANIFEST_FILE);
	const includesFile = path.resolve(outDir, API_INCLUDES_FILE);

	if (opts.dryRun) {
		return {
			file,
			content,
			includesFile,
			includesContent,
			warnings: graph.warnings,
			written: false,
		};
	}

	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(file, content);
	fs.writeFileSync(includesFile, includesContent);
	return {
		file,
		content,
		includesFile,
		includesContent,
		warnings: graph.warnings,
		written: true,
	};
}
