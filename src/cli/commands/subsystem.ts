/**
 * Subsystem noun — install / list / remove (stub).
 *
 * Implements SPEC-CLI-03. Installs runtime subsystems (events/jobs/cache/
 * storage) into a user's project by copying `runtime/subsystems/<name>/`
 * plus any referenced runtime dependencies (types, constants).
 *
 * The `runtime/` directory is shipped-read-only; this command only reads it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import {
	detectConfigBlock,
	stripConfigBlock,
	type ConfigBlockState,
	type SubsystemName as DetectorSubsystemName,
} from '../shared/config-block-detect.js';
import { loadContext, type Context } from '../shared/context.js';
import { checkGitSafety } from '../shared/git-safety.js';
import { invokeHygen } from '../shared/hygen.js';
import {
	localsToHygenArgs as eventsLocalsToHygenArgs,
	resolveEventsScaffoldLocals,
} from '../shared/events-scaffold-locals.js';
import {
	localsToHygenArgs,
	resolveJobsScaffoldLocals,
} from '../shared/jobs-scaffold-locals.js';
import {
	localsToHygenArgs as syncLocalsToHygenArgs,
	resolveSyncScaffoldLocals,
} from '../shared/sync-scaffold-locals.js';
import {
	localsToHygenArgs as bridgeLocalsToHygenArgs,
	resolveBridgeScaffoldLocals,
} from '../shared/bridge-scaffold-locals.js';
import { copyRuntime } from '../shared/runtime-copier.js';
import {
	SUBSYSTEMS,
	detectInstalledSubsystems,
	type SubsystemDescriptor,
	type SubsystemName,
	type SubsystemBackend,
	type InstalledSubsystem,
} from '../shared/subsystem-detect.js';
import { resolveSubsystemsRoot } from '../shared/subsystems-path.js';

import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import type { PaneOutput } from '../ui/pane.js';
import type { Hint } from '../ui/hints.js';
import type { NounModule } from '../noun-module.js';

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function runtimeRoot(): string {
	// src/cli/commands/subsystem.ts → ../../../runtime
	return path.resolve(import.meta.dirname, '..', '..', '..', 'runtime');
}

function subsystemSource(name: SubsystemName): string {
	return path.join(runtimeRoot(), 'subsystems', name);
}

function describeSubsystem(name: string): SubsystemDescriptor | null {
	return SUBSYSTEMS.find((s) => s.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// summary + hints
// ---------------------------------------------------------------------------

async function summary(ctx: Context): Promise<PaneOutput> {
	const installed = await detectInstalledSubsystems(ctx);
	const installedNames = new Set(installed.map((i) => i.name));
	const missing = SUBSYSTEMS.filter((s) => !installedNames.has(s.name));

	const body: string[] = [];

	if (installed.length === 0) {
		body.push(theme.muted('Available:'));
		for (const s of SUBSYSTEMS) {
			body.push(
				`  ${theme.muted(icons.dash)} ${s.name.padEnd(10)} ${theme.muted(s.description)}`
			);
		}
		body.push('');
		body.push(theme.muted('No subsystems installed yet.'));
		return {
			title: 'subsystems',
			body,
			footer: `0 of ${SUBSYSTEMS.length} subsystems installed`,
		};
	}

	body.push(theme.muted('Installed:'));
	for (const i of installed) {
		const rel = path.relative(ctx.cwd, i.path) || i.path;
		body.push(
			`  ${theme.success(icons.check)} ${i.name.padEnd(10)} ${theme.muted(
				`${i.backend} backend`
			)}   ${theme.muted(rel)}`
		);
	}

	if (missing.length > 0) {
		body.push('');
		body.push(theme.muted('Available:'));
		for (const s of missing) {
			body.push(
				`  ${theme.muted(icons.dash)} ${s.name.padEnd(10)} ${theme.muted('not installed')}`
			);
		}
	}

	return {
		title: 'subsystems',
		body,
		footer: `${installed.length} of ${SUBSYSTEMS.length} subsystems installed`,
	};
}

async function hints(ctx: Context): Promise<Hint[]> {
	if (!ctx.isInitialized) {
		return [{ command: 'codegen init', description: 'Initialize project' }];
	}
	const installed = await detectInstalledSubsystems(ctx);
	const installedNames = new Set(installed.map((i) => i.name));
	const missing = SUBSYSTEMS.filter((s) => !installedNames.has(s.name));

	if (missing.length === 0) {
		return [{ command: 'codegen subsystem list', description: 'List installed subsystems' }];
	}

	const out: Hint[] = [];
	for (const s of missing.slice(0, 3)) {
		out.push({
			command: `codegen subsystem install ${s.name}`,
			description: `Install the ${s.name} subsystem`,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// SubsystemInstallCommand
// ---------------------------------------------------------------------------

function isValidBackend(
	name: SubsystemName,
	backend: string
): backend is SubsystemBackend {
	const desc = describeSubsystem(name);
	if (!desc) return false;
	return (desc.backends as string[]).includes(backend);
}

function backendFileFilter(
	backend: SubsystemBackend,
	subsystemName: SubsystemName,
): (file: string) => boolean {
	return (file: string) => {
		// JOB-6 (Q1 2026-04-19): the Hygen template
		// `templates/subsystem/jobs/job-orchestration.schema.ejs.t` is the sole
		// emitter for the jobs schema in consumer projects — it gates the
		// `tenantId` column on `jobs.multi_tenant`. Skipping here ensures
		// `copyRuntime` never writes the always-tenant runtime source file.
		if (
			subsystemName === 'jobs' &&
			file === 'job-orchestration.schema.ts'
		) {
			return false;
		}

		// EVT-8: same pattern for events — the Hygen template
		// `templates/subsystem/events/domain-events.schema.ejs.t` is the sole
		// emitter for the events outbox schema, gating the `tenantId` column
		// on `events.multi_tenant`. Skip here so `copyRuntime` never writes
		// the always-tenant runtime source file.
		if (
			subsystemName === 'events' &&
			file === 'domain-events.schema.ts'
		) {
			return false;
		}

		// SYNC-7: same pattern for sync — the Hygen template
		// `templates/subsystem/sync/sync-audit.schema.ejs.t` is the sole
		// emitter for the sync audit schema, gating the `tenant_id`
		// columns on `sync.multi_tenant`. Skip here so `copyRuntime`
		// never writes the always-tenant runtime source file.
		if (
			subsystemName === 'sync' &&
			file === 'sync-audit.schema.ts'
		) {
			return false;
		}

		if (backend === 'memory') {
			if (file.endsWith('.drizzle-backend.ts')) return false;
			if (file.endsWith('.schema.ts')) return false;
			return true;
		}
		// drizzle, local, or unknown — copy everything (memory backend is always
		// needed for tests, even when drizzle is the default runtime backend)
		return true;
	};
}

export class SubsystemInstallCommand extends Command {
	static paths = [['subsystem', 'install']];
	static usage = Command.Usage({
		description: 'Install a runtime subsystem into the project',
		examples: [
			['Install the events subsystem', 'codegen subsystem install events'],
			['Install jobs with memory backend', 'codegen subsystem install jobs --backend memory'],
			['Preview without writing', 'codegen subsystem install cache --dry-run'],
			['Reinstall and regenerate the config block', 'codegen subsystem install jobs --force --force-config'],
		],
	});

	name = Option.String({ required: true });
	backend = Option.String('--backend', { required: false });
	target = Option.String('--target', { required: false });
	force = Option.Boolean('--force', false);
	// #121 (F13): --force no longer clobbers the subsystem config block in
	// codegen.config.yaml. --force-config is the opt-in regeneration path.
	forceConfig = Option.Boolean('--force-config', false);
	yes = Option.Boolean('--yes,-y', false);
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

		const desc = describeSubsystem(this.name);
		if (!desc) {
			printError(
				`Unknown subsystem '${this.name}'. Known: ${SUBSYSTEMS.map((s) => s.name).join(', ')}`
			);
			return 2;
		}

		const backend = (this.backend ?? desc.defaultBackend) as SubsystemBackend;
		if (this.backend && !isValidBackend(desc.name, this.backend)) {
			printError(
				`Backend '${this.backend}' not supported for '${desc.name}'. Valid: ${desc.backends.join(
					', '
				)}`
			);
			return 2;
		}

		const installed = await detectInstalledSubsystems(ctx);
		const already = installed.find((i) => i.name === desc.name);
		if (already && !this.force) {
			if (isJsonMode()) {
				printJson({
					command: 'subsystem install',
					subsystem: desc.name,
					status: 'already-installed',
					path: already.path,
					backend: already.backend,
				});
			} else {
				printInfo(`${desc.name} is already installed at ${already.path} (pass --force to reinstall)`);
			}
			return 0;
		}

		const targetRoot = resolveSubsystemsRoot(ctx, this.target);
		const subsystemTarget = path.join(targetRoot, desc.name);
		const source = subsystemSource(desc.name);

		if (!fs.existsSync(source)) {
			printError(`Runtime subsystem source missing: ${source}`);
			return 1;
		}

		if (!this.force) {
			const gitCheck = checkGitSafety([path.relative(ctx.cwd, subsystemTarget) || subsystemTarget], ctx.cwd);
			if (gitCheck.inRepo && !gitCheck.clean) {
				printWarning(
					`Uncommitted changes under ${subsystemTarget}. Pass --force to overwrite.`
				);
				if (!isJsonMode()) return 1;
			}
		}

		if (!isJsonMode()) {
			printInfo(`target = ${path.relative(ctx.cwd, subsystemTarget) || subsystemTarget}`);
			printInfo(`backend = ${backend}`);
		}

		const result = await copyRuntime({
			sourceDir: source,
			targetDir: subsystemTarget,
			filter: backendFileFilter(backend, desc.name),
			resolveDeps: true,
			runtimeRoot: runtimeRoot(),
			depsTargetRoot: path.resolve(targetRoot, '..'),
			dryRun: this.dryRun,
		});

		// JOB-6: after copyRuntime for the jobs subsystem, scaffold the
		// operational glue (worker.ts, main.ts hook, codegen.config.yaml jobs
		// block, and the tenancy-aware schema). Dry-run reports planned Hygen
		// outputs; failure warns but does not fail the install (runtime files
		// are already written).
		const jobsScaffold =
			desc.name === 'jobs'
				? runJobsScaffold(ctx.cwd, ctx.config, {
						dryRun: this.dryRun,
						json: isJsonMode(),
						forceConfig: this.forceConfig,
					})
				: null;

		// EVT-8: same pattern for the events subsystem — inject the `events:`
		// config block, emit the tenancy-aware outbox schema, and drop a
		// `.gitkeep` so the `generated/` dir exists before `just gen-all`
		// produces the typed artifacts.
		const eventsScaffold =
			desc.name === 'events'
				? runEventsScaffold(ctx.cwd, ctx.config, {
						dryRun: this.dryRun,
						json: isJsonMode(),
						forceConfig: this.forceConfig,
					})
				: null;

		// SYNC-7: sync subsystem — inject the `sync:` config block and emit
		// the tenancy-aware audit schema. No generated/ dir (sync ships no
		// codegen artifacts — see sync-scaffold-locals.ts docstring).
		const syncScaffold =
			desc.name === 'sync'
				? runSyncScaffold(ctx.cwd, ctx.config, {
						dryRun: this.dryRun,
						json: isJsonMode(),
						forceConfig: this.forceConfig,
					})
				: null;

		// BRIDGE-9: bridge subsystem — inject the `bridge:` config block and
		// drop a `generated/.gitkeep` so `bridge-registry-generator.ts` (run
		// at `just gen-all`) has a committed output directory. No schema
		// template — `bridge-delivery.schema.ts` ships via `copyRuntime`
		// (BRIDGE-1's `tenant_id` column is unconditional; multi-tenancy
		// is a runtime-enforcement concern, not a schema branch).
		const bridgeScaffold =
			desc.name === 'bridge'
				? runBridgeScaffold(ctx.cwd, ctx.config, {
						dryRun: this.dryRun,
						json: isJsonMode(),
						forceConfig: this.forceConfig,
					})
				: null;

		// #121 (F13): a parse-error on codegen.config.yaml causes the scaffold
		// to refuse re-injection rather than silently overwrite. Surface it as
		// a non-zero exit with a clear message; runtime files were already
		// copied, so the user can fix their YAML and re-run.
		if (jobsScaffold?.configBlockOutcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject jobs config block. Fix the YAML and re-run.',
			);
			return 1;
		}
		if (eventsScaffold?.configBlockOutcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject events config block. Fix the YAML and re-run.',
			);
			return 1;
		}
		if (syncScaffold?.configBlockOutcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject sync config block. Fix the YAML and re-run.',
			);
			return 1;
		}
		if (bridgeScaffold?.configBlockOutcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject bridge config block. Fix the YAML and re-run.',
			);
			return 1;
		}

		if (isJsonMode()) {
			printJson({
				command: 'subsystem install',
				subsystem: desc.name,
				backend,
				target: subsystemTarget,
				dryRun: this.dryRun,
				files: {
					written: result.written,
					updated: result.updated,
					unchanged: result.unchanged,
					planned: result.planned,
					dependencies: result.dependenciesCopied,
				},
				...(jobsScaffold ? { scaffold: jobsScaffold } : {}),
				...(eventsScaffold ? { scaffold: eventsScaffold } : {}),
				...(syncScaffold ? { scaffold: syncScaffold } : {}),
				...(bridgeScaffold ? { scaffold: bridgeScaffold } : {}),
			});
			return 0;
		}

		if (this.dryRun) {
			printInfo(`Dry run — ${result.planned.length} files would be written`);
			for (const p of result.planned) {
				console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
			}
			if (jobsScaffold?.planned?.length) {
				printInfo(
					`Jobs scaffold — ${jobsScaffold.planned.length} template targets`,
				);
				for (const p of jobsScaffold.planned) {
					console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
				}
			}
			if (eventsScaffold?.planned?.length) {
				printInfo(
					`Events scaffold — ${eventsScaffold.planned.length} template targets`,
				);
				for (const p of eventsScaffold.planned) {
					console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
				}
			}
			if (syncScaffold?.planned?.length) {
				printInfo(
					`Sync scaffold — ${syncScaffold.planned.length} template targets`,
				);
				for (const p of syncScaffold.planned) {
					console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
				}
			}
			if (bridgeScaffold?.planned?.length) {
				printInfo(
					`Bridge scaffold — ${bridgeScaffold.planned.length} template targets`,
				);
				for (const p of bridgeScaffold.planned) {
					console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
				}
			}
			return 0;
		}

		const total = result.written.length + result.updated.length + result.unchanged.length;
		printSuccess(
			`copied ${total} files (${result.written.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged)`
		);
		if (result.dependenciesCopied.length > 0) {
			printInfo(`${result.dependenciesCopied.length} runtime dependencies copied`);
		}
		if (jobsScaffold) {
			if (jobsScaffold.ok) {
				printSuccess(
					`jobs scaffold applied (worker.ts, main.ts hook, config block, schema)`,
				);
			} else {
				printWarning(
					`jobs scaffold (Hygen) failed — runtime files were written; re-run after fixing: ${jobsScaffold.error ?? 'unknown error'}`,
				);
			}
		}
		if (eventsScaffold) {
			if (eventsScaffold.ok) {
				printSuccess(
					`events scaffold applied (config block, schema, generated/.gitkeep)`,
				);
			} else {
				printWarning(
					`events scaffold (Hygen) failed — runtime files were written; re-run after fixing: ${eventsScaffold.error ?? 'unknown error'}`,
				);
			}
		}
		if (syncScaffold) {
			if (syncScaffold.ok) {
				printSuccess(
					`sync scaffold applied (config block, schema)`,
				);
			} else {
				printWarning(
					`sync scaffold (Hygen) failed — runtime files were written; re-run after fixing: ${syncScaffold.error ?? 'unknown error'}`,
				);
			}
		}
		if (bridgeScaffold) {
			if (bridgeScaffold.ok) {
				printSuccess(
					`bridge scaffold applied (config block, generated/.gitkeep)`,
				);
			} else {
				printWarning(
					`bridge scaffold (Hygen) failed — runtime files were written; re-run after fixing: ${bridgeScaffold.error ?? 'unknown error'}`,
				);
			}
		}
		printSuccess(`${desc.name} subsystem installed with ${backend} backend.`);
		printInfo(
			`Register ${capitalize(desc.name)}Module.forRoot({ backend: '${backend}' }) in your app.module.ts`
		);
		if (desc.name === 'sync') {
			printInfo(
				`Per-entity: register ExecuteSyncUseCase + your IChangeSource/ISyncSink bindings in a feature module (see SyncModule docstring).`
			);
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// #121 (F13) — shared config-block action helpers
// ---------------------------------------------------------------------------

/**
 * Outcome of the config-block detection + intended CLI action. Surfaced on
 * every scaffold outcome so the top-level command can print a single
 * authoritative info/error message without re-reading the YAML.
 */
