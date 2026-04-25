/**
 * Orchestration noun — `codegen orchestration gen|list|validate`
 *
 * Phase 3-2 / 3-3 of ADR-032. Discovers `OrchestrationPatternDefinition`
 * records via the existing `loadAppPatterns()` pipeline, then emits one
 * directory per pattern under `${paths.orchestration_src}/`. The emission
 * is delegated to the pure content-builders in
 * `src/cli/shared/orchestration-generator.ts`; this file is the I/O shell.
 */

import path from 'node:path';
import fs from 'node:fs';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import {
	getAllOrchestrationPatterns,
	getOrchestrationPattern,
	getOrchestrationPatternNames,
	loadAppPatterns,
	_resetRegistryForTests,
} from '../../patterns/registry.js';
import { validateOrchestrationProject } from '../../patterns/validate-orchestration.js';
import { getAllPatternNames } from '../../patterns/registry.js';
import {
	OrchestrationEmissionError,
	generateOrchestrationModules,
	toKebabCase,
} from '../shared/orchestration-generator.js';
import { loadContext, type Context } from '../shared/context.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import type { Hint, NounModule, PaneOutput } from '../noun-module.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PATTERN_GLOBS = ['src/patterns/*.pattern.ts'];

function resolvePatternGlobs(ctx: Context): string[] {
	const fromConfig = (ctx.config as { patterns?: unknown } | null)?.patterns;
	if (Array.isArray(fromConfig) && fromConfig.length > 0) {
		return fromConfig.filter((g): g is string => typeof g === 'string');
	}
	return DEFAULT_PATTERN_GLOBS;
}

/**
 * Resolve the orchestration emission root for `cwd`. Default mirrors
 * `BASE_PATHS.orchestrationSrc`: `${backend_src}/orchestration` falling back
 * to `app/backend/src/orchestration`. The CLI does NOT import paths.mjs
 * because mjs/ts module resolution differs in the bundle; we recompute
 * here from the same shape.
 */
function resolveOrchestrationOutputRoot(ctx: Context): string {
	const paths = (ctx.config as { paths?: Record<string, unknown> } | null)
		?.paths;
	const explicit = paths?.orchestration_src;
	if (typeof explicit === 'string' && explicit.length > 0) {
		return path.resolve(ctx.cwd, explicit);
	}
	const backendSrc =
		typeof paths?.backend_src === 'string' && paths.backend_src.length > 0
			? paths.backend_src
			: 'app/backend/src';
	return path.resolve(ctx.cwd, backendSrc, 'orchestration');
}

/**
 * Reset the in-process registry and reload from disk. Necessary because
 * orchestration patterns may have been registered earlier in the same
 * process (e.g. by Hygen subprocess hooks); we want a deterministic view
 * tied to the current `cwd`.
 */
async function reloadRegistry(ctx: Context): Promise<{
	loaded: string[];
	errors: string[];
}> {
	_resetRegistryForTests({ includeLibrary: false });
	return loadAppPatterns(resolvePatternGlobs(ctx), ctx.cwd);
}

// ---------------------------------------------------------------------------
// `orchestration gen`
// ---------------------------------------------------------------------------

export class OrchestrationGenCommand extends Command {
	static paths = [['orchestration', 'gen']];
	static usage = Command.Usage({
		description:
			'Emit token / providers / dispatcher / module files per orchestration pattern (ADR-032 Phase 3-2/3).',
	});

	pattern = Option.String('--pattern', { required: false });
	all = Option.Boolean('--all', false);
	dryRun = Option.Boolean('--dry-run', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		const loadResult = await reloadRegistry(ctx);
		if (loadResult.errors.length > 0 && !isJsonMode()) {
			for (const err of loadResult.errors) printWarning(err);
		}

		// Project-level validator (Phase 3-1) — surface name collisions etc.
		const issues = validateOrchestrationProject({
			orchestrationPatterns: getAllOrchestrationPatterns(),
			domainPatternNames: getAllPatternNames(),
		});
		const fatal = issues.filter((i) => i.severity === 'error');
		if (fatal.length > 0) {
			if (isJsonMode()) {
				printJson({
					command: 'orchestration gen',
					ok: false,
					issues: fatal,
				});
			} else {
				for (const i of fatal) printError(i.message);
			}
			return 1;
		}

		const all = getAllOrchestrationPatterns();
		const targets = this.pattern
			? all.filter((p) => p.name === this.pattern)
			: all;

		if (this.pattern && targets.length === 0) {
			printError(
				`No orchestration pattern named '${this.pattern}'. ` +
					`Known: [${getOrchestrationPatternNames().join(', ')}]`,
			);
			return 1;
		}

		const outputRoot = resolveOrchestrationOutputRoot(ctx);

		try {
			const result = generateOrchestrationModules({
				patterns: targets,
				outputRoot,
				dryRun: this.dryRun,
			});

			if (isJsonMode()) {
				printJson({
					command: 'orchestration gen',
					ok: true,
					dryRun: this.dryRun,
					outputRoot: result.outputRoot,
					patterns: result.patterns.map((p) => ({
						name: p.patternName,
						slug: p.slug,
						outputDir: p.outputDir,
						files: p.files.map((f) => ({
							name: f.name,
							outputPath: f.outputPath,
							relativePath: f.relativePath,
						})),
					})),
					files: result.files.map((f) => ({
						name: f.name,
						outputPath: f.outputPath,
						relativePath: f.relativePath,
					})),
				});
			} else if (this.dryRun) {
				printInfo(
					`Dry run — ${targets.length} orchestration pattern(s) would emit ${result.files.length} file(s):`,
				);
				for (const f of result.files) {
					console.log(
						`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, f.outputPath)}`,
					);
				}
			} else {
				printSuccess(
					`Emitted ${result.files.length} file(s) across ${targets.length} pattern(s) → ${path.relative(ctx.cwd, outputRoot)}`,
				);
			}
			return 0;
		} catch (err: unknown) {
			if (err instanceof OrchestrationEmissionError) {
				printError(err.message);
				return 1;
			}
			throw err;
		}
	}
}

