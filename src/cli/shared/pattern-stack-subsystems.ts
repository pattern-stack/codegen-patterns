/**
 * What `subsystem install <name>` supports under `target.wiring: pattern-stack`: one typed row per subsystem (a
 * `Record` over `SubsystemName`, so `tsc` refuses a subsystem with no row). A subsystem has a Nest-free system on some
 * backends, or names the step that brings it (`comesWith`). Everything pattern-stack decides about a subsystem reads
 * its row: the install's refusal and its supported list, the files the vendored copy skips, the entry file that
 * marks a vendored install (detection, so the installed check), what the install writes before the first
 * `entity new`, and the next step it prints. A later step adds a row; it never adds a name check.
 *
 * Imports only types and the event set's builder, so the detection (`subsystem-detect.ts`) can read it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { rowFor } from '../../utils/keyed-row.js';
import { generating } from '../../utils/generated-file.js';
import type { Context } from './context.js';
import { buildEventCodegenContents } from './event-codegen-generator.js';
import { projectLayout } from './project-layout.js';
import { resolveRuntimeMode } from './runtime-import.js';
import type { SubsystemBackend, SubsystemName } from './subsystem-detect.js';

/** A subsystem pattern-stack installs. */
export interface PatternStackSubsystem {
	/** The backends it has a Nest-free system on (`any`: config-only). Another is refused, naming these. */
	readonly backends: readonly SubsystemBackend[] | 'any';
	/** Why another backend is refused, when there is more to say than which ones are supported. */
	readonly why?: string;
	/** What must be installed first: why the install stops, or null. */
	readonly prerequisite?: (ctx: Context) => string | null;
	/** Files the vendored copy skips (paths under the subsystem folder): its Nest module, the barrel that re-exports it. */
	readonly skipped: ReadonlySet<string>;
	/** The file whose presence marks a vendored install: its Nest-free entry. Null: nothing is vendored. */
	readonly entryFile: string | null;
	/** What the install writes before the first `entity new` (any command that writes the composition may run first). */
	readonly afterInstall?: (ctx: Context, generatedDir: string) => void;
	/** What to do after the install, printed by it. */
	readonly nextStep: string | null;
}

export type PatternStackSupport = PatternStackSubsystem | { readonly comesWith: string | null };

/** Where the event codegen writes (`types`, `registry`, `bus`): beside the vendored runtime, or under `<generated>/events`. */
export function eventsGeneratedDir(ctx: Context, generatedDir: string): string {
	return resolveRuntimeMode(ctx.config) === 'package'
		? path.resolve(generatedDir, 'events')
		: path.resolve(projectLayout(ctx.cwd, ctx.config).subsystems, 'events/generated');
}

/** The empty pattern-stack event set (S-1), iff none was generated yet. */
function writeEmptyPatternStackEvents(ctx: Context, generatedDir: string): void {
	const dir = eventsGeneratedDir(ctx, generatedDir);
	if (fs.existsSync(path.join(dir, 'registry.ts'))) return;
	fs.mkdirSync(dir, { recursive: true });
	for (const { name, content } of buildEventCodegenContents([], resolveRuntimeMode(ctx.config), 'pattern-stack')) {
		const file = path.join(dir, name);
		generating(file, () => fs.writeFileSync(file, content));
	}
}