type ConfigBlockOutcome =
	/** Block missing — template will inject defaults. */
	| 'inject'
	/** Block present, `--force-config` NOT set — template skipped. */
	| 'skipped'
	/** Block present, `--force-config` set — stripped + re-injected. */
	| 'overwrite'
	/** YAML failed to parse — caller must bail with a clear error. */
	| 'parse-error';

/**
 * Detect config-block state + decide what the CLI will do with the config
 * action. Side-effect-free (read-only); the actual strip/write happens in
 * `runConfigBlockAction`.
 */
function planConfigBlockAction(
	configPath: string,
	subsystem: DetectorSubsystemName,
	forceConfig: boolean,
): ConfigBlockOutcome {
	// If there's no config file yet, there's nothing to detect — the template
	// will create it (Hygen's `inject: true, append: true` handles missing
	// targets for us on the codegen-config-*-block templates, because they
	// also write to an append-only target). Treat as 'inject'.
	if (!fs.existsSync(configPath)) {
		return 'inject';
	}

	const source = fs.readFileSync(configPath, 'utf-8');
	const state: ConfigBlockState = detectConfigBlock(source, subsystem);

	if (state === 'parse-error') return 'parse-error';
	if (state === 'missing') return 'inject';
	// state === 'present'
	return forceConfig ? 'overwrite' : 'skipped';
}

