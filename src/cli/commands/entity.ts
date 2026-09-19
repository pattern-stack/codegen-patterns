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
import { junctionsDirFor, loadJunctionSummaries } from '../../parser/load-junctions.js';
import { validateRolesForGeneration } from '../../roles/validate-roles.js';
import {
	loadAppPatternsForCli,
	patternLoadIssues,
	patternLoadRejections,
	resolvePatternGlobs,
} from '../shared/pattern-globs.js';

import { loadContext, type Context } from '../shared/context.js';
import { invokeEntityNew } from '../shared/hygen.js';
import {
	isSemanticEnabled,
	regenerateSemanticModel,
} from '../shared/semantic-generator.js';
import { regenerateRelationsManifest } from '../shared/relations-generator.js';
import { checkGitSafety } from '../shared/git-safety.js';
import {
	regenerateBarrels,
} from '../shared/barrel-generator.js';
import { generateScopeEntityType } from '../shared/scope-entity-type-generator.js';
import { regenerateSubsystemBarrel } from '../shared/subsystem-barrel-generator.js';
import { regenerateSubsystemSchemaBarrel } from '../shared/subsystem-schema-generator.js';
import { generateBridgeRegistry } from '../shared/bridge-registry-generator.js';
import { generateOrchestrationModules } from '../shared/orchestration-generator.js';
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
import { validateSemanticModel } from '../../parser/validate-semantic.js';
import {
	emitProviderModules,
	loadProviderSet,
	resolveTsconfigAliases,
	collectEntitySurfaces,
} from '../shared/provider-module-generator.js';
import { emitAdapters } from '../shared/adapter-emission-generator.js';
import { resolveRuntimeMode } from '../shared/runtime-import.js';
import {
	loadFrontendEmitContext,
	emitFrontendSetWithGraph,
	type ClientGraph,
	CrossSyncModeHopError,
	ReservedRelationAliasError,
} from '../../emitters/frontend/index.js';
import { configuredSubsystemNames } from '../shared/subsystem-detect.js';
import { loadEntities } from '../../parser/load-entities.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import type { AnalysisIssue } from '../../analyzer/types.js';
import { projectLayout } from '../shared/project-layout.js';
import { loadJobs } from '../../parser/load-jobs.js';
import {
	buildJobBridgeTriggers,
	buildJobScheduledEvents,
} from '../shared/job-emission-generator.js';
import { emitJobHandlers, jobLoadRejections } from '../shared/emit-jobs.js';
import {
	issueRejections,
	printRejections,
	rejectionEntry,
	reportPreflightStop,
	type RejectionEntry,
	type RunRejection,
} from '../shared/run-rejections.js';

