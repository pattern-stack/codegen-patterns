/**
 * Entity noun — codegen entity / entity new / entity list / entity validate
 *
 * Implements SPEC-CLI-02. Delegates actual generation to the shared Hygen
 * helper so behavior matches the legacy src/cli.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import { loadEntityFromYaml, loadEntitiesFromYaml } from '../../utils/yaml-loader.js';
import { analyzeDomain, validateEntities } from '../../index.js';

import { loadContext, type Context } from '../shared/context.js';
import { invokeEntityNew } from '../shared/hygen.js';
import { checkGitSafety } from '../shared/git-safety.js';
import {
	regenerateBarrels,
	resolveArchitecture,
	resolveGeneratedDir,
} from '../shared/barrel-generator.js';
import { generateScopeEntityType } from '../shared/scope-entity-type-generator.js';
import { regenerateSubsystemBarrel } from '../shared/subsystem-barrel-generator.js';
import { regenerateSubsystemSchemaBarrel } from '../shared/subsystem-schema-generator.js';
import { generateBridgeRegistry } from '../shared/bridge-registry-generator.js';
import {
	OrchestrationEmissionError,
	generateOrchestrationModules,
} from '../shared/orchestration-generator.js';
import {
	_resetRegistryForTests,
	getAllOrchestrationPatterns,
	loadAppPatterns,
} from '../../patterns/registry.js';
import {
	collectMergedEvents,
	generateEventCodegen,
} from '../shared/event-codegen-generator.js';
import { validateEntityEmits } from '../../parser/validate-emits.js';
import {
	generateProviderModules,
	resolveTsconfigAliases,
	collectEntitySurfaces,
} from '../shared/provider-module-generator.js';
import { emitAdapters } from '../shared/adapter-emission-generator.js';
import { resolveRuntimeMode } from '../shared/runtime-import.js';
import {
	loadFrontendEmitContext,
	emitFrontendSet,
} from '../../emitters/frontend/index.js';
import { configuredSubsystemNames } from '../shared/subsystem-detect.js';
import { loadProvidersFromYaml } from '../../utils/yaml-loader.js';
import { loadEntities } from '../../parser/load-entities.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import type { AnalysisIssue } from '../../analyzer/types.js';
import { resolveSubsystemsRoot } from '../shared/subsystems-path.js';
import { resolveEventsDir } from '../shared/events-path.js';

import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import type { PaneOutput } from '../ui/pane.js';
import type { Hint } from '../ui/hints.js';
import type { NounModule } from '../noun-module.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the provider-definitions directory from config (`paths.providers`,
 * default `definitions/providers`). Provider YAML validates against
 * `ProviderDefinitionSchema` — it must be excluded from entity discovery so the
 * recursive `definitions` walk never feeds `definitions/providers/*.yaml` to the
 * entity loader (where it fails entity validation).
 */
function resolveProvidersDir(ctx: Context): string {
	const fromConfig = (
		ctx.config as { paths?: { providers?: string } } | null | undefined
	)?.paths?.providers;
	return fromConfig != null
		? path.resolve(ctx.cwd, fromConfig)
		: path.resolve(ctx.cwd, 'definitions/providers');
}

/**
 * List entity YAML files under `dir`, excluding the provider-definitions
 * subtree. When the entities dir IS the `definitions` root, the recursive walk
 * would otherwise pull in `definitions/providers/*.yaml`; passing the providers
 * dir as an exclusion keeps entity discovery to entity files only.
 */
function listEntityYamls(dir: string, providersDir?: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return findYamlFiles(dir, {
		excludeDirs: providersDir ? [providersDir] : [],
	});
}

interface EntitySummaryRow {
	name: string;
	pattern: string;
	fields: number;
	queries: number;
	file: string;
}

/**
 * Render an entity's pattern choice as a single display string for the
 * summary/list tables. `pattern:` wins; `patterns:` joins with `+`; the
 * library `Base` pattern is the fallback for entities that declare
 * neither. Matches the user-facing labels the registry uses.
 */
function summarizePatternLabel(entity: {
	pattern?: string;
	patterns?: string[];
}): string {
	if (typeof entity.pattern === 'string' && entity.pattern.length > 0) {
		return entity.pattern;
	}
	if (Array.isArray(entity.patterns) && entity.patterns.length > 0) {
		return entity.patterns.join('+');
	}
	return 'Base';
}

function summarizeEntityFile(filePath: string): EntitySummaryRow | null {
	const result = loadEntityFromYaml(filePath);
	if (!result.success) return null;
	const def = result.definition;
	return {
		name: def.entity.name,
		pattern: summarizePatternLabel(def.entity as {
			pattern?: string;
			patterns?: string[];
		}),
		fields: Object.keys(def.fields ?? {}).length,
		queries: Array.isArray(
			(def as unknown as { queries?: unknown[] }).queries
		)
			? ((def as unknown as { queries: unknown[] }).queries).length
			: 0,
		file: filePath,
	};
}

