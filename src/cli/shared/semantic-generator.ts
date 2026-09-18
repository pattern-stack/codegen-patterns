/**
 * Semantic model generator — CLI post-step wrapper (SEM-2, ADR-045).
 *
 * Writes `<generated>/semantic/{types,model,index}.ts`: the declared
 * `AggregateModel` for the whole schema, derived from the entity + junction
 * set. Whole-set, like the entity barrels — generating one entity re-reads
 * every YAML, so deleting a YAML drops it from the model (the ADR-017
 * contract).
 *
 * Gated on `generate.semantic`. Nothing in a generated project imports the
 * output, so a failure here warns and does not fail the command — the opposite
 * of the relations manifest, which `database.module.ts` imports.
 */

import path from 'node:path';

import {
	emitSemanticModel,
	loadSemanticEmitContext,
	SEMANTIC_OUT_SUBDIR,
	type EmitSemanticResult,
	type SemanticConfigInput,
} from '../../emitters/semantic/index.js';
import { projectLayout } from './project-layout.js';
import type { Context } from './context.js';

export interface SemanticGeneratorOptions {
	ctx: Context;
	/** Absolute path to the entities directory. Defaults to `<cwd>/entities`. */
	entitiesDir?: string;
	/** Absolute path to the junctions directory. Defaults to `<cwd>/junctions`. */
	junctionsDir?: string;
	/** Absolute path to `paths.generated`; the model lands in `<it>/semantic`. */
	generatedDir?: string;
	/** If true, compute content but don't touch the filesystem. */
	dryRun?: boolean;
}

export type SemanticGeneratorResult =
	| { skip: string; result?: undefined }
	| { skip?: undefined; result: EmitSemanticResult };

/** Is the semantic emitter switched on for this project? */
export function isSemanticEnabled(ctx: Context): boolean {
	return (
		(ctx.config as { generate?: { semantic?: unknown } } | null | undefined)?.generate
			?.semantic === true
	);
}

/** Regenerate the semantic model. Returns a skip reason when there is nothing to emit. */
export function regenerateSemanticModel(
	opts: SemanticGeneratorOptions,
): SemanticGeneratorResult {
	const { ctx, dryRun = false } = opts;
	const generatedDir = opts.generatedDir ?? projectLayout(ctx.cwd, ctx.config).generated;

	const loaded = loadSemanticEmitContext(
		ctx.cwd,
		ctx.config as SemanticConfigInput | null | undefined,
		{
			entitiesDir: opts.entitiesDir,
			junctionsDir: opts.junctionsDir ?? path.resolve(ctx.cwd, 'junctions'),
		},
	);

	if (loaded.skip !== undefined) return { skip: loaded.skip };

	// `loadSemanticEmitContext` resolves its own outDir from the config; honour
	// an explicit `generatedDir` the same way the barrel generator does, so the
	// CLI's single notion of "where generated code goes" stays authoritative.
	const outDir = path.resolve(generatedDir, SEMANTIC_OUT_SUBDIR);

	return { result: emitSemanticModel(loaded.ctx, outDir, { dryRun }) };
}
