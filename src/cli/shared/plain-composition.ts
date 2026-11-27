/**
 * The plain-wiring composition as a CLI post-step (PW-3a, PW-3c): `entity new` and `junction new` both write it, from
 * one place that builds its input.
 */

import { CODEGEN_BANNER } from '../../utils/generated-file.js';
import path from 'node:path';

import type { Context } from './context.js';
import { projectLayout } from './project-layout.js';
import { junctionsDirFor } from '../../config/junctions-dir.js';
import { loadProjectApiContext } from '../../derived/api/project.js';
import type { RelationsConfigInput } from '../../emitters/relations/load-context.js';
import {
	emitComposition,
	wiringFilesBehind,
	type CompositionFile,
} from '../../emitters/composition/emit-composition.js';
import { removeOtherWiringFiles } from '../../emitters/composition/stale-files.js';
import { openApiImport, resolveRuntimeMode, runtimeImport } from './runtime-import.js';
import { printInfo, printWarning } from '../ui/output.js';

export interface PlainCompositionDirs {
	entitiesDir: string;
	relationshipsDir: string;
	generatedDir: string;
}

function relationsOf(ctx: Context, dirs: PlainCompositionDirs) {
	return loadProjectApiContext(ctx.cwd, ctx.config as RelationsConfigInput | null | undefined, {
		entitiesDir: dirs.entitiesDir,
		junctionsDir: junctionsDirFor(ctx.cwd),
		relationshipsDir: dirs.relationshipsDir,
	}).relations;
}

/** The plain composition for this project — planned (a dry run) or written. Throws its refusals (a cycle, a name). */
export function planPlainComposition(ctx: Context, dirs: PlainCompositionDirs, dryRun = true): CompositionFile[] {
	const mode = resolveRuntimeMode(ctx.config);
	return emitComposition({
		relations: relationsOf(ctx, dirs),
		modulesDir: projectLayout(ctx.cwd, ctx.config).modules,
		generatedDir: dirs.generatedDir,
		drizzleTypeImport: runtimeImport(mode, 'types/drizzle'),
		openApiImport: openApiImport(mode),
		banner: CODEGEN_BANNER,
		dryRun,
	});
}

export interface PlainCompositionResult {
	files: CompositionFile[];
	/** The other wiring's generated files, and any context module no longer composed, removed. */
	removed: string[];
	/** The entities and junctions whose `.wiring.ts` is missing or older than the composition (`wiringFilesBehind`). */
	behind: string[];
}

/** Write the composition, remove what it replaces, and name the `.wiring.ts` files it can't compile against. */
export function writePlainComposition(ctx: Context, dirs: PlainCompositionDirs): PlainCompositionResult {
	const files = planPlainComposition(ctx, dirs, false);
	const modulesDir = projectLayout(ctx.cwd, ctx.config).modules;
	const removed = removeOtherWiringFiles({
		wiring: 'plain',
		modulesDir,
		generatedDir: dirs.generatedDir,
		keep: new Set(files.map((f) => f.path)),
	});
	const behind = wiringFilesBehind({ relations: relationsOf(ctx, dirs), modulesDir });
	return { files, removed, behind };
}

export function printPlainComposition(ctx: Context, result: PlainCompositionResult): void {
	for (const f of result.files) printInfo(`composition: ${path.relative(ctx.cwd, f.path)}`);
	for (const f of result.removed) {
		printInfo(`removed (wiring: nest output, or a context no longer composed): ${path.relative(ctx.cwd, f)}`);
	}
	if (result.behind.length > 0) {
		printWarning(
			`the composition imports from every entity's and junction's .wiring.ts, and these are missing or were written ` +
				`by an older codegen: ${result.behind.join(', ')}. Run \`entity new --all\` and \`junction new --all\`.`,
		);
	}
}