function padRight(s: string, n: number): string {
	return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// summary + hints
// ---------------------------------------------------------------------------

async function summary(ctx: Context): Promise<PaneOutput> {
	if (!ctx.entitiesDir || ctx.entityCount === 0) {
		return {
			title: 'entities',
			body: [
				'No entities defined yet.',
				'',
				`Create one at ${theme.system('entities/<name>.yaml')} to get started.`,
			],
		};
	}

	const files = listEntityYamls(ctx.entitiesDir, resolveProvidersDir(ctx));
	const rows = files.map(summarizeEntityFile).filter((r): r is EntitySummaryRow => r !== null);

	const patterns = new Set(rows.map((r) => r.pattern));
	const queryCount = rows.reduce((sum, r) => sum + r.queries, 0);

	const nameCol = Math.max(4, ...rows.map((r) => r.name.length));
	const patCol = Math.max(7, ...rows.map((r) => r.pattern.length));

	const body = rows.map((r) => {
		const fields = `${r.fields} fields`.padEnd(10);
		const queries = `${r.queries} queries`.padEnd(10);
		return `${theme.system(icons.bullet)} ${padRight(r.name, nameCol)}  ${theme.muted(
			padRight(r.pattern, patCol)
		)}  ${theme.muted(fields)} ${theme.muted(queries)}`;
	});

	return {
		title: 'entities',
		body,
		footer: `${rows.length} entities · ${patterns.size} patterns · ${queryCount} queries`,
	};
}

async function hints(ctx: Context): Promise<Hint[]> {
	if (!ctx.isInitialized) {
		return [{ command: 'codegen init', description: 'Initialize project' }];
	}
	if (!ctx.entitiesDir || ctx.entityCount === 0) {
		return [
			{
				command: 'codegen entity new entities/example.yaml',
				description: 'Generate first entity',
			},
		];
	}
	const baseHints: Hint[] = [
		{ command: 'codegen entity new <file>', description: 'Generate one entity' },
		{ command: 'codegen entity new --all', description: 'Regenerate all entities' },
		{ command: 'codegen entity validate', description: 'Validate YAML definitions' },
		{ command: 'codegen entity list', description: 'List entities as a table' },
	];

	// Track D (RFC-0001): provider/adapter codegen has no command of its own —
	// it is a post-step of `entity new`. Surface that here when the project has
	// provider definitions, so the only discoverability path doesn't depend on
	// reading `entity new --help`.
	const providersDir =
		(ctx.config as { paths?: { providers?: string } } | null | undefined)?.paths
			?.providers != null
			? path.resolve(
					ctx.cwd,
					(ctx.config as { paths: { providers: string } }).paths.providers,
				)
			: path.resolve(ctx.cwd, 'definitions/providers');
	if (fs.existsSync(providersDir)) {
		baseHints.push({
			command: 'codegen entity new --all',
			description: 'Regenerate provider modules + adapter scaffolds (Track D)',
		});
	}

	return baseHints;
}

// ---------------------------------------------------------------------------
// EntityNewCommand
// ---------------------------------------------------------------------------

export class EntityNewCommand extends Command {
	static paths = [['entity', 'new']];
	static usage = Command.Usage({
		description: 'Generate code for one or more entities from YAML',
		details: `
			Generates Clean Architecture code for the named entity (or all entities with \`--all\`), then runs the post-generation codegen steps that share this entrypoint:

			- **Event codegen** — \`AppDomainEvent\` union + typed bus from \`events/*.yaml\`.
			- **Bridge registry** — when the bridge subsystem is installed.
			- **Orchestration modules** — from orchestration patterns.
			- **Provider + adapter codegen (Track D, RFC-0001)** — when \`definitions/providers/*.yaml\` exist, emits one provider module per file into \`<backendSrc>/integrations/providers/\` and the matching adapter scaffolds + \`@generated\` files into \`<backendSrc>/integrations/\`. Author-owned scaffolds are emit-once (never overwritten); \`@generated\` files re-emit each run. With no providers dir the step is silently skipped.

			There is no separate \`provider\`, \`integration\`, or \`gen\` command — Track D codegen is driven entirely by re-running \`entity new\`. The \`just gen\` / \`just gen-all\` recipes are thin wrappers over it.
		`,
		examples: [
			['Generate a single entity', 'codegen entity new entities/contact.yaml'],
			['Regenerate all entities', 'codegen entity new --all'],
			[
				'Regenerate everything incl. provider/adapter codegen',
				'codegen entity new --all',
			],
			['Preview without writing', 'codegen entity new entities/contact.yaml --dry-run'],
		],
	});

	yaml = Option.String({ required: false });
	all = Option.Boolean('--all', false);
	dryRun = Option.Boolean('--dry-run', false);
	force = Option.Boolean('--force', false);
	only = Option.String('--only', { required: false });
	continueOnError = Option.Boolean('--continue-on-error', true);
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

		if (this.all && this.yaml) {
			printError('Pass either a YAML path or --all, not both.');
			return 2;
		}

		let targets: string[] = [];
		if (this.all) {
			const dir = ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');
			targets = listEntityYamls(dir, resolveProvidersDir(ctx));
			if (targets.length === 0) {
				printError(`No entity YAML files found in ${dir}`);
				return 1;
			}
		} else if (this.yaml) {
			targets = [path.resolve(ctx.cwd, this.yaml)];
		} else {
			printError('Missing YAML path. Pass a file or --all.');
			return 2;
		}

		// Pre-flight: validate each YAML. Capture the Zod `details` alongside the
		// short message so `entity new` surfaces the SAME per-issue diagnostics as
		// `entity validate` — otherwise a failing YAML prints only "Validation
		// failed for <file>" with no clue which key/level is wrong (the DX miss
		// that masked Bug 1: `entity.surface` rejected with no actionable detail).
		const validated: Array<{ file: string; name: string }> = [];
		const invalid: Array<{ file: string; message: string; details?: string[] }> =
			[];
		for (const file of targets) {
			const result = loadEntityFromYaml(file);
			if (result.success) {
				validated.push({ file, name: result.definition.entity.name });
			} else {
				invalid.push({ file, message: result.error, details: result.details });
			}
		}

		if (invalid.length > 0 && !this.continueOnError) {
			for (const i of invalid) {
				printError(`${path.basename(i.file)} — ${i.message}`);
				for (const detail of i.details ?? []) {
					printError(`   • ${detail}`);
				}
			}
			if (!isJsonMode()) {
				return 1;
			}
		}

		// EVT-7: pre-flight cross-validate each target's `emits:` block against
		// the merged event registry (top-level events/*.yaml + entity events:
		// desugar). Invalid emits are reported and skipped by default; pass
		// --no-continue-on-error to make the first failure fatal. Warnings are
		// always surfaced via printWarning + JSON payload and never gate.
		const entitiesDirForEmits =
			ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');
		const eventsDirForEmits = resolveEventsDir(ctx);
		const allEntitiesForEmits = loadEntities(entitiesDirForEmits, {
			excludeDirs: [resolveProvidersDir(ctx)],
		}).entities;
		const validatedNames = new Set(validated.map((v) => v.name));
		const emitsTargetEntities = allEntitiesForEmits.filter((e) =>
			validatedNames.has(e.name),
		);
		const mergedEventsForEmits = collectMergedEvents({
			entitiesDir: entitiesDirForEmits,
			eventsDir: eventsDirForEmits,
		});
		const emitsIssues: AnalysisIssue[] = validateEntityEmits(
			emitsTargetEntities,
			mergedEventsForEmits.events,
		);
		const emitsErrors = emitsIssues.filter((i) => i.severity === 'error');
		const emitsWarnings = emitsIssues.filter(
			(i) => i.severity === 'warning',
		);

		if (emitsErrors.length > 0 && !this.continueOnError) {
			if (!isJsonMode()) {
				for (const e of emitsErrors) {
					printError(`${e.entity ?? '(unknown)'}: ${e.message}`);
				}
				return 1;
			}
		}

		if (!isJsonMode()) {
			for (const w of emitsWarnings) {
				printWarning(w.message);
			}
			const noEmitsCount = emitsWarnings.filter(
				(w) => w.type === 'no_emits',
			).length;
			if (noEmitsCount > 0) {
				printInfo(`${noEmitsCount} entities missing emits:`);
			}
		}

		// Git safety — we don't know specific output paths without running Hygen,
		// so scope the check to the cwd's generated source roots if we can.
		if (!this.force) {
			const gitCheck = checkGitSafety(['src'], ctx.cwd);
			if (gitCheck.inRepo && !gitCheck.clean) {
				printWarning(
					`Uncommitted changes in ${gitCheck.dirty.length} files under src/. Pass --force to overwrite.`
				);
				if (!isJsonMode()) return 1;
			}
		}

		// Compute barrel plan (used in both dry-run reporting and post-gen execution).
		const entitiesDir = ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');
		const relationshipsDir = path.resolve(ctx.cwd, 'relationships');
		const generatedDir = resolveGeneratedDir(ctx);
		const architecture = resolveArchitecture(ctx);

		const subsystemsRoot = resolveSubsystemsRoot(ctx);
		// Runtime mode (ADR-037) drives WHERE consumer-specific generated code
		// lands. Vendored mode keeps the legacy `<subsystemsRoot>/<name>/generated`
		// tree (next to the runtime it imports). Package mode has no vendored tree,
		// so the generated event files + scope union + bridge registry land beside
		// the other `src/generated/*` barrels, with runtime imports routed through
		// the published `@pattern-stack/codegen` subpaths.
		const runtimeMode = resolveRuntimeMode(ctx.config);

		// Scope-entity-type union (jobs). Self-contained (zod-only), so package
		// mode just relocates it to `src/generated/scope-entity-type.ts`.
		const scopeEntityTypePath =
			runtimeMode === 'package'
				? path.resolve(generatedDir, 'scope-entity-type.ts')
				: path.resolve(subsystemsRoot, 'jobs/generated/scope-entity-type.ts');

		const eventsDir = resolveEventsDir(ctx);
		// Event codegen output. Package mode → `src/generated/events/` (the 5 files
		// import the events runtime via the package subpath); also the dir the
		// bridge registry validates trigger events against (so package-mode trigger
		// validation now works).
		const eventCodegenOutputDir =
			runtimeMode === 'package'
				? path.resolve(generatedDir, 'events')
				: path.resolve(subsystemsRoot, 'events/generated');
		// Bridge registry output is mode-aware (ADR-037). Vendored mode writes
		// `registry.ts` into the vendored `bridge/generated/` tree (next to the
		// runtime it types against). Package mode lands `bridge-registry.ts` beside
		// the other `src/generated/*` barrels, threaded into `BridgeModule.forRoot`
		// by the subsystem barrel.
		const bridgeInstalledForRegistry = configuredSubsystemNames(
			ctx.config as Record<string, unknown> | null | undefined,
		).includes('bridge');
		const bridgeRegistryOutputDir =
			runtimeMode === 'package'
				? generatedDir
				: path.resolve(subsystemsRoot, 'bridge/generated');
		// Handlers dir resolves under `paths.backend_src` (matching where the
		// rest of the backend tree lives) with `src` as final fallback — the
		// same default `subsystems-path.ts` uses for `subsystems` root.
		// Recursive scan tolerates absent dir (returns empty registry).
		const backendSrcForHandlers =
			(ctx.config as { paths?: { backend_src?: string } } | null | undefined)
				?.paths?.backend_src ?? 'src';

		// `runtimeMode` (ADR-037) is resolved above — it drives the bridge
		// registry output (mode-aware) plus every runtime import specifier the
		// integration emitters write. Defaults to `package` (the new default).
		const bridgeHandlersDir = path.resolve(
			ctx.cwd,
			backendSrcForHandlers,
			'jobs',
		);

		// Orchestration emission root (ADR-032 Phase 3-2 / O-6). Defaults to
		// `${backend_src}/orchestration`, override via `paths.orchestration_src`.
		const orchestrationConfigured = (
			ctx.config as { paths?: { orchestration_src?: string } } | null | undefined
		)?.paths?.orchestration_src;
		const orchestrationOutputRoot = path.resolve(
			ctx.cwd,
			typeof orchestrationConfigured === 'string' && orchestrationConfigured.length > 0
				? orchestrationConfigured
				: path.join(backendSrcForHandlers, 'orchestration'),
		);

		// Pattern globs used to discover orchestration patterns. Default
		// matches the Phase 3-1 loader: `src/patterns/*.pattern.ts`.
		const orchestrationGlobs: string[] = (() => {
			const fromCfg = (ctx.config as { patterns?: unknown } | null | undefined)
				?.patterns;
			if (Array.isArray(fromCfg) && fromCfg.length > 0) {
				return fromCfg.filter((g): g is string => typeof g === 'string');
			}
			return ['src/patterns/*.pattern.ts'];
		})();

		// Helper — reload registry + return orchestration patterns. Wrapped
		// in a try to keep failures non-fatal (post-step contract).
		const loadOrchestrationPatterns = async () => {
			try {
				_resetRegistryForTests({ includeLibrary: false });
				await loadAppPatterns(orchestrationGlobs, ctx.cwd);
				return getAllOrchestrationPatterns();
			} catch {
				return [];
			}
		};

		if (this.dryRun) {
			const barrelPlan = await regenerateBarrels({
				ctx,
				entitiesDir,
				relationshipsDir,
				generatedDir,
				architecture,
				dryRun: true,
			});

			const scopePlan = await generateScopeEntityType({
				entitiesDir,
				outputPath: scopeEntityTypePath,
				dryRun: true,
			});

			const eventCodegenPlan = await generateEventCodegen({
				entitiesDir,
				eventsDir,
				outputDir: eventCodegenOutputDir,
				mode: runtimeMode,
				dryRun: true,
			});

			const bridgeRegistryPlan = await generateBridgeRegistry({
				handlersDir: bridgeHandlersDir,
				eventsGeneratedDir: eventCodegenOutputDir,
				outputDir: bridgeRegistryOutputDir,
				mode: runtimeMode,
				bridgeInstalled: bridgeInstalledForRegistry,
				dryRun: true,
			});

			// Orchestration emission plan (ADR-032 Phase 3-2/3). Best-effort —
			// emission errors warn-but-don't-fail the dry-run report.
			const orchestrationPatterns = await loadOrchestrationPatterns();
			let orchestrationPlan: ReturnType<typeof generateOrchestrationModules> | null = null;
			try {
				orchestrationPlan = generateOrchestrationModules({
					patterns: orchestrationPatterns,
					outputRoot: orchestrationOutputRoot,
					dryRun: true,
				});
			} catch (err: unknown) {
				if (!isJsonMode()) {
					const msg = err instanceof Error ? err.message : String(err);
					printWarning(`orchestration codegen plan failed — ${msg}`);
				}
			}

			if (isJsonMode()) {
				printJson({
					command: 'entity new',
					dryRun: true,
					entities: validated.map((v) => ({ name: v.name, file: v.file })),
					totals: { planned: validated.length, invalid: invalid.length },
					barrels: {
						modules: barrelPlan.modulesBarrel,
						schema: barrelPlan.schemaBarrel,
						entityCount: barrelPlan.entityCount,
						modulesContent: barrelPlan.modulesContent,
						schemaContent: barrelPlan.schemaContent,
					},
					scopeEntityType: {
						outputPath: scopePlan.outputPath,
						scopeableNames: scopePlan.scopeableNames,
						content: scopePlan.content,
					},
					eventCodegen: {
						outputDir: eventCodegenPlan.outputDir,
						eventCount: eventCodegenPlan.eventCount,
						files: eventCodegenPlan.files.map((f) => ({
							name: f.name,
							outputPath: f.outputPath,
							content: f.content,
						})),
					},
					bridgeRegistry: {
						outputDir: bridgeRegistryPlan.outputDir,
						triggerCount: bridgeRegistryPlan.triggerCount,
						eventTypeCount: bridgeRegistryPlan.eventTypeCount,
						files: bridgeRegistryPlan.files.map((f) => ({
							name: f.name,
							outputPath: f.outputPath,
							content: f.content,
						})),
					},
					orchestration: orchestrationPlan
						? {
								outputRoot: orchestrationPlan.outputRoot,
								patterns: orchestrationPlan.patterns.map((p) => ({
									name: p.patternName,
									slug: p.slug,
									outputDir: p.outputDir,
								})),
								files: orchestrationPlan.files.map((f) => ({
									name: f.name,
									outputPath: f.outputPath,
									relativePath: f.relativePath,
								})),
							}
						: null,
					emits: {
						warnings: emitsWarnings.map((w) => ({
							entity: w.entity ?? null,
							type: w.type,
							message: w.message,
						})),
						errors: emitsErrors.map((e) => ({
							entity: e.entity ?? null,
							type: e.type,
							message: e.message,
						})),
					},
				});
			} else {
				printInfo(`Dry run — ${validated.length} entities would be generated:`);
				for (const v of validated) {
					console.log(`  ${theme.muted(icons.arrow)} ${v.name}  ${theme.muted(v.file)}`);
				}
				if (invalid.length > 0) {
					for (const i of invalid) {
						printWarning(`${path.basename(i.file)} — ${i.message}`);
					}
				}
				console.log('');
				printInfo(`Barrels (${barrelPlan.entityCount} entities):`);
				console.log(`  ${theme.muted(icons.arrow)} ${barrelPlan.modulesBarrel}`);
				console.log(`  ${theme.muted(icons.arrow)} ${barrelPlan.schemaBarrel}`);
				printInfo(
					`ScopeEntityType (${scopePlan.scopeableNames.length} scopeable): ${scopePlan.outputPath}`,
				);
				printInfo(
					`event codegen (${eventCodegenPlan.eventCount} events) → ${eventCodegenPlan.outputDir}`,
				);
			}
			return invalid.length > 0 && !this.continueOnError ? 1 : 0;
		}

		// Invoke Hygen for each validated target.
		const succeeded: string[] = [];
		const failed: Array<{ name: string; file: string; message: string }> = [
			...invalid.map((i) => ({ name: path.basename(i.file), file: i.file, message: i.message })),
		];
		for (const v of validated) {
			if (!isJsonMode()) {
				printInfo(`generating ${v.name}`);
			}
			const res = invokeEntityNew(v.file, ctx.cwd);
			if (res.ok) {
				succeeded.push(v.name);
				if (!isJsonMode()) printSuccess(`${v.name}`);
			} else {
				failed.push({
					name: v.name,
					file: v.file,
					message: res.stderr ?? 'Hygen invocation failed',
				});
				if (!isJsonMode()) printError(`${v.name} — ${res.stderr ?? 'failed'}`);
				if (!this.continueOnError) break;
			}
		}

		// Regenerate barrels once, after all Hygen invocations. This is total —
		// every .yaml in entitiesDir is re-scanned, so deleting an entity YAML and
		// re-running removes it from the barrels. See ADR-017.
		let barrelResult: Awaited<ReturnType<typeof regenerateBarrels>> | null = null;
		try {
			barrelResult = await regenerateBarrels({
				ctx,
				entitiesDir,
				relationshipsDir,
				generatedDir,
				architecture,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`barrel regeneration failed — ${msg}`);
			}
		}

		// Regenerate the subsystem composition barrel (<generated>/subsystems.ts).
		// Total — re-reads `subsystems.install` + per-subsystem option blocks from
		// codegen.config.yaml every time. Warn-but-don't-fail to match the entity
		// barrel pattern; the subsystem barrel is opt-in (users who haven't wired
		// it into AppModule see no behavioral change).
		try {
			await regenerateSubsystemBarrel({ ctx, generatedDir });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`subsystem barrel regeneration failed — ${msg}`);
			}
		}

		// Regenerate the subsystem SCHEMA barrel (<generated>/subsystems-schema.ts)
		// re-exporting each installed subsystem's Drizzle tables + pgEnums so
		// drizzle-kit emits their CREATE TABLE / CREATE TYPE without the consumer
		// hand-re-exporting them (the "#9 footgun"). Mode-aware like the
		// composition barrel; same warn-but-don't-fail contract.
		try {
			await regenerateSubsystemSchemaBarrel({ ctx, generatedDir });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`subsystem schema barrel regeneration failed — ${msg}`);
			}
		}

		// Regenerate ScopeEntityType union after barrels (full directory rescan).
		// Always runs for both single-file and --all modes (OQ-1: always rescan).
		// Warn-but-don't-fail on error to match barrel pattern.
		let scopeResult: Awaited<ReturnType<typeof generateScopeEntityType>> | null = null;
		try {
			scopeResult = await generateScopeEntityType({
				entitiesDir,
				outputPath: scopeEntityTypePath,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`scope-entity-type generation failed — ${msg}`);
			}
		}

		// Regenerate event codegen artifacts (EVT-3) after scope-entity-type.
		// Same "warn-but-don't-fail" pattern as the barrel and scope steps — one
		// unexpected exception shouldn't abort the whole `entity new` invocation.
		let eventCodegenResult: Awaited<ReturnType<typeof generateEventCodegen>> | null = null;
		try {
			eventCodegenResult = await generateEventCodegen({
				entitiesDir,
				eventsDir,
				outputDir: eventCodegenOutputDir,
				mode: runtimeMode,
			});
			if (!isJsonMode()) {
				for (const issue of eventCodegenResult.issues) {
					if (issue.severity === 'error') {
						printError(
							`event codegen: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`,
						);
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`event codegen failed — ${msg}`);
			}
		}

		// Bridge registry codegen (BRIDGE-6, ADR-023 Phase 2). Runs AFTER event
		// codegen so the freshly-emitted eventRegistry is available for
		// build-time validation. Same warn-but-don't-fail pattern as siblings.
		let bridgeRegistryResult: Awaited<ReturnType<typeof generateBridgeRegistry>> | null = null;
		try {
			bridgeRegistryResult = await generateBridgeRegistry({
				handlersDir: bridgeHandlersDir,
				eventsGeneratedDir: eventCodegenOutputDir,
				outputDir: bridgeRegistryOutputDir,
				mode: runtimeMode,
				bridgeInstalled: bridgeInstalledForRegistry,
			});
			if (bridgeRegistryResult.skipped && !isJsonMode()) {
				printInfo(
					'bridge subsystem not installed — skipping bridge registry codegen',
				);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printError(`bridge registry codegen failed — ${msg}`);
			}
		}

		// Orchestration emission (ADR-032 Phase 3-2/3). Same warn-but-don't-fail
		// pattern as the other post-steps. Hooked here so `just gen-all` keeps
		// being a single "build everything" entrypoint per Phase 3-2 §3.2.
		let orchestrationResult:
			| ReturnType<typeof generateOrchestrationModules>
			| null = null;
		try {
			const orchestrationPatterns = await loadOrchestrationPatterns();
			orchestrationResult = generateOrchestrationModules({
				patterns: orchestrationPatterns,
				outputRoot: orchestrationOutputRoot,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				if (err instanceof OrchestrationEmissionError) {
					printError(msg);
				} else {
					printWarning(`orchestration codegen failed — ${msg}`);
				}
			}
		}

		// Frontend emission (ADR-038 FE-4). Whole-set: renders the complete
		// frontend tree (base files, REST api client, collections, entity hooks,
		// store, fields, barrel) from the FULL entity set in one pass — so it runs
		// ONCE here, after the per-entity Hygen loop, never per entity. Gated on
		// `generate.frontend === true`; off by default (backend-only projects emit
		// nothing). Same warn-but-don't-fail contract as the sibling post-steps,
		// but NOT silent — failures and skips print. The output is deterministic
		// for a given entity set (safe under re-run / baseline wipe-and-regenerate).
		let frontendResult: { written: string[]; outDir: string } | null = null;
		const frontendEnabled =
			(ctx.config as { generate?: { frontend?: unknown } } | null | undefined)
				?.generate?.frontend === true;
		if (frontendEnabled) {
			try {
				const loaded = loadFrontendEmitContext(
					ctx.cwd,
					ctx.config as Parameters<typeof loadFrontendEmitContext>[1],
					{ entitiesDir },
				);
				if (loaded.skip !== undefined) {
					if (!isJsonMode()) {
						printInfo(`frontend emission skipped — ${loaded.skip}`);
					}
				} else {
					const { ctx: frontendCtx, outDir: frontendOutDir } = loaded;
					const written = emitFrontendSet(frontendCtx, frontendOutDir);
					frontendResult = { written, outDir: frontendOutDir };
					if (!isJsonMode()) {
						printInfo(
							`frontend emitted (${written.length} files) → ${path.relative(ctx.cwd, frontendOutDir)}`,
						);
					}
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!isJsonMode()) {
					printWarning(`frontend emission failed — ${msg}`);
				}
			}
		}

		// Provider module emission (RFC-0001 §2, Track D · D2). Emits one
		// `<slug>.provider.module.ts` per `definitions/providers/*.yaml`. The D1
		// cross-validator runs here as a pre-flight gate: the source root +
		// path-alias map come from the consumer tsconfig (so the import-path
		// check resolves `@app/…#Export` against real files); when no tsconfig
		// is present the import check is skipped but slug/surface checks still
		// run. Skips cleanly when no providers dir exists, so projects without
		// integrations see no change. Blocking issues ⇒ nothing is written.
		let providerResult: ReturnType<typeof generateProviderModules> | null = null;
		try {
			const providersDir = resolveProvidersDir(ctx);
			const providerOutputRoot = path.resolve(
				ctx.cwd,
				backendSrcForHandlers,
				'integrations/providers',
			);
			const entitySurfaces = fs.existsSync(entitiesDir)
				? collectEntitySurfaces(
						loadEntitiesFromYaml(
							findYamlFiles(entitiesDir, { excludeDirs: [providersDir] }),
						).successes.map((s) => s.definition),
					)
				: new Set<string>();
			const tsAliases = resolveTsconfigAliases(ctx.cwd);
			providerResult = generateProviderModules({
				providersDir,
				outputRoot: providerOutputRoot,
				entitySurfaces,
				sourceRoot: tsAliases?.sourceRoot,
				aliases: tsAliases?.aliases,
				skipImportCheck: tsAliases === null,
				mode: runtimeMode,
			});
			if (!providerResult.skipped && !isJsonMode()) {
				for (const issue of providerResult.issues) {
					printError(`provider codegen: ${issue.message}`);
				}
				if (providerResult.issues.length === 0) {
					printInfo(
						`provider modules regenerated (${providerResult.written.length}) → ${providerOutputRoot}`,
					);
				}
			}
			if (
				providerResult.issues.some((i) => i.severity === 'error') &&
				!this.continueOnError
			) {
				return 1;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`provider codegen failed — ${msg}`);
			}
		}

		// Adapter / module / barrel / surface-aggregator emission (RFC-0001 §2/§4,
		// Track D · D3). Runs only when provider emission produced modules (no
		// providers dir ⇒ provider step skipped ⇒ nothing to adapt). Emit-once
		// scaffolds are never overwritten; @generated files re-emit each run. A
		// provider surface with no surface package (Track C) is skipped with a
		// reason, not an error.
		try {
			if (providerResult && !providerResult.skipped && providerResult.issues.length === 0) {
				const providersDir = providerResult.providersDir;
				const adapterOutputRoot = path.resolve(
					ctx.cwd,
					backendSrcForHandlers,
					'integrations',
				);
				const entityDefs = fs.existsSync(entitiesDir)
					? loadEntitiesFromYaml(
							findYamlFiles(entitiesDir, { excludeDirs: [providersDir] }),
						).successes.map((s) => s.definition)
					: [];
				const loadedProviders = loadProvidersFromYaml(
					findYamlFiles(providersDir),
				).successes.map((s) => ({
					definition: s.definition,
					filePath: s.filePath,
				}));
				// Resolve the consumer's tsconfig aliases (already loaded above for
				// the provider import pre-flight) so the assembly's entity repo/module
				// imports prefer the project's `@modules/...`-style alias.
				const assemblyTsAliases = resolveTsconfigAliases(ctx.cwd);
				const adapterResult = emitAdapters({
					providers: loadedProviders,
					entities: entityDefs,
					outputRoot: adapterOutputRoot,
					backendSrcAbs: path.resolve(ctx.cwd, backendSrcForHandlers),
					aliases: assemblyTsAliases?.aliases ?? {},
					mode: runtimeMode,
				});
				if (!isJsonMode()) {
					if (adapterResult.written.length || adapterResult.scaffoldsWritten.length) {
						printInfo(
							`adapter codegen: ${adapterResult.scaffoldsWritten.length} scaffold(s) + ${adapterResult.written.length} @generated → ${adapterOutputRoot}`,
						);
					}
					if (adapterResult.assembliesWritten.length || adapterResult.tokensWritten.length) {
						printInfo(
							`integration assembly codegen: ${adapterResult.assembliesWritten.length} module(s) + ${adapterResult.tokensWritten.length} tokens file(s) + ${adapterResult.integrationAggregatorsWritten.length} aggregator(s)`,
						);
					}
					if (adapterResult.changeEmittersWritten.length) {
						printInfo(
							`integration change-emitters (emit_changes): ${adapterResult.changeEmittersWritten.length} emitter(s)`,
						);
					}
					for (const s of adapterResult.scaffoldsSkipped) {
						printInfo(`skipped scaffold ${s} (author-owned)`);
					}
					for (const s of adapterResult.skippedSurfaces) {
						printWarning(`adapter codegen: ${s.reason} (provider ${s.provider})`);
					}
					for (const s of adapterResult.skippedAssemblies) {
						printWarning(`integration assembly: ${s.reason}`);
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`adapter codegen failed — ${msg}`);
			}
		}

		if (isJsonMode()) {
			printJson({
				command: 'entity new',
				totals: {
					succeeded: succeeded.length,
					failed: failed.length,
				},
				succeeded,
				failed,
				barrels: barrelResult
					? {
							modules: barrelResult.modulesBarrel,
							schema: barrelResult.schemaBarrel,
							entityCount: barrelResult.entityCount,
						}
					: null,
				scopeEntityType: scopeResult
					? {
							outputPath: scopeResult.outputPath,
							scopeableNames: scopeResult.scopeableNames,
						}
					: null,
				eventCodegen: eventCodegenResult
					? {
							outputDir: eventCodegenResult.outputDir,
							eventCount: eventCodegenResult.eventCount,
							written: eventCodegenResult.written,
							files: eventCodegenResult.files.map((f) => ({
								name: f.name,
								outputPath: f.outputPath,
							})),
						}
					: null,
				bridgeRegistry: bridgeRegistryResult
					? {
							outputDir: bridgeRegistryResult.outputDir,
							triggerCount: bridgeRegistryResult.triggerCount,
							eventTypeCount: bridgeRegistryResult.eventTypeCount,
							written: bridgeRegistryResult.written,
						}
					: null,
				orchestration: orchestrationResult
					? {
							outputRoot: orchestrationResult.outputRoot,
							written: orchestrationResult.written,
							patterns: orchestrationResult.patterns.map((p) => ({
								name: p.patternName,
								slug: p.slug,
							})),
							files: orchestrationResult.files.map((f) => ({
								name: f.name,
								relativePath: f.relativePath,
							})),
						}
					: null,
				frontend: frontendResult
					? {
							outDir: frontendResult.outDir,
							written: frontendResult.written,
							fileCount: frontendResult.written.length,
						}
					: null,
				emits: {
					warnings: emitsWarnings.map((w) => ({
						entity: w.entity ?? null,
						type: w.type,
						message: w.message,
					})),
					errors: emitsErrors.map((e) => ({
						entity: e.entity ?? null,
						type: e.type,
						message: e.message,
					})),
				},
			});
		} else {
			const total = validated.length + invalid.length;
			console.log('');
			if (failed.length === 0) {
				printSuccess(`${total} entities · ${succeeded.length} succeeded`);
			} else {
				printWarning(
					`${total} entities · ${succeeded.length} succeeded · ${failed.length} failed`
				);
			}
			if (barrelResult) {
				printInfo(
					`barrels regenerated (${barrelResult.entityCount} entities) → ${path.relative(ctx.cwd, barrelResult.modulesBarrel)}, ${path.relative(ctx.cwd, barrelResult.schemaBarrel)}`
				);
			}
			if (scopeResult) {
				printInfo(
					`scope-entity-type regenerated (${scopeResult.scopeableNames.length} scopeable) → ${path.relative(ctx.cwd, scopeResult.outputPath)}`
				);
			}
			if (eventCodegenResult) {
				printInfo(
					`event codegen regenerated (${eventCodegenResult.eventCount} events) → ${path.relative(ctx.cwd, eventCodegenResult.outputDir)}`
				);
			}
			if (orchestrationResult && orchestrationResult.patterns.length > 0) {
				printInfo(
					`orchestration regenerated (${orchestrationResult.patterns.length} patterns, ${orchestrationResult.files.length} files) → ${path.relative(ctx.cwd, orchestrationResult.outputRoot)}`,
				);
			}
			if (frontendResult) {
				printInfo(
					`frontend regenerated (${frontendResult.written.length} files) → ${path.relative(ctx.cwd, frontendResult.outDir)}`,
				);
			}
		}

		return failed.length === 0 ? 0 : 1;
	}
}