interface ConfigBlockActionInput {
	cwd: string;
	actionFolder: 'jobs-config' | 'events-config' | 'sync-config' | 'bridge-config';
	configPath: string;
	subsystem: DetectorSubsystemName;
	outcome: ConfigBlockOutcome;
	json: boolean;
}

interface ConfigBlockActionResult {
	ok: boolean;
	error?: string;
}

/**
 * Execute the planned config-block action. Emits user-facing info messages
 * (unless JSON mode is active) and invokes the dedicated Hygen action folder
 * when injection / overwrite is required.
 *
 * 'overwrite' path: we first strip the existing top-level block from the YAML
 * file, then invoke the same inject template. Hygen's `skip_if: "<name>:"`
 * then sees no match and appends fresh defaults. This is cleaner than trying
 * to teach Hygen to overwrite a block in place and keeps the template itself
 * a single inject mode.
 */
function runConfigBlockAction(
	input: ConfigBlockActionInput,
): ConfigBlockActionResult {
	switch (input.outcome) {
		case 'skipped': {
			if (!input.json) {
				printInfo(
					`Config block \`${input.subsystem}:\` already exists in codegen.config.yaml — skipping re-injection. Pass --force-config to overwrite.`,
				);
			}
			return { ok: true };
		}
		case 'overwrite': {
			if (!input.json) {
				printInfo(
					`--force-config: overwriting existing \`${input.subsystem}:\` block.`,
				);
			}
			// Strip then inject. Any error here is a bug (planConfigBlockAction
			// already confirmed the YAML parses), but guard anyway.
			try {
				const source = fs.readFileSync(input.configPath, 'utf-8');
				const stripped = stripConfigBlock(source, input.subsystem);
				fs.writeFileSync(input.configPath, stripped, 'utf-8');
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { ok: false, error: `strip failed: ${message}` };
			}
			return invokeConfigBlockHygen(input);
		}
		case 'inject': {
			return invokeConfigBlockHygen(input);
		}
		case 'parse-error': {
			// Should never reach here — the scaffold functions bail earlier.
			return {
				ok: false,
				error: 'codegen.config.yaml parse error (should have been handled upstream)',
			};
		}
	}
}