export const PATTERN_STACK_SUBSYSTEMS: Readonly<Record<SubsystemName, PatternStackSupport>> = {
	// S-1: the Nest module and the barrel that re-exports it are skipped, and so is the bundled `generated/` set (its bus
	// is Nest's): the install writes the empty pattern-stack set, `entity new` the real one.
	events: {
		backends: ['drizzle', 'memory'],
		why: 'its redis backend is Nest-only',
		skipped: new Set(['events.module.ts', 'index.ts', 'bus.ts', 'registry.ts', 'schemas.ts', 'types.ts']),
		entryFile: 'core.ts',
		afterInstall: writeEmptyPatternStackEvents,
		nextStep:
			'Next: `codegen entity new --all` writes the typed bus and the `events` system (`<generated>/events-system.ts`), ' +
			'listed in `SYSTEMS` (`<generated>/composition.ts`). compose.ts must compose them — ' +
			'`systems: [databaseSystem(...), ...SYSTEMS]` (`project init` writes it so; add it to an older compose.ts) — and ' +
			"drizzle.config.ts's `schema` must include `<generated>/subsystems-schema.ts` (the `domain_events` table).",
	},
	// Config-only: the `openapi:` block, which pattern-stack's `<generated>/openapi.ts` reads too.
	'openapi-config': { backends: 'any', skipped: new Set(), entryFile: null, nextStep: null },
	auth: { comesWith: 'S-2' },
	'auth-integrations': { comesWith: 'S-2' },
	// S-3: Nest's module, its barrel and `ExecuteIntegrationUseCase` are skipped (the system builds `IntegrationRunner`).
	integration: {
		backends: ['drizzle', 'memory'],
		skipped: new Set(['integration.module.ts', 'index.ts', 'execute-integration.use-case.ts']),
		entryFile: 'core.ts',
		nextStep:
			'Next: `codegen entity new --all` writes the `integration` system (`<generated>/integration-system.ts`: the cursor ' +
			'store, the run recorder and the differ every `IntegrationRunner` takes), listed in `SYSTEMS` ' +
			"(`<generated>/composition.ts`). compose.ts must compose them (`systems: [databaseSystem(...), ...SYSTEMS]`), and " +
			"drizzle.config.ts's `schema` must include `<generated>/subsystems-schema.ts` (the `integration_*` tables).",
	},
	jobs: { comesWith: 'J-1' },
	bridge: { comesWith: 'J-1' },
	cache: { comesWith: null },
	storage: { comesWith: null },
	observability: { comesWith: null },
};

/** The row of a subsystem pattern-stack installs, or null when it isn't supported yet. */
export function patternStackSubsystem(name: SubsystemName): PatternStackSubsystem | null {
	const row = rowFor('subsystem', PATTERN_STACK_SUBSYSTEMS, name);
	return 'comesWith' in row ? null : row;
}

/** The subsystems pattern-stack installs, for messages. */
export function supportedPatternStackSubsystems(): SubsystemName[] {
	return (Object.keys(PATTERN_STACK_SUBSYSTEMS) as SubsystemName[]).filter((n) => patternStackSubsystem(n) !== null);
}

/** Under `target.wiring: pattern-stack`: why `subsystem install <name>` is refused, or null (the table above). */
export function patternStackSubsystemRefusal(name: SubsystemName, backend: SubsystemBackend, ctx?: Context): string | null {
	const row = rowFor('subsystem', PATTERN_STACK_SUBSYSTEMS, name);
	if ('comesWith' in row) {
		return (
			`the ${name} subsystem isn't supported under target.wiring: pattern-stack yet` +
			(row.comesWith ? ` — it comes with ${row.comesWith}.` : '.') +
			` Supported: ${supportedPatternStackSubsystems().join(', ')}.`
		);
	}
	if (row.backends !== 'any' && !row.backends.includes(backend)) {
		return (
			`the ${name} subsystem's ${backend} backend isn't supported under target.wiring: pattern-stack` +
			`${row.why ? `: ${row.why}` : ''} (supported: ${row.backends.join(', ')}).`
		);
	}
	return ctx && row.prerequisite ? row.prerequisite(ctx) : null;
}

/** The vendored copy's filter under pattern-stack: the backend's, minus the bundled `generated/` set and the row's skips. */
export function patternStackFileFilter(name: SubsystemName, base: (file: string) => boolean): (file: string) => boolean {
	const skipped = patternStackSubsystem(name)?.skipped ?? new Set<string>();
	return (file) => base(file) && !file.startsWith('generated/') && !skipped.has(file);
}