// ---------------------------------------------------------------------------
// EntityListCommand
// ---------------------------------------------------------------------------

export class EntityListCommand extends Command {
	static paths = [['entity', 'list']];
	static usage = Command.Usage({
		description: 'List defined entities as a table',
	});

	pattern = Option.String('--pattern', { required: false });
	format = Option.String('--format', 'plain');
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json || this.format === 'json') setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		if (!ctx.entitiesDir) {
			printError('No entities directory found.');
			return 1;
		}

		const files = listEntityYamls(ctx.entitiesDir, resolveProvidersDir(ctx));
		const rows = files
			.map(summarizeEntityFile)
			.filter((r): r is EntitySummaryRow => r !== null)
			.filter((r) => (this.pattern ? r.pattern === this.pattern : true));

		if (isJsonMode()) {
			printJson({
				command: 'entity list',
				entities: rows,
			});
			return 0;
		}

		if (this.format === 'tree') {
			const byPattern = new Map<string, EntitySummaryRow[]>();
			for (const r of rows) {
				const list = byPattern.get(r.pattern) ?? [];
				list.push(r);
				byPattern.set(r.pattern, list);
			}
			for (const [pat, list] of byPattern) {
				console.log(theme.system(pat));
				for (const r of list) {
					console.log(`  ${theme.muted(icons.bullet)} ${r.name}  ${theme.muted(`${r.fields} fields`)}`);
				}
			}
			return 0;
		}

		// plain
		const nameW = Math.max(4, ...rows.map((r) => r.name.length));
		const patW = Math.max(7, ...rows.map((r) => r.pattern.length));
		console.log(
			theme.muted(
				`${padRight('NAME', nameW)}  ${padRight('PATTERN', patW)}  ${padRight('FIELDS', 8)} ${padRight('QUERIES', 8)}`
			)
		);
		for (const r of rows) {
			console.log(
				`${padRight(r.name, nameW)}  ${padRight(r.pattern, patW)}  ${padRight(String(r.fields), 8)} ${padRight(String(r.queries), 8)}`
			);
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// EntityValidateCommand
// ---------------------------------------------------------------------------

export class EntityValidateCommand extends Command {
	static paths = [['entity', 'validate']];
	static usage = Command.Usage({
		description: 'Validate entity YAML definitions against the schema',
	});

	dir = Option.String({ required: false });
	strict = Option.Boolean('--strict', false);
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

		const targetDir = this.dir
			? path.resolve(ctx.cwd, this.dir)
			: ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');

		if (!fs.existsSync(targetDir)) {
			printError(`Directory not found: ${targetDir}`);
			return 1;
		}

		const quick = validateEntities(targetDir);
		const full = await analyzeDomain(targetDir);

		const errors = full.issues.filter((i) => i.severity === 'error');
		const warnings = full.issues.filter((i) => i.severity === 'warning');

		if (isJsonMode()) {
			printJson({
				command: 'entity validate',
				directory: targetDir,
				valid: quick.valid && errors.length === 0,
				errors: errors.map((e) => ({ entity: e.entity, path: e.path, message: e.message })),
				warnings: warnings.map((w) => ({
					entity: w.entity,
					path: w.path,
					message: w.message,
				})),
			});
			if (errors.length > 0) return 1;
			if (this.strict && warnings.length > 0) return 1;
			return 0;
		}

		if (errors.length === 0) {
			printSuccess(`All entities validated — ${full.entities.length} checked`);
		} else {
			printError(`${errors.length} validation errors`);
			for (const e of errors) {
				console.log(`  ${theme.error(icons.error)} ${e.entity ?? e.path ?? ''}: ${e.message}`);
			}
		}
		if (warnings.length > 0) {
			for (const w of warnings) {
				printWarning(`${w.entity ?? w.path ?? ''}: ${w.message}`);
			}
		}

		if (errors.length > 0) return 1;
		if (this.strict && warnings.length > 0) return 1;
		return 0;
	}
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const entityNoun: NounModule = {
	name: 'entity',
	commandClasses: [EntityNewCommand, EntityListCommand, EntityValidateCommand] as CommandClass[],
	summary,
	hints,
};

export default entityNoun;