function invokeConfigBlockHygen(
	input: ConfigBlockActionInput,
): ConfigBlockActionResult {
	const result = invokeHygen({
		generator: 'subsystem',
		action: input.actionFolder,
		cwd: input.cwd,
		args: ['--configPath', input.configPath],
		inherit: !input.json,
	});
	if (!result.ok) {
		return {
			ok: false,
			error: result.stderr?.trim() || 'hygen exited non-zero',
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// JOB-6 — jobs subsystem Hygen scaffold wiring
// ---------------------------------------------------------------------------

interface JobsScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	/** #121 (F13): surfaces the detector state so the CLI can print a single
	 * authoritative message and, on 'parse-error', fail the command. */
	configBlockOutcome?: ConfigBlockOutcome;
}

function runJobsScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; forceConfig: boolean },
): JobsScaffoldOutcome {
	const locals = resolveJobsScaffoldLocals({
		cwd,
		config,
		fileExists: (p: string) => fs.existsSync(p),
		readFile: (p: string) =>
			fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null,
	});

	// Files the jobs templates will target (used by --dry-run output and
	// JSON reporting). Ordering matches the template set.
	const planned: string[] = [
		...(!locals.workerExists ? [locals.workerPath] : []),
		locals.mainTsPath,
		locals.configPath,
		locals.schemaPath,
	];

	// #121 (F13): inspect the user's codegen.config.yaml BEFORE we invoke the
	// main scaffold so a parse-error aborts early. The main scaffold
	// (`subsystem/jobs`) no longer emits the config block — that lives in
	// `subsystem/jobs-config` and is invoked conditionally below.
	const configBlockOutcome = planConfigBlockAction(
		locals.configPath,
		'jobs',
		opts.forceConfig,
	);

	if (configBlockOutcome === 'parse-error') {
		// Caller surfaces the user-facing error; bail before any writes.
		return { ok: false, planned, configBlockOutcome };
	}

	if (opts.dryRun) {
		return { ok: true, planned, configBlockOutcome };
	}

	const result = invokeHygen({
		generator: 'subsystem',
		action: 'jobs',
		cwd,
		args: localsToHygenArgs(locals),
		// Suppress Hygen stdout in JSON mode so it doesn't corrupt the JSON output.
		inherit: !opts.json,
	});

	if (!result.ok) {
		return {
			ok: false,
			planned,
			error: result.stderr?.trim() || 'hygen exited non-zero',
			configBlockOutcome,
		};
	}

	// Config-block action runs after the main action. It's a separate Hygen
	// invocation targeting the dedicated `subsystem/jobs-config` folder.
	const configResult = runConfigBlockAction({
		cwd,
		actionFolder: 'jobs-config',
		configPath: locals.configPath,
		subsystem: 'jobs',
		outcome: configBlockOutcome,
		json: opts.json,
	});

	if (!configResult.ok) {
		return {
			ok: false,
			planned,
			error: configResult.error,
			configBlockOutcome,
		};
	}

	return { ok: true, planned, configBlockOutcome };
}

