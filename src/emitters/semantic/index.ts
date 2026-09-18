/**
 * Semantic emitter — whole-set entry point (SEM-2, ADR-045).
 *
 * `emitSemanticModel` renders `<generated>/semantic/` — the declared
 * `AggregateModel` the semantic-query layer runs against — from the full entity
 * + junction set in one pass. It is a CROSS-ENTITY artifact, so it is a
 * whole-set TS emitter (the ADR-038 precedent), never a hygen inject.
 *
 * The CLI calls it from the `entity new` post-step, gated on
 * `generate.semantic`. Nothing in a generated project imports the output, so a
 * failure prints and does not stop the command — unlike the relations manifest,
 * which is load-bearing for compilation.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildSemanticIndex, SEMANTIC_INDEX_FILE } from './emit-index';
import { buildSemanticModelSource, SEMANTIC_MODEL_FILE, TYPES_MODULE } from './emit-model';
import { buildSemanticTypes } from './emit-types';
import { buildSemanticModel } from './build-model';
import type { SemanticEmitContext } from './types';

export type {
	Additivity,
	Agg,
	AggColType,
	DerivedExprNode,
	SemanticEmitContext,
	SemanticEntity,
	SemanticField,
	SemanticMetric,
	SemanticModel,
	SemanticRelationship,
} from './types';
export { sortEntities } from './types';
export { buildSemanticModel, junctionIdentity } from './build-model';
export { buildSemanticModelSource, GENERATED_BANNER, SEMANTIC_MODEL_FILE, TYPES_MODULE } from './emit-model';
export { buildSemanticTypes } from './emit-types';
export { buildSemanticIndex, SEMANTIC_INDEX_FILE } from './emit-index';
export {
	loadJunctionDefinitions,
	loadSemanticEmitContext,
	SEMANTIC_OUT_SUBDIR,
} from './load-context';
export type {
	LoadSemanticEmitContextResult,
	SemanticConfigInput,
} from './load-context';

export const SEMANTIC_TYPES_FILE = 'types.ts';

export interface EmitSemanticResult {
	/** Absolute directory the model was written into. */
	outDir: string;
	/** File names written, relative to `outDir`, sorted. */
	written: string[];
	/** Rendered contents keyed by file name — populated even on a dry run. */
	contents: Record<string, string>;
	/** Non-fatal problems (unresolvable targets / junction endpoints). */
	warnings: string[];
}

/**
 * Emit the semantic model into `outDir`. Complete-file writes, deterministic
 * for a given context, safe to re-run.
 *
 * `types.ts` is emitted only while the vocabulary is vendored — see
 * `emit-types.ts` for what changes when the package publishes.
 */
export function emitSemanticModel(
	ctx: SemanticEmitContext,
	outDir: string,
	opts: { dryRun?: boolean } = {},
): EmitSemanticResult {
	const model = buildSemanticModel(ctx);

	const contents: Record<string, string> = {
		[SEMANTIC_MODEL_FILE]: buildSemanticModelSource(model),
		[SEMANTIC_INDEX_FILE]: buildSemanticIndex(),
	};
	if (TYPES_MODULE === './types') {
		contents[SEMANTIC_TYPES_FILE] = buildSemanticTypes();
	}

	const written = Object.keys(contents).sort();

	if (opts.dryRun) {
		return { outDir, written: [], contents, warnings: model.warnings };
	}

	fs.mkdirSync(outDir, { recursive: true });
	for (const file of written) {
		fs.writeFileSync(path.join(outDir, file), contents[file]!);
	}
	return { outDir, written, contents, warnings: model.warnings };
}
