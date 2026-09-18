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

import { buildRelationsManifestFromContext, RELATIONS_MANIFEST_FILE } from './emit-manifest';
import type { RelationsEmitContext } from './types';

export type { ColumnRef, RelationEdge, RelationsEmitContext } from './types';
export { camelCase, RelationKeyCollisionError, sortEntities } from './types';
export { buildRelationGraph, junctionIdentity } from './build-graph';
export type { RelationGraph } from './build-graph';
export {
	buildRelationsManifest,
	buildRelationsManifestFromContext,
	emptyRelationsManifest,
	RELATIONS_MANIFEST_FILE,
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
	/** Non-fatal problems (unresolvable targets / junction endpoints). */
	warnings: string[];
	/** True when the manifest was actually written to disk. */
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
	const { content, warnings } = buildRelationsManifestFromContext(ctx);
	const file = path.resolve(outDir, RELATIONS_MANIFEST_FILE);

	if (opts.dryRun) return { file, content, warnings, written: false };

	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(file, content);
	return { file, content, warnings, written: true };
}