// ---------------------------------------------------------------------------
// EVT-8 — events subsystem Hygen scaffold wiring
// ---------------------------------------------------------------------------

interface EventsScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	/** #121 (F13): see JobsScaffoldOutcome. */
	configBlockOutcome?: ConfigBlockOutcome;
}

function runEventsScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; forceConfig: boolean },
): EventsScaffoldOutcome {
	const locals = resolveEventsScaffoldLocals({
		cwd,
		config,
		fileExists: (p: string) => fs.existsSync(p),
	});

	// Files the events templates will target (used by --dry-run output and
	// JSON reporting). Ordering matches the template set.
	const planned: string[] = [
		locals.configPath,
		locals.schemaPath,
		locals.generatedKeepPath,
	];

	// #121 (F13): inspect config BEFORE invoking the main scaffold. Main
	// scaffold no longer emits the config block — `subsystem/events-config`
	// handles that under CLI control.
	const configBlockOutcome = planConfigBlockAction(
		locals.configPath,
		'events',
		opts.forceConfig,
	);

	if (configBlockOutcome === 'parse-error') {
		return { ok: false, planned, configBlockOutcome };
	}

	if (opts.dryRun) {
		return { ok: true, planned, configBlockOutcome };
	}

	const result = invokeHygen({
		generator: 'subsystem',
		action: 'events',
		cwd,
		args: eventsLocalsToHygenArgs(locals),
		// Suppress Hygen stdout in JSON mode so it doesn't corrupt the JSON output.
		inherit: !opts.json,
	});

	if (!result.ok) {
		return {
			ok: false,
			planned,
			error: result.stderr?.trim() || 'hygen exited non-zero',
			configBlockOutcome,
		};
	}

	const configResult = runConfigBlockAction({
		cwd,
		actionFolder: 'events-config',
		configPath: locals.configPath,
		subsystem: 'events',
		outcome: configBlockOutcome,
		json: opts.json,
	});

	if (!configResult.ok) {
		return {
			ok: false,
			planned,
			error: configResult.error,
			configBlockOutcome,
		};
	}

	return { ok: true, planned, configBlockOutcome };
}

