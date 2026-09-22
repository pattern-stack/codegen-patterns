/**
 * Relations manifest generator — CLI post-step wrapper (ADR-044, REL-1).
 *
 * Writes `<generated>/relations.ts`: one `defineRelations()` over the generated
 * schema barrel, derived from the full entity + junction set. Whole-set, like
 * the entity barrels — generating one entity re-reads every YAML, so deleting a
 * YAML drops its edges from the graph (the ADR-017 contract).
 *
 * Runs wherever `regenerateBarrels` runs: `entity new`, `junction new`,
 * `relationship new`. `project init` writes the empty shape for the same path
 * (`init-scaffold.ts`) so the emitted `database.module.ts` import resolves on a
 * project with no entities yet.
 */

import path from 'node:path';

import {
	emitRelationsManifest,
	loadRelationsEmitContext,
	type EmitRelationsResult,
	type RelationsConfigInput,
} from '../../emitters/relations/index.js';
import { projectLayout } from './project-layout.js';
import type { Context } from './context.js';

export interface RelationsGeneratorOptions {
	ctx: Context;
	/** Absolute path to the entities directory. Defaults to `<cwd>/entities`. */
	entitiesDir?: string;
	/** Absolute path to the junctions directory. Defaults to `<cwd>/junctions`. */
	junctionsDir?: string;
	/** Absolute path to the directory the manifest is written into. */
	generatedDir?: string;
	/** If true, compute content but don't touch the filesystem. */
	dryRun?: boolean;
}

/**
 * Regenerate the manifest.
 *
 * Propagates `RelationKeyCollisionError` — the caller must surface it as an
 * ERROR and fail the command, not warn. The manifest is load-bearing for
 * compilation (the emitted `database.module.ts` imports it), so continuing past
 * a collision ships a project that does not build (docs/specs/REL-1.md §3).
 */
export function regenerateRelationsManifest(
	opts: RelationsGeneratorOptions,
): EmitRelationsResult {
	const { ctx, dryRun = false } = opts;
	const generatedDir = opts.generatedDir ?? projectLayout(ctx.cwd, ctx.config).generated;

	const { ctx: emitCtx } = loadRelationsEmitContext(
		ctx.cwd,
		ctx.config as RelationsConfigInput | null | undefined,
		{
			entitiesDir: opts.entitiesDir,
			junctionsDir: opts.junctionsDir ?? path.resolve(ctx.cwd, 'junctions'),
		},
	);

	return emitRelationsManifest(emitCtx, generatedDir, { dryRun });
}
