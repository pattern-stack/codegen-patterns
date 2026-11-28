/**
 * The pattern-stack wiring composition as a CLI post-step (PW-3a, PW-3c): `entity new` and `junction new` both write it, from
 * one place that builds its input.
 */

import path from 'node:path';

import { CODEGEN_BANNER } from '../../utils/generated-file.js';
import { TenancyConfigSchema } from '../../schema/codegen-config.schema.js';
import type { Context } from './context.js';
import { projectLayout } from './project-layout.js';
import { junctionsDirFor, relationshipsDirFor } from '../../config/junctions-dir.js';
import { loadProjectApiContext } from '../../derived/api/project.js';
import type { RelationsConfigInput } from '../../emitters/relations/load-context.js';
import {
	emitComposition,
	wiringFilesBehind,
	type CompositionEventsInput,
	type CompositionIntegrationInput,
	type CompositionFile,
	type CompositionInput,
} from '../../emitters/composition/emit-composition.js';
import { configOrDefaults } from '../../config/project-config.js';
import { isSubsystemInstalled } from './subsystem-detect.js';
import { eventsGeneratedDir } from './pattern-stack-subsystems.js';
import { removeOtherWiringFiles } from '../../emitters/composition/stale-files.js';
import { openApiImport, resolveRuntimeMode, runtimeImport, subsystemCoreImport, type RuntimeMode } from './runtime-import.js';
import { printInfo, printWarning } from '../ui/output.js';

/** Is the events subsystem installed (S-1)? `isSubsystemInstalled`'s one rule (under pattern-stack, its `core.ts`). */
export function eventsInstalled(ctx: Context): boolean {
	return isSubsystemInstalled(ctx, 'events');
}

/** Is the integration subsystem installed (S-3)? `isSubsystemInstalled`'s one rule. */
export function integrationInstalled(ctx: Context): boolean {
	return isSubsystemInstalled(ctx, 'integration');
}

/** The `integration` system's input (S-3), or null when the subsystem isn't installed. */
export function patternStackIntegrationInput(ctx: Context): CompositionIntegrationInput | null {
	if (!integrationInstalled(ctx)) return null;
	const mode = resolveRuntimeMode(ctx.config);
	const integration = configOrDefaults(ctx.config).integration ?? {};
	return {
		backend: integration.backend ?? 'drizzle',
		multiTenant: integration.multi_tenant ?? false,
		...(integration.differ ? { differ: integration.differ } : {}),
		coreImport: subsystemCoreImport(mode, 'integration'),
		runtimeImport: (relpath) => runtimeImport(mode, relpath),
	};
}

/** The `events` system's input (S-1), or null when the subsystem isn't installed. */
export function patternStackEventsInput(ctx: Context, generatedDir: string): CompositionEventsInput | null {
	if (!eventsInstalled(ctx)) return null;
	const mode = resolveRuntimeMode(ctx.config);
	const events = configOrDefaults(ctx.config).events ?? {};
	const backend = events.backend ?? 'drizzle';
	return {
		backend,
		multiTenant: events.multi_tenant ?? false,
		listenNotify: events.extensions?.drizzle?.listen_notify ?? false,
		backendImport: runtimeImport(mode, `subsystems/events/event-bus.${backend}-backend`),
		coreImport: subsystemCoreImport(mode, 'events'),
		generatedEventsDir: eventsGeneratedDir(ctx, generatedDir),
	};
}

/**
 * The composition's input for this project: the one place that builds it. Every directory comes from `ctx`
 * (`projectLayout`, the junctions and relationships folders), and the relations load once per call.
 */
function compositionInput(ctx: Context): CompositionInput {
	const mode = resolveRuntimeMode(ctx.config);
	const layout = projectLayout(ctx.cwd, ctx.config);
	return {
		relations: loadProjectApiContext(ctx.cwd, ctx.config as RelationsConfigInput | null | undefined, {
			entitiesDir: layout.entities,
			junctionsDir: junctionsDirFor(ctx.cwd),
			relationshipsDir: relationshipsDirFor(ctx.cwd),
		}).relations,
		modulesDir: layout.modules,
		generatedDir: layout.generated,
		...emitterOptions(mode),
		events: patternStackEventsInput(ctx, layout.generated),
		integration: patternStackIntegrationInput(ctx),
	};
}

/** The emitter's options that follow from the runtime mode alone: every composition, `project init`'s empty one too. */
function emitterOptions(mode: RuntimeMode): Pick<CompositionInput, 'drizzleTypeImport' | 'openApiImport' | 'banner'> {
	return { drizzleTypeImport: runtimeImport(mode, 'types/drizzle'), openApiImport: openApiImport(mode), banner: CODEGEN_BANNER };
}

/** The pattern-stack composition for this project, planned (a dry run). Throws its refusals (a cycle, a name). */
export function planPatternStackComposition(ctx: Context): CompositionFile[] {
	return emitComposition({ ...compositionInput(ctx), dryRun: true });
}

/**
 * The composition of a project with no entity yet (PW-4): `project init` writes it, so the app's `compose.ts` and
 * `main.ts` compile before the first `entity new`, which rewrites it. The same emitter, over an empty set.
 */
export function emptyPatternStackComposition(
	dirs: { modulesDir: string; generatedDir: string },
	mode: RuntimeMode,
): CompositionFile[] {
	return emitComposition({
		// No entity, no junction; the tenancy column is the schema's default, as a config without `tenancy:` reads it.
		relations: { entities: [], definitions: new Map(), junctions: [], tenancyColumn: TenancyConfigSchema.parse({}).column },
		modulesDir: dirs.modulesDir,
		generatedDir: dirs.generatedDir,
		...emitterOptions(mode),
		dryRun: true,
	});
}

export interface PatternStackCompositionResult {
	files: CompositionFile[];
	/** The other wiring's generated files, and any context module no longer composed, removed. */
	removed: string[];
	/** The entities and junctions whose `.wiring.ts` is missing or older than the composition (`wiringFilesBehind`). */
	behind: string[];
}

/** Write the composition, remove what it replaces, and name the `.wiring.ts` files it can't compile against. */
export function writePatternStackComposition(ctx: Context): PatternStackCompositionResult {
	const input = compositionInput(ctx);
	const files = emitComposition(input);
	const removed = removeOtherWiringFiles({
		wiring: 'pattern-stack',
		modulesDir: input.modulesDir,
		generatedDir: input.generatedDir,
		keep: new Set(files.map((f) => f.path)),
	});
	const behind = wiringFilesBehind(input);
	return { files, removed, behind };
}

export function printPatternStackComposition(ctx: Context, result: PatternStackCompositionResult): void {
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