// ---------------------------------------------------------------------------
// SYNC-7 — sync subsystem Hygen scaffold wiring
// ---------------------------------------------------------------------------

interface SyncScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	/** #121 (F13): see JobsScaffoldOutcome. */
	configBlockOutcome?: ConfigBlockOutcome;
}

function runSyncScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; forceConfig: boolean },
): SyncScaffoldOutcome {
	const locals = resolveSyncScaffoldLocals({
		cwd,
		config,
		fileExists: (p: string) => fs.existsSync(p),
	});

	// Files the sync templates will target (used by --dry-run output and
	// JSON reporting). Ordering matches the template set. No generated/
	// entry — sync ships no codegen artifacts (see
	// sync-scaffold-locals.ts docstring).
	const planned: string[] = [
		locals.configPath,
		locals.schemaPath,
	];

	// #121 (F13): inspect config BEFORE invoking the main scaffold. Main
	// scaffold no longer emits the config block — `subsystem/sync-config`
	// handles that under CLI control.
	const configBlockOutcome = planConfigBlockAction(
		locals.configPath,
		'sync',
		opts.forceConfig,
	);

	if (configBlockOutcome === 'parse-error') {
		return { ok: false, planned, configBlockOutcome };
	}

	if (opts.dryRun) {
		return { ok: true, planned, configBlockOutcome };
	}

	const result = invokeHygen({
		generator: 'subsystem',
		action: 'sync',
		cwd,
		args: syncLocalsToHygenArgs(locals),
		// Suppress Hygen stdout in JSON mode so it doesn't corrupt the JSON output.
		inherit: !opts.json,
	});

	if (!result.ok) {
		return {
			ok: false,
			planned,
			error: result.stderr?.trim() || 'hygen exited non-zero',
			configBlockOutcome,
		};
	}

	const configResult = runConfigBlockAction({
		cwd,
		actionFolder: 'sync-config',
		configPath: locals.configPath,
		subsystem: 'sync',
		outcome: configBlockOutcome,
		json: opts.json,
	});

	if (!configResult.ok) {
		return {
			ok: false,
			planned,
			error: configResult.error,
			configBlockOutcome,
		};
	}

	return { ok: true, planned, configBlockOutcome };
}