import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import { reportRegenerationFailure } from '../shared/generated-file.js';
import { generating } from '../../utils/generated-file.js';
import type { PaneOutput } from '../ui/pane.js';
import type { Hint } from '../ui/hints.js';
import type { NounModule } from '../noun-module.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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
	const layout = projectLayout(ctx.cwd, ctx.config);
	if (ctx.entityCount === 0) {
		return {
			title: 'entities',
			body: [
				'No entities defined yet.',
				'',
				`Create one at ${theme.system(`${path.relative(ctx.cwd, layout.entities) || '.'}/<name>.yaml`)} to get started.`,
			],
		};
	}

	const files = listEntityYamls(layout.entities, layout.providers);
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
	if (ctx.entityCount === 0) {
		return [
			{
				command: `codegen entity new ${path.relative(ctx.cwd, path.join(projectLayout(ctx.cwd, ctx.config).entities, 'example.yaml'))}`,
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
	const providersDir = projectLayout(ctx.cwd, ctx.config).providers;
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

/**
 * An `entity new` stop before any target is considered — a usage error, no
 * entity YAML, a dirty generated-output tree. Text mode prints it; JSON mode
 * gets `{ command, status: 'error', error }`, never an empty stdout (#669).
 */
function reportEntityNewError(error: string, code: 1 | 2): 1 | 2 {
	if (isJsonMode()) {
		printJson({ command: 'entity new', status: 'error', error });
	} else {
		printError(error);
	}
	return code;
}

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
			return reportEntityNewError('Pass either a YAML path or --all, not both.', 2);
		}

		let targets: string[] = [];
		if (this.all) {
			const dir = projectLayout(ctx.cwd, ctx.config).entities;
			targets = listEntityYamls(dir, projectLayout(ctx.cwd, ctx.config).providers);
			if (targets.length === 0) {
				return reportEntityNewError(`No entity YAML files found in ${dir}`, 1);
			}
		} else if (this.yaml) {
			targets = [path.resolve(ctx.cwd, this.yaml)];
		} else {
			return reportEntityNewError('Missing YAML path. Pass a file or --all.', 2);
		}

		// Pre-flight. Three checks can reject a target before hygen runs: the
		// schema (per file), the EVT-7 `emits:` cross-check against the merged
		// event registry, and the CAP-2 `roles:` cross-check. The last two are
		// cross-entity — an emitted event or a role's target lives in another
		// YAML — so neither the schema nor the one-entity hygen prompt can run
		// them. Every rejection keeps its per-issue details (the same diagnostics
		// `entity validate` prints) and is reported in every mode (#627):
		// `--continue-on-error` decides whether the run stops, never whether the
		// reason is shown.
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

		const entitiesDirForEmits = projectLayout(ctx.cwd, ctx.config).entities;
		const eventsDirForEmits = projectLayout(ctx.cwd, ctx.config).eventsDir;
		const allEntitiesForEmits = loadEntities(entitiesDirForEmits, {
			excludeDirs: [projectLayout(ctx.cwd, ctx.config).providers],
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

		for (const w of emitsWarnings) {
			printWarning(w.message);
		}
		const noEmitsCount = emitsWarnings.filter(
			(w) => w.type === 'no_emits',
		).length;
		if (noEmitsCount > 0) {
			printInfo(`${noEmitsCount} entities missing emits:`);
		}

		// SEM-1: pre-flight cross-validate the declared semantic model. The
		// catalog the emitter will build is one flat namespace across entities,
		// so an unresolvable metric leg or a duplicate measure key can only be
		// caught with the whole set in hand — which the emits pre-flight above
		// already loaded. Same continue-on-error contract as emits:.
		const semanticIssues: AnalysisIssue[] = validateSemanticModel(
			allEntitiesForEmits,
			emitsTargetEntities,
		);
		const semanticErrors = semanticIssues.filter((i) => i.severity === 'error');

		if (semanticErrors.length > 0 && !this.continueOnError) {
			if (!isJsonMode()) {
				for (const e of semanticErrors) {
					printError(`${e.entity ?? '(unknown)'}: ${e.message}`);
				}
				return 1;
			}
		}
		// Run-level rejections (JOBS-2): an input every entity's output depends
		// on, so it is not one target's problem and `--continue-on-error` does not
		// apply — the run stops before hygen whatever the flag says.
		const runRejections: RunRejection[] = [];

		// App patterns must be in THIS process's registry before the roles
		// pre-flight: a role's target qualifies by declaring an `Actor`
		// capability, which an app may define (and must, until the library ships
		// one). The hygen subprocess loads them for itself; this is the CLI's copy.
		// A file the loader could not register leaves a partial pattern set: the
		// orchestration step would rewrite its root barrel without that module,
		// and a role or `patterns:` entry naming it would resolve against the
		// wrong registry (#664, from the #660 audit).
		runRejections.push(...patternLoadRejections(await loadAppPatternsForCli(ctx), ctx.cwd));

		// Job definitions (RFC-0005 #7) — loaded ONCE, here, so their derived
		// artifacts feed the event + bridge codegen in the SAME pass: each
		// `schedule` arm desugars to a job-private scheduled event merged into the
		// event registry, and every trigger becomes a declarative bridge mapping.
		// The handler files themselves are emitted later (post-assembly). Opt-in:
		// no `definitions/jobs/` ⇒ empty. An invalid job YAML is a run-level
		// rejection (#664): its handler base, scheduled events and bridge triggers
		// feed registries every entity imports, and a previously emitted
		// `<type>.job.generated.ts` would outlive its dropped registrations.
		const { jobsDir, jobHandlers } = projectLayout(ctx.cwd, ctx.config);
		const jobLoad = loadJobs(jobsDir);
		runRejections.push(...jobLoadRejections(jobLoad.issues, jobHandlers));

		// Provider definitions (RFC-0001, Track D) — loaded and cross-validated
		// ONCE, here; the post-step emits from this set. A blocking issue (a YAML
		// that does not load, an unknown surface, a duplicate slug, an
		// unresolvable auth / client import) is a run-level rejection (#666): a
		// provider's module is imported by its surface's adapters module, its
		// change sources feed the surface registry, and its assembly modules are
		// imported by every integrated entity's integration wiring — skipping it
		// would regenerate the entities beside a stale integration layer. The
		// D1 import pre-flight resolves `@app/…#Export` against the consumer
		// tsconfig; with no tsconfig it is skipped (slug / surface checks still run).
		const { providers: providersDir } = projectLayout(ctx.cwd, ctx.config);
		const tsAliases = resolveTsconfigAliases(ctx.cwd);
		const providerSet = loadProviderSet({
			providersDir,
			entitySurfaces: collectEntitySurfaces(
				loadEntitiesFromYaml(listEntityYamls(entitiesDirForEmits, providersDir)).successes.map(
					(s) => s.definition,
				),
			),
			sourceRoot: tsAliases?.sourceRoot,
			aliases: tsAliases?.aliases,
			skipImportCheck: tsAliases === null,
		});
		runRejections.push(...issueRejections(providerSet.issues));

		// Reuses the entity set the emits pre-flight already loaded. A bad role is
		// a generation-time error (the ADR-041 §4 posture).
		const roleErrors = validateRolesForGeneration({
			targets: emitsTargetEntities,
			entities: allEntitiesForEmits,
			junctions: loadJunctionSummaries(junctionsDirFor(ctx.cwd)),
		});

		// An entity with an `emits:` or `roles:` error is not generated: the
		// hygen prompt assumes both blocks are valid.
		for (let i = validated.length - 1; i >= 0; i--) {
			const v = validated[i]!;
			const ownEmits = emitsErrors.filter((e) => e.entity === v.name);
			const ownRoles = roleErrors.filter((e) => e.entity === v.name);
			if (ownEmits.length === 0 && ownRoles.length === 0) continue;
			const blocks = [
				...(ownEmits.length > 0 ? ['emits:'] : []),
				...(ownRoles.length > 0 ? ['roles:'] : []),
			];
			invalid.push({
				file: v.file,
				message: `${blocks.join(' and ')} validation failed`,
				details: [...ownEmits, ...ownRoles].map((e) => e.message),
			});
			validated.splice(i, 1);
		}

		printRejections([...invalid, ...runRejections]);

		if (runRejections.length > 0 || (invalid.length > 0 && !this.continueOnError)) {
			return reportPreflightStop('entity new', [...invalid, ...runRejections]);
		}

		// Git safety — we don't know specific output paths without running Hygen,
		// so scope the check to the cwd's generated source roots if we can.
		if (!this.force) {
			const outputRoots = projectLayout(ctx.cwd, ctx.config);
			const gitCheck = checkGitSafety([outputRoots.backendSrc, outputRoots.modules, outputRoots.generated], ctx.cwd);
			if (gitCheck.inRepo && !gitCheck.clean) {
				const error = `Uncommitted changes in ${gitCheck.dirty.length} generated-output files. Pass --force to overwrite.`;
				// JSON mode stops too (it used to fall through and overwrite them): CLI-1.
				if (isJsonMode()) return reportEntityNewError(error, 1);
				printWarning(error);
				return 1;
			}
		}

		// Compute barrel plan (used in both dry-run reporting and post-gen execution).
		const entitiesDir = projectLayout(ctx.cwd, ctx.config).entities;
		const relationshipsDir = path.resolve(ctx.cwd, 'relationships');
		const generatedDir = projectLayout(ctx.cwd, ctx.config).generated;

		const subsystemsRoot = projectLayout(ctx.cwd, ctx.config).subsystems;
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

		const eventsDir = projectLayout(ctx.cwd, ctx.config).eventsDir;
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
		// Handlers dir: `<backend_src>/jobs` (the layout's `jobHandlers`).
		// Recursive scan tolerates absent dir (returns empty registry).
		const layout = projectLayout(ctx.cwd, ctx.config);

		// `runtimeMode` (ADR-037) is resolved above — it drives the bridge
		// registry output (mode-aware) plus every runtime import specifier the
		// integration emitters write. Defaults to `package` (the new default).
		const bridgeHandlersDir = layout.jobHandlers;

		// Orchestration emission root (ADR-032 Phase 3-2 / O-6):
		// `paths.orchestration_src`, default `<backend_src>/orchestration`.
		const orchestrationOutputRoot = layout.orchestration;

		// Pattern globs used to discover orchestration patterns — the resolved
		// `patterns:` list (default `<backend_src>/patterns/*.pattern.ts`).
		const orchestrationGlobs = resolvePatternGlobs(ctx);

		// Helper — reload registry + return orchestration patterns. A throw
		// fails the orchestration step (JOBS-1, #660); a per-file loader error
		// already stopped the run in the pre-flight (JOBS-2).
		const loadOrchestrationPatterns = async () => {
			_resetRegistryForTests({ includeLibrary: false });
			await loadAppPatterns(orchestrationGlobs, ctx.cwd);
			return getAllOrchestrationPatterns();
		};

		// The pre-flight loaded the job definitions; because the bridge/schedule
		// contributions come from the LOADED defs (not the emitted files), there is
		// no two-pass ordering hazard.
		const jobScheduledEvents = jobLoad.jobs.flatMap((j) =>
			buildJobScheduledEvents(j),
		);
		const jobBridgeTriggers = jobLoad.jobs.flatMap((j) =>
			buildJobBridgeTriggers(j, path.join(jobsDir, `${j.type}.yaml`)),
		);

		if (this.dryRun) {
			const barrelPlan = await regenerateBarrels({
				ctx,
				entitiesDir,
				relationshipsDir,
				generatedDir,
				dryRun: true,
			});

			const semanticPlan = isSemanticEnabled(ctx)
				? regenerateSemanticModel({ ctx, entitiesDir, generatedDir, dryRun: true })
				: null;
			// Same failure contract as the real run below: a relation-key
			// collision is reported as an error and fails the command — never an
			// uncaught stack trace (docs/specs/REL-1.md §3).
			let relationsPlan: ReturnType<typeof regenerateRelationsManifest> | null = null;
			let relationsError: string | null = null;
			try {
				relationsPlan = regenerateRelationsManifest({
					ctx,
					entitiesDir,
					generatedDir,
					dryRun: true,
				});
			} catch (err: unknown) {
				relationsError = err instanceof Error ? err.message : String(err);
			}

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
				extraSugarEvents: jobScheduledEvents,
				dryRun: true,
			});

			const bridgeRegistryPlan = await generateBridgeRegistry({
				handlersDir: bridgeHandlersDir,
				eventsGeneratedDir: eventCodegenOutputDir,
				outputDir: bridgeRegistryOutputDir,
				mode: runtimeMode,
				bridgeInstalled: bridgeInstalledForRegistry,
				extraTriggers: jobBridgeTriggers,
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
					invalid: invalid.map(rejectionEntry),
					barrels: {
						modules: barrelPlan.modulesBarrel,
						schema: barrelPlan.schemaBarrel,
						entityCount: barrelPlan.entityCount,
						modulesContent: barrelPlan.modulesContent,
						schemaContent: barrelPlan.schemaContent,
					},
					relations: {
						file: relationsPlan?.file ?? null,
						warnings: relationsPlan?.warnings ?? [],
						error: relationsError,
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
				console.log('');
				printInfo(`Barrels (${barrelPlan.entityCount} entities):`);
				console.log(`  ${theme.muted(icons.arrow)} ${barrelPlan.modulesBarrel}`);
				console.log(`  ${theme.muted(icons.arrow)} ${barrelPlan.schemaBarrel}`);
				if (semanticPlan) {
					printInfo(
						semanticPlan.skip !== undefined
							? `semantic model: skipped — ${semanticPlan.skip}`
							: `semantic model (${Object.keys(semanticPlan.result.contents).length} files): ${semanticPlan.result.outDir}`,
					);
				}
				if (relationsPlan) {
					printInfo(`relations manifest: ${relationsPlan.file}`);
					for (const warning of relationsPlan.warnings) {
						printWarning(`relations: ${warning}`);
					}
				} else {
					printError(`relations manifest generation failed — ${relationsError}`);
				}
				printInfo(
					`ScopeEntityType (${scopePlan.scopeableNames.length} scopeable): ${scopePlan.outputPath}`,
				);
				printInfo(
					`event codegen (${eventCodegenPlan.eventCount} events) → ${eventCodegenPlan.outputDir}`,
				);
			}
			// A dry run predicts the real run's exit code: a relation-key collision
			// (REL-1) and rejected entities (CLI-0) each fail it, the latter
			// whatever `--continue-on-error` says.
			if (relationsError !== null) return 1;
			return invalid.length > 0 ? 1 : 0;
		}

		// Invoke Hygen for each validated target.
		const succeeded: string[] = [];
		const failed: RejectionEntry[] = invalid.map(rejectionEntry);
		for (const v of validated) {
			if (!isJsonMode()) {
				printInfo(`generating ${v.name}`);
			}
			const res = invokeEntityNew(v.file, ctx.cwd, ctx.configPath);
			if (res.ok) {
				succeeded.push(v.name);
				if (!isJsonMode()) printSuccess(`${v.name}`);
			} else {
				failed.push({
					name: v.name,
					file: v.file,
					message: res.stderr ?? 'Hygen invocation failed',
					details: [],
				});
				if (!isJsonMode()) printError(`${v.name} — ${res.stderr ?? 'failed'}`);
				if (!this.continueOnError) break;
			}
		}

		// Regenerate the barrels once, after all Hygen invocations. Each is total:
		// - `<generated>/modules.ts` + `schema.ts` — every .yaml in entitiesDir is
		//   re-scanned, so deleting an entity YAML and re-running removes it (ADR-017);
		// - `<generated>/subsystems.ts` + `app-config.ts` — re-read from
		//   `subsystems.install` + the per-subsystem option blocks;
		// - `<generated>/subsystems-schema.ts` — each installed subsystem's Drizzle
		//   tables + pgEnums, so drizzle-kit emits their CREATE TABLE / CREATE TYPE
		//   without the consumer hand-re-exporting them (the "#9 footgun").
		// The app imports every one of them: a failed regeneration fails the
		// command, naming the file (JOBS-0, #655).
		let barrelResult: Awaited<ReturnType<typeof regenerateBarrels>>;
		try {
			barrelResult = await regenerateBarrels({
				ctx,
				entitiesDir,
				relationshipsDir,
				generatedDir,
			});
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}

		// Relations manifest (REL-1, ADR-044) — one `defineRelations()` over the
		// generated schema barrel, from the full entity + junction set. Unlike the
		// sibling post-steps this one is NOT warn-but-don't-fail: the emitted
		// `database.module.ts` imports the manifest, so a project that continues
		// past a failure here does not compile. A relation-key collision is a
		// declaration the author has to fix (docs/specs/REL-1.md §3).
		let relationsResult: ReturnType<typeof regenerateRelationsManifest> | null = null;
		let relationsFailed = false;
		try {
			relationsResult = regenerateRelationsManifest({ ctx, entitiesDir, generatedDir });
			if (!isJsonMode()) {
				for (const warning of relationsResult.warnings) {
					printWarning(`relations: ${warning}`);
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			relationsFailed = true;
			printError(`relations manifest generation failed — ${msg}`);
		}

		// Regenerate the subsystem composition barrel (<generated>/subsystems.ts).
		// Total — re-reads `subsystems.install` + per-subsystem option blocks from
		// codegen.config.yaml every time. The app imports it, so a failed
		// regeneration fails the command naming the file (JOBS-0, #655) — the
		// warn-but-don't-fail this block used to do was the defect.
		try {
			await regenerateSubsystemBarrel({ ctx, generatedDir });
			await regenerateSubsystemSchemaBarrel({ ctx, generatedDir });
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}

		// Every post-step below writes files the app imports — the ScopeEntityType
		// union, the event codegen modules, the bridge registry, the orchestration
		// modules, the frontend tree, the provider / adapter / assembly / job
		// handler files. A failed step fails the command, naming the file (or the
		// step's output root when it failed before writing): JOBS-1, #660. Declared
		// skips (bridge not installed, no entities for the frontend, a surface with
		// no package) are not failures and stay informational.

		// Regenerate ScopeEntityType union after barrels (full directory rescan).
		// Always runs for both single-file and --all modes (OQ-1: always rescan).
		let scopeResult: Awaited<ReturnType<typeof generateScopeEntityType>>;
		try {
			scopeResult = await generating(scopeEntityTypePath, () =>
				generateScopeEntityType({
					entitiesDir,
					outputPath: scopeEntityTypePath,
				}),
			);
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}

		// Regenerate event codegen artifacts (EVT-3) after scope-entity-type. An
		// error-severity issue means nothing was written — the modules the app
		// imports would stay stale — so it fails the command too.
		let eventCodegenResult: Awaited<ReturnType<typeof generateEventCodegen>>;
		try {
			eventCodegenResult = await generating(eventCodegenOutputDir, async () => {
				const result = await generateEventCodegen({
					entitiesDir,
					eventsDir,
					outputDir: eventCodegenOutputDir,
					mode: runtimeMode,
					extraSugarEvents: jobScheduledEvents,
				});
				const errors = result.issues.filter((i) => i.severity === 'error');
				if (errors.length > 0) {
					throw new Error(
						errors.map((i) => `${i.message}${i.path ? ` (${i.path})` : ''}`).join('; '),
					);
				}
				return result;
			});
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}

		// Bridge registry codegen (BRIDGE-6, ADR-023 Phase 2). Runs AFTER event
		// codegen so the freshly-emitted eventRegistry is available for
		// build-time validation (an unknown / duplicate / audit-tier trigger fails).
		let bridgeRegistryResult: Awaited<ReturnType<typeof generateBridgeRegistry>>;
		try {
			bridgeRegistryResult = await generating(bridgeRegistryOutputDir, () =>
				generateBridgeRegistry({
					handlersDir: bridgeHandlersDir,
					eventsGeneratedDir: eventCodegenOutputDir,
					outputDir: bridgeRegistryOutputDir,
					mode: runtimeMode,
					bridgeInstalled: bridgeInstalledForRegistry,
					extraTriggers: jobBridgeTriggers,
				}),
			);
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}
		if (bridgeRegistryResult.skipped && !isJsonMode()) {
			printInfo('bridge subsystem not installed — skipping bridge registry codegen');
		}

		// Orchestration emission (ADR-032 Phase 3-2/3). Hooked here so
		// `just gen-all` keeps being a single "build everything" entrypoint per
		// Phase 3-2 §3.2.
		let orchestrationResult: ReturnType<typeof generateOrchestrationModules>;
		try {
			orchestrationResult = await generating(orchestrationOutputRoot, async () =>
				generateOrchestrationModules({
					patterns: await loadOrchestrationPatterns(),
					outputRoot: orchestrationOutputRoot,
				}),
			);
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}

		// Frontend emission (ADR-038 FE-4). Whole-set: renders the complete
		// frontend tree (base files, REST api client, collections, entity hooks,
		// store, fields, barrel) from the FULL entity set in one pass — so it runs
		// ONCE here, after the per-entity Hygen loop, never per entity. Gated on
		// `generate.frontend === true`; off by default (backend-only projects emit
		// nothing). A skip (no entities) prints; a failure fails the command. The
		// output is deterministic for a given entity set (safe under re-run /
		// baseline wipe-and-regenerate).
		let frontendResult: {
			written: string[];
			outDir: string;
			graph: ClientGraph | null;
		} | null = null;
		let frontendFailed = false;
		const frontendConfig = ctx.config?.generate.frontend === true ? ctx.config : null;
		if (frontendConfig) {
			const frontendRoot = layout.frontendSrc;
			try {
				frontendResult = generating(frontendRoot, () => {
					const loaded = loadFrontendEmitContext(ctx.cwd, frontendConfig, { entitiesDir });
					if (loaded.skip !== undefined) {
						if (!isJsonMode()) printInfo(`frontend emission skipped — ${loaded.skip}`);
						return null;
					}
					const { ctx: frontendCtx, outDir: frontendOutDir } = loaded;
					const { written, graph } = emitFrontendSetWithGraph(
						frontendCtx,
						frontendOutDir,
					);
					return { written, outDir: frontendOutDir, graph };
				});
			} catch (err: unknown) {
				return reportRegenerationFailure('entity new', err);
			}
			if (frontendResult && !isJsonMode()) {
				printInfo(
					`frontend emitted (${frontendResult.written.length} files) → ${path.relative(ctx.cwd, frontendResult.outDir)}`,
				);
				// The graph step's drops and deferrals are printed, never silently
				// swallowed: a relation that is declared but not navigable on the
				// client is something the author has to be able to see (charter I9).
				for (const warning of frontendResult.graph?.warnings ?? []) {
					printWarning(`frontend graph: ${warning}`);
				}
				for (const deferral of frontendResult.graph?.deferred ?? []) {
					printInfo(
						`frontend graph: no accessors for '${deferral.entity}' — ${deferral.reason}`,
					);
				}
			}
		}

		// Semantic model emission (SEM-2, ADR-045). Whole-set: renders the
		// declared `AggregateModel` — registry, analytics field tags, tables,
		// colByDbName and the composite catalog — from the FULL entity +
		// junction set in one pass, so it runs ONCE here, after the per-entity
		// Hygen loop. Gated on `generate.semantic === true`; off by default.
		//
		// Warn-but-don't-fail, like the frontend emitter and UNLIKE the relations
		// manifest: no emitted file imports the semantic model, so a failure here
		// does not stop the generated project from compiling.
		let semanticResult: { outDir: string; written: string[] } | null = null;
		if (isSemanticEnabled(ctx)) {
			try {
				const emitted = regenerateSemanticModel({ ctx, entitiesDir, generatedDir });
				if (emitted.skip !== undefined) {
					if (!isJsonMode()) {
						printInfo(`semantic model skipped — ${emitted.skip}`);
					}
				} else {
					semanticResult = {
						outDir: emitted.result.outDir,
						written: emitted.result.written,
					};
					if (!isJsonMode()) {
						for (const warning of emitted.result.warnings) {
							printWarning(`semantic: ${warning}`);
						}
					}
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!isJsonMode()) {
					printWarning(`semantic model emission failed — ${msg}`);
				}
			}
		}

		// Provider module emission (RFC-0001 §2, Track D · D2). Emits one
		// `<slug>.provider.module.ts` per `definitions/providers/*.yaml`, from the
		// set the pre-flight loaded and validated (a blocking issue already
		// stopped the run). Skips cleanly when no providers dir exists, so
		// projects without integrations see no change.
		const providerOutputRoot = path.join(layout.backendSrc, 'integrations/providers');
		let providerResult: ReturnType<typeof emitProviderModules>;
		try {
			providerResult = generating(providerOutputRoot, () =>
				emitProviderModules(providerSet, {
					outputRoot: providerOutputRoot,
					mode: runtimeMode,
				}),
			);
		} catch (err: unknown) {
			return reportRegenerationFailure('entity new', err);
		}
		if (!providerResult.skipped && !isJsonMode()) {
			printInfo(
				`provider modules regenerated (${providerResult.written.length}) → ${providerOutputRoot}`,
			);
		}

		// Adapter / module / barrel / surface-aggregator emission (RFC-0001 §2/§4,
		// Track D · D3). Runs only when provider emission produced modules (no
		// providers dir ⇒ provider step skipped ⇒ nothing to adapt). Emit-once
		// scaffolds are never overwritten; @generated files re-emit each run. A
		// provider surface with no surface package (Track C) is skipped with a
		// reason, not an error.
		const adapterOutputRoot = path.join(layout.backendSrc, 'integrations');
		if (!providerSet.skipped) {
			let adapterResult: ReturnType<typeof emitAdapters>;
			try {
				adapterResult = generating(adapterOutputRoot, () => {
					const entityDefs = loadEntitiesFromYaml(
						listEntityYamls(entitiesDir, providersDir),
					).successes.map((s) => s.definition);
					// The consumer's tsconfig aliases (resolved for the provider import
					// pre-flight) make the assembly's entity repo/module imports prefer
					// the project's `@modules/...`-style alias.
					return emitAdapters({
						providers: providerSet.loaded,
						entities: entityDefs,
						outputRoot: adapterOutputRoot,
						backendSrcAbs: layout.backendSrc,
						modulesAbs: layout.modules,
						aliases: tsAliases?.aliases ?? {},
						mode: runtimeMode,
					});
				});
			} catch (err: unknown) {
				return reportRegenerationFailure('entity new', err);
			}
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

		// Jobs handler emission (RFC-0005 #7). Runs LAST among the integration
		// steps: the per-arm `runArm*` seam wires the assembly's
		// ExecuteIntegrationUseCase, so the assemblies must exist first. The
		// scheduled-event + bridge-trigger contributions already rode the event /
		// bridge codegen above (from the early `jobLoad`); this step only writes the
		// `@generated` base (reflow) + emit-once subclass per job into
		// `<backend_src>/jobs/`.
		if (jobLoad.jobs.length > 0) {
			let jobEmit: ReturnType<typeof emitJobHandlers>;
			try {
				jobEmit = generating(bridgeHandlersDir, () =>
					emitJobHandlers({
						jobs: jobLoad.jobs,
						jobsHandlersDir: bridgeHandlersDir,
						mode: runtimeMode,
					}),
				);
			} catch (err: unknown) {
				return reportRegenerationFailure('entity new', err);
			}
			if (!isJsonMode()) {
				printInfo(
					`jobs: emitted ${jobEmit.basesWritten.length} handler base(s); ` +
						`${jobEmit.scaffoldsWritten.length} scaffold(s) written, ` +
						`${jobEmit.scaffoldsSkipped.length} kept`,
				);
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
				barrels: {
					modules: barrelResult.modulesBarrel,
					schema: barrelResult.schemaBarrel,
					entityCount: barrelResult.entityCount,
				},
				scopeEntityType: {
					outputPath: scopeResult.outputPath,
					scopeableNames: scopeResult.scopeableNames,
				},
				eventCodegen: {
					outputDir: eventCodegenResult.outputDir,
					eventCount: eventCodegenResult.eventCount,
					written: eventCodegenResult.written,
					files: eventCodegenResult.files.map((f) => ({
						name: f.name,
						outputPath: f.outputPath,
					})),
				},
				bridgeRegistry: {
					outputDir: bridgeRegistryResult.outputDir,
					triggerCount: bridgeRegistryResult.triggerCount,
					eventTypeCount: bridgeRegistryResult.eventTypeCount,
					written: bridgeRegistryResult.written,
				},
				orchestration: {
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
				},
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
			printInfo(
				`barrels regenerated (${barrelResult.entityCount} entities) → ${path.relative(ctx.cwd, barrelResult.modulesBarrel)}, ${path.relative(ctx.cwd, barrelResult.schemaBarrel)}`
			);
			printInfo(
				`scope-entity-type regenerated (${scopeResult.scopeableNames.length} scopeable) → ${path.relative(ctx.cwd, scopeResult.outputPath)}`
			);
			printInfo(
				`event codegen regenerated (${eventCodegenResult.eventCount} events) → ${path.relative(ctx.cwd, eventCodegenResult.outputDir)}`
			);
			if (orchestrationResult.patterns.length > 0) {
				printInfo(
					`orchestration regenerated (${orchestrationResult.patterns.length} patterns, ${orchestrationResult.files.length} files) → ${path.relative(ctx.cwd, orchestrationResult.outputRoot)}`,
				);
			}
			if (frontendResult) {
				printInfo(
					`frontend regenerated (${frontendResult.written.length} files) → ${path.relative(ctx.cwd, frontendResult.outDir)}`,
				);
			}
			if (semanticResult) {
				printInfo(
					`semantic model regenerated (${semanticResult.written.length} files) → ${path.relative(ctx.cwd, semanticResult.outDir)}`,
				);
			}
			if (relationsResult) {
				printInfo(
					`relations manifest regenerated → ${path.relative(ctx.cwd, relationsResult.file)}`,
				);
			}
		}

		return failed.length === 0 && !relationsFailed && !frontendFailed ? 0 : 1;
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

		const layout = projectLayout(ctx.cwd, ctx.config);
		if (!fs.existsSync(layout.entities)) {
			printError(`Entities directory not found: ${layout.entities} (paths.entities)`);
			return 1;
		}

		const files = listEntityYamls(layout.entities, layout.providers);
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
			: projectLayout(ctx.cwd, ctx.config).entities;

		if (!fs.existsSync(targetDir)) {
			printError(`Directory not found: ${targetDir}`);
			return 1;
		}

		// App patterns (ADR-031) and app capabilities (ADR-041) resolve by name
		// in the validators below — load them into this process's registry
		// first, or every app pattern is reported as unknown. A file the loader
		// could not register is an error: the registry is partial (#667).
		const loaderIssues = patternLoadIssues(await loadAppPatternsForCli(ctx), ctx.cwd);

		const quick = validateEntities(targetDir);
		const full = await analyzeDomain(targetDir);

		const errors = [...loaderIssues, ...full.issues.filter((i) => i.severity === 'error')];
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