// ---------------------------------------------------------------------------
// `orchestration list`
// ---------------------------------------------------------------------------

export class OrchestrationListCommand extends Command {
	static paths = [['orchestration', 'list']];
	static usage = Command.Usage({
		description: 'List registered orchestration patterns',
	});

	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});
		await reloadRegistry(ctx);

		const patterns = getAllOrchestrationPatterns();
		if (isJsonMode()) {
			printJson({
				command: 'orchestration list',
				patterns: patterns.map((p) => ({
					name: p.name,
					slug: toKebabCase(p.name),
					primaryRegistry: {
						keyType: p.registry.keyType,
						valueType: p.registry.valueType,
						entryCount: p.registry.entries.length,
					},
					coKeyedCount: p.coKeyedRegistries?.length ?? 0,
					dispatcherClassName: p.dispatcher?.className,
					assemblySlot: p.dispatcher?.assemblySlot,
				})),
			});
			return 0;
		}

		if (patterns.length === 0) {
			printInfo('No orchestration patterns registered.');
			return 0;
		}
		console.log(
			theme.muted('NAME            KEYTYPE              VALUETYPE         ENTRIES  CO-KEYED'),
		);
		for (const p of patterns) {
			console.log(
				`${p.name.padEnd(15)} ${p.registry.keyType.padEnd(20)} ${p.registry.valueType.padEnd(17)} ${String(p.registry.entries.length).padEnd(8)} ${String(p.coKeyedRegistries?.length ?? 0)}`,
			);
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// `orchestration validate`
// ---------------------------------------------------------------------------

export class OrchestrationValidateCommand extends Command {
	static paths = [['orchestration', 'validate']];
	static usage = Command.Usage({
		description:
			'Run the Phase 3-1 project-level orchestration validator (ADR-032)',
	});

	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		const loadResult = await reloadRegistry(ctx);
		const issues = validateOrchestrationProject({
			orchestrationPatterns: getAllOrchestrationPatterns(),
			domainPatternNames: getAllPatternNames(),
		});
		const errors = issues.filter((i) => i.severity === 'error');
		const warnings = issues.filter((i) => i.severity === 'warning');

		if (isJsonMode()) {
			printJson({
				command: 'orchestration validate',
				ok: errors.length === 0 && loadResult.errors.length === 0,
				loaderErrors: loadResult.errors,
				issues,
			});
		} else {
			for (const err of loadResult.errors) printError(err);
			for (const i of errors) printError(i.message);
			for (const i of warnings) printWarning(i.message);
			if (
				errors.length === 0 &&
				warnings.length === 0 &&
				loadResult.errors.length === 0
			) {
				printSuccess(
					`${getOrchestrationPatternNames().length} orchestration pattern(s) — no issues`,
				);
			}
		}
		return errors.length === 0 && loadResult.errors.length === 0 ? 0 : 1;
	}
}

// ---------------------------------------------------------------------------
// NounModule
// ---------------------------------------------------------------------------

async function summary(ctx: Context): Promise<PaneOutput> {
	try {
		await reloadRegistry(ctx);
	} catch {
		// Best-effort — show an empty summary if the registry can't load.
	}
	const names = getOrchestrationPatternNames();
	return {
		title: 'orchestration',
		body: [
			`patterns: ${names.length}`,
			...(names.length > 0 ? [`  ${names.join(', ')}`] : []),
		],
	};
}

async function hints(_ctx: Context): Promise<Hint[]> {
	return [
		{
			command: 'codegen orchestration gen',
			description: 'Emit per-pattern modules under paths.orchestration_src',
		},
		{
			command: 'codegen orchestration list',
			description: 'List registered orchestration patterns',
		},
		{
			command: 'codegen orchestration validate',
			description: 'Run the orchestration project-level validator',
		},
	];
}

const orchestrationNoun: NounModule = {
	name: 'orchestration',
	commandClasses: [
		OrchestrationGenCommand,
		OrchestrationListCommand,
		OrchestrationValidateCommand,
	] as CommandClass[],
	summary,
	hints,
};

export default orchestrationNoun;