// ---------------------------------------------------------------------------
// BRIDGE-9 — bridge subsystem Hygen scaffold wiring
// ---------------------------------------------------------------------------

interface BridgeScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	configBlockOutcome?: ConfigBlockOutcome;
}

function runBridgeScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; forceConfig: boolean },
): BridgeScaffoldOutcome {
	const locals = resolveBridgeScaffoldLocals({
		cwd,
		config,
		fileExists: (p: string) => fs.existsSync(p),
	});

	// Planned files: only the .gitkeep + config block. Schema flows through
	// `copyRuntime` (no template). See bridge-scaffold-locals.ts docstring.
	const planned: string[] = [
		locals.configPath,
		locals.generatedKeepPath,
	];

	const configBlockOutcome = planConfigBlockAction(
		locals.configPath,
		'bridge',
		opts.forceConfig,
	);

	if (configBlockOutcome === 'parse-error') {
		return { ok: false, planned, configBlockOutcome };
	}

	if (opts.dryRun) {
		return { ok: true, planned, configBlockOutcome };
	}

	const result = invokeHygen({
		generator: 'subsystem',
		action: 'bridge',
		cwd,
		args: bridgeLocalsToHygenArgs(locals),
		inherit: !opts.json,
	});

	if (!result.ok) {
		return {
			ok: false,
			planned,
			error: result.stderr?.trim() || 'hygen exited non-zero',
			configBlockOutcome,
		};
	}

	const configResult = runConfigBlockAction({
		cwd,
		actionFolder: 'bridge-config',
		configPath: locals.configPath,
		subsystem: 'bridge',
		outcome: configBlockOutcome,
		json: opts.json,
	});

	if (!configResult.ok) {
		return {
			ok: false,
			planned,
			error: configResult.error,
			configBlockOutcome,
		};
	}

	return { ok: true, planned, configBlockOutcome };
}

function capitalize(s: string): string {
	return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// SubsystemListCommand
// ---------------------------------------------------------------------------

export class SubsystemListCommand extends Command {
	static paths = [['subsystem', 'list']];
	static usage = Command.Usage({
		description: 'List installed and available subsystems',
	});

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

		const installed = await detectInstalledSubsystems(ctx);
		const byName = new Map<string, InstalledSubsystem>();
		for (const i of installed) byName.set(i.name, i);

		const rows = SUBSYSTEMS.map((s) => {
			const inst = byName.get(s.name);
			return {
				name: s.name,
				status: inst ? 'installed' : 'available',
				backend: inst ? inst.backend : null,
				path: inst ? path.relative(ctx.cwd, inst.path) || inst.path : null,
			};
		});

		if (isJsonMode()) {
			printJson({ command: 'subsystem list', subsystems: rows });
			return 0;
		}

		const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
		console.log(
			theme.muted(`${pad('NAME', 10)}${pad('STATUS', 12)}${pad('BACKEND', 12)}PATH`)
		);
		for (const r of rows) {
			console.log(
				`${pad(r.name, 10)}${pad(r.status, 12)}${pad(r.backend ?? '—', 12)}${r.path ?? '—'}`
			);
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// SubsystemRemoveCommand (stub)
// ---------------------------------------------------------------------------

export class SubsystemRemoveCommand extends Command {
	static paths = [['subsystem', 'remove']];
	static usage = Command.Usage({
		description: 'Remove a subsystem (not yet implemented)',
	});

	name = Option.String({ required: true });
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		if (isJsonMode()) {
			printJson({
				command: 'subsystem remove',
				status: 'not-implemented',
				message:
					'Manually delete the subsystem directory and remove the module registration from your app.module.ts.',
			});
			return 1;
		}
		printError('subsystem remove is not yet implemented.');
		console.log(
			theme.muted(
				'  Manually delete the subsystem directory and remove the module\n  registration from your app.module.ts.'
			)
		);
		return 1;
	}
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const subsystemNoun: NounModule = {
	name: 'subsystem',
	commandClasses: [
		SubsystemInstallCommand,
		SubsystemListCommand,
		SubsystemRemoveCommand,
	] as CommandClass[],
	summary,
	hints,
};

export default subsystemNoun;
