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
import {
	localsToHygenArgs as observabilityLocalsToHygenArgs,
	resolveObservabilityScaffoldLocals,
} from '../shared/observability-scaffold-locals.js';
import {
	localsToHygenArgs as authLocalsToHygenArgs,
	resolveAuthScaffoldLocals,
} from '../shared/auth-scaffold-locals.js';
import {
	localsToHygenArgs as authIntegrationsLocalsToHygenArgs,
	resolveAuthIntegrationsScaffoldLocals,
} from '../shared/auth-integrations-scaffold-locals.js';
import { copyRuntime } from '../shared/runtime-copier.js';
import { resolveGeneratedDir } from '../shared/barrel-generator.js';
import { regenerateSubsystemBarrel } from '../shared/subsystem-barrel-generator.js';
import {
	SUBSYSTEMS,
	detectInstalledSubsystems,
	detectSubsystemStates,
	type SubsystemDescriptor,
	type SubsystemName,
	type SubsystemBackend,
	type InstalledSubsystem,
} from '../shared/subsystem-detect.js';
import {
	resolveSubsystemsRoot,
	resolveSubsystemsRootFromConfig,
} from '../shared/subsystems-path.js';

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
	// Dev (source): src/cli/commands/subsystem.ts → ../../../runtime
	// Published (bundled): dist/src/cli/index.js → ../../../runtime doesn't exist,
	// but dist/runtime does. Prefer the top-level runtime/ when present (dev),
	// fall back to dist/runtime/ (published npm tarball layout).
	const pkgRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const topLevel = path.join(pkgRoot, 'runtime');
	if (fs.existsSync(topLevel)) return topLevel;
	return path.join(pkgRoot, 'dist', 'runtime');
}

export function subsystemSource(name: SubsystemName): string {
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

export function backendFileFilter(
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

		// #287: same pattern as events/jobs/sync — the auth Hygen template
		// `templates/subsystem/auth/auth-oauth-state.schema.ejs.t` is the
		// sole emitter for the `auth_oauth_state` schema in consumer
		// projects. Skipping here ensures `copyRuntime` never writes the
		// runtime source file.
		if (
			subsystemName === 'auth' &&
			file === 'auth-oauth-state.schema.ts'
		) {
			return false;
		}

		// #6: alternate-backend pruning. Each subsystem ships every backend
		// variant in `runtime/subsystems/<name>/`, but vendoring all of them
		// into a consumer that picked one drags peer deps (`ioredis`,
		// `bullmq`) the consumer never installs, and (for bullmq) forces
		// consumer-side strict-TS gymnastics. Skip files for backends that
		// aren't the selected one, regardless of which subsystem we're in:
		//
		//   - `*.redis-backend.ts`  — only vendor when backend === 'redis'
		//   - `*.bullmq-backend.ts` — only vendor when backend === 'bullmq'
		//   - `bullmq.config.ts`    — needed only by the bullmq path (drops
		//     its `bullmq` peer-dep type import per the same patch, so it's
		//     SAFE to keep when the consumer doesn't have bullmq, but the
		//     module never reaches it without the backend)
		//
		// Memory backend gets the same pruning PLUS its existing skip of
		// `.drizzle-backend.ts` + `.schema.ts`. Drizzle / local / unknown
		// vendor everything EXCEPT the alternate-backend files.
		if (file.endsWith('.redis-backend.ts') && backend !== 'redis') return false;
		if (file.endsWith('.bullmq-backend.ts') && backend !== 'bullmq') return false;
		if (
			subsystemName === 'jobs' &&
			file === 'bullmq.config.ts' &&
			backend !== 'bullmq'
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

		// OPENAPI-4: `openapi-config` is a config-only pseudo-subsystem.
		// It ships no runtime files (the registry is vendored at `project
		// init`); installing it means injecting the `openapi:` block into
		// codegen.config.yaml. Short-circuit the full runtime-copy flow.
		if (desc.name === 'openapi-config') {
			return this.executeOpenApiConfig(ctx);
		}

		// #287: auth-integrations is vendored from `examples/auth-integrations/`,
		// not from `runtime/subsystems/`. The shape is so different
		// (full-file copies of adapters + entity yaml; no ports/backends
		// dance) that it short-circuits the `copyRuntime` flow entirely.
		// Same parallel structure as `executeOpenApiConfig`.
		if (desc.name === 'auth-integrations') {
			return this.executeAuthIntegrations(ctx);
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

		// OBS-7: observability combiner subsystem — injects the placeholder
		// `observability:` config block and appends a TODO comment block to
		// `app.module.ts` directing the human to wire
		// `ObservabilityModule.forRoot()` AFTER Events/Jobs/Bridge/Sync.
		// No schema, no worker, no generated/ dir (ADR-025).
		const observabilityScaffold =
			desc.name === 'observability'
				? runObservabilityScaffold(ctx.cwd, ctx.config, {
						dryRun: this.dryRun,
						json: isJsonMode(),
						forceConfig: this.forceConfig,
					})
				: null;

		// #287: auth subsystem scaffold — emits the `auth_oauth_state`
		// drizzle schema, appends the `auth:` config block, appends the
		// `AuthModule.forRoot` TODO to `app.module.ts`, and appends
		// `INTEGRATION_TOKEN_ENCRYPTION_KEY` + `AUTH_REDIRECT_URI_BASE` to `.env.config`.
		const authScaffold =
			desc.name === 'auth'
				? runAuthScaffold(ctx.cwd, ctx.config, {
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
		if (observabilityScaffold?.configBlockOutcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject observability config block. Fix the YAML and re-run.',
			);
			return 1;
		}
		if (authScaffold?.configBlockOutcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject auth config block. Fix the YAML and re-run.',
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
				...(observabilityScaffold ? { scaffold: observabilityScaffold } : {}),
				...(authScaffold ? { scaffold: authScaffold } : {}),
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
			if (observabilityScaffold?.planned?.length) {
				printInfo(
					`Observability scaffold — ${observabilityScaffold.planned.length} template targets`,
				);
				for (const p of observabilityScaffold.planned) {
					console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
				}
			}
			if (authScaffold?.planned?.length) {
				printInfo(
					`Auth scaffold — ${authScaffold.planned.length} template targets`,
				);
				for (const p of authScaffold.planned) {
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
		if (observabilityScaffold) {
			if (observabilityScaffold.ok) {
				printSuccess(
					`observability scaffold applied (config block, app.module.ts hint)`,
				);
			} else {
				printWarning(
					`observability scaffold (Hygen) failed — runtime files were written; re-run after fixing: ${observabilityScaffold.error ?? 'unknown error'}`,
				);
			}
		}
		if (authScaffold) {
			if (authScaffold.ok) {
				printSuccess(
					`auth scaffold applied (schema, config block, app.module.ts hint, .env.config key)`,
				);
			} else {
				printWarning(
					`auth scaffold (Hygen) failed — runtime files were written; re-run after fixing: ${authScaffold.error ?? 'unknown error'}`,
				);
			}
		}
		printSuccess(`${desc.name} subsystem installed with ${backend} backend.`);

		// Refresh the subsystem composition barrel (<generated>/subsystems.ts)
		// so AppModule's `...SUBSYSTEM_MODULES` picks up the new install on
		// the next boot. Soft-fail — the barrel is opt-in; consumers who haven't
		// wired it see no behavioral change.
		try {
			const generatedDir = resolveGeneratedDir(ctx);
			await regenerateSubsystemBarrel({ ctx, generatedDir });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			printWarning(`subsystem barrel regeneration failed — ${msg}`);
		}

		// OBS-7: observability is a combiner (ADR-025) — no backend selection,
		// and module order matters (composes siblings via @Optional() DI).
		// Emit a targeted hint instead of the default `forRoot({ backend })` one.
		if (desc.name === 'observability') {
			printInfo(
				'Register `ObservabilityModule.forRoot()` AFTER Events/Jobs/Bridge/Sync in app.module.ts',
			);
		} else if (desc.name === 'auth') {
			// #287: auth's forRoot shape is richer than `{ backend }` —
			// it takes encryptionKey, oauthStateStore, enableController,
			// redirectUriBase. The TODO appended to app.module.ts has the
			// full snippet; emit the next-steps block instead of the
			// generic forRoot hint.
			printInfo('auth subsystem installed.');
			printInfo('Next steps:');
			printInfo("  1. Provide an IUserContext adapter (your app's session/JWT scheme — req is typed `unknown`, narrow to your framework's Request inside the adapter).");
			printInfo('  2. Install the auth-integrations starter:  cdp subsystem install auth-integrations');
			printInfo('  3. Bind per-provider strategies into STRATEGY_REGISTRY (HubSpot, SFDC, Google, ...).');
			printInfo('  4. Configure provider client_id/client_secret in secrets/secrets.yaml.');
		} else {
			printInfo(
				`Register ${capitalize(desc.name)}Module.forRoot({ backend: '${backend}' }) in your app.module.ts`
			);
		}
		if (desc.name === 'sync') {
			printInfo(
				`Per-entity: register ExecuteSyncUseCase + your IChangeSource/ISyncSink bindings in a feature module (see SyncModule docstring).`
			);
		}
		return 0;
	}

	/**
	 * OPENAPI-4: install flow for the config-only `openapi-config`
	 * pseudo-subsystem.
	 *
	 * Nothing to copy — `src/shared/openapi/*` was already vendored by
	 * `codegen project init`. This method just invokes the
	 * `subsystem/openapi-config` Hygen action to inject the `openapi:`
	 * block into `codegen.config.yaml`, honoring the same `--force-config`
	 * semantics as jobs/events/sync/bridge.
	 */
	private async executeOpenApiConfig(ctx: Context): Promise<number> {
		const configPath = path.join(ctx.cwd, 'codegen.config.yaml');

		const outcome = planConfigBlockAction(configPath, 'openapi', this.forceConfig);
		if (outcome === 'parse-error') {
			printError(
				'codegen.config.yaml is not valid YAML: refusing to inject openapi config block. Fix the YAML and re-run.',
			);
			return 1;
		}

		if (this.dryRun) {
			if (isJsonMode()) {
				printJson({
					command: 'subsystem install',
					subsystem: 'openapi-config',
					dryRun: true,
					configBlockOutcome: outcome,
					planned: [configPath],
				});
			} else {
				printInfo(`Dry run — openapi config block would be ${outcome}`);
				console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, configPath) || configPath}`);
			}
			return 0;
		}

		const configResult = runConfigBlockAction({
			cwd: ctx.cwd,
			actionFolder: 'openapi-config',
			configPath,
			subsystem: 'openapi',
			outcome,
			json: isJsonMode(),
		});

		if (!configResult.ok) {
			printError(
				`openapi-config install failed: ${configResult.error ?? 'unknown error'}`,
			);
			return 1;
		}

		if (isJsonMode()) {
			printJson({
				command: 'subsystem install',
				subsystem: 'openapi-config',
				configBlockOutcome: outcome,
				configPath,
			});
			return 0;
		}

		printSuccess(`openapi config block ${outcome === 'skipped' ? 'already present' : 'installed'}.`);
		printInfo(
			'Install the peer deps: bun add @nestjs/swagger @anatine/zod-openapi',
		);
		printInfo(
			'Swagger UI mounts at /docs once main.ts calls SwaggerModule.setup(...) — see CONSUMER-SETUP.md §OpenAPI.',
		);
		return 0;
	}

	/**
	 * #287: install flow for the `auth-integrations` starter.
	 *
	 * Source is `examples/auth-integrations/`, NOT `runtime/subsystems/`,
	 * so this method short-circuits the `copyRuntime` flow. It vendors the
	 * adapters tree + the canonical `integration.yaml`, then invokes the
	 * `subsystem auth-integrations` Hygen action to append the
	 * `IntegrationsAuthModule` TODO to `app.module.ts`.
	 *
	 * Idempotent: pre-existing files are skipped unless `--force` is set.
	 */
	private async executeAuthIntegrations(ctx: Context): Promise<number> {
		const installed = await detectInstalledSubsystems(ctx);
		const already = installed.find((i) => i.name === 'auth-integrations');
		if (already && !this.force) {
			if (isJsonMode()) {
				printJson({
					command: 'subsystem install',
					subsystem: 'auth-integrations',
					status: 'already-installed',
					path: already.path,
					backend: already.backend,
				});
			} else {
				printInfo(
					`auth-integrations is already installed at ${already.path} (pass --force to reinstall)`,
				);
			}
			return 0;
		}

		const scaffold = runAuthIntegrationsScaffold(ctx.cwd, ctx.config, {
			dryRun: this.dryRun,
			json: isJsonMode(),
			force: this.force,
		});

		if (!scaffold.ok) {
			printError(
				`auth-integrations install failed: ${scaffold.error ?? 'unknown error'}`,
			);
			return 1;
		}

		if (isJsonMode()) {
			printJson({
				command: 'subsystem install',
				subsystem: 'auth-integrations',
				dryRun: this.dryRun,
				planned: scaffold.planned,
				written: scaffold.written ?? [],
				skipped: scaffold.skipped ?? [],
				authModuleRegistered: scaffold.authModuleRegistered ?? false,
			});
			return 0;
		}

		if (this.dryRun) {
			printInfo(
				`Dry run — auth-integrations would vendor adapters + integration.yaml + append TODO`,
			);
			for (const p of scaffold.planned) {
				console.log(
					`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`,
				);
			}
			return 0;
		}

		const writtenCount = scaffold.written?.length ?? 0;
		const skippedCount = scaffold.skipped?.length ?? 0;
		printSuccess(
			`auth-integrations starter vendored (${writtenCount} files written, ${skippedCount} skipped).`,
		);

		if (scaffold.authModuleRegistered === false) {
			printWarning(
				'AuthModule.forRoot(...) not detected in app.module.ts. Run `cdp subsystem install auth` first — IntegrationsAuthModule requires ENCRYPTION_KEY from it.',
			);
		}

		printInfo('auth-integrations starter vendored.');
		printInfo('Next steps:');
		printInfo('  1. Run `cdp entity new integration` to scaffold the codegen layer (apps/api/src/modules/integrations/integration.service) the adapters import.');
		printInfo('  2. Ensure AuthModule.forRoot(...) is registered in AppModule (run `cdp subsystem install auth` if not).');
		printInfo('  3. Wire IntegrationsAuthModule into AppModule (see TODO appended to app.module.ts).');
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
	actionFolder:
		| 'jobs-config'
		| 'events-config'
		| 'sync-config'
		| 'bridge-config'
		| 'openapi-config'
		| 'observability-config'
		| 'auth-config';
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

// ---------------------------------------------------------------------------
// OBS-7 — observability subsystem Hygen scaffold wiring
// ---------------------------------------------------------------------------

interface ObservabilityScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	configBlockOutcome?: ConfigBlockOutcome;
}

function runObservabilityScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; forceConfig: boolean },
): ObservabilityScaffoldOutcome {
	const locals = resolveObservabilityScaffoldLocals({
		cwd,
		config,
		fileExists: (p: string) => fs.existsSync(p),
	});

	// Planned files: the `observability:` config block + the TODO comment
	// block appended to `app.module.ts`. No schema, no worker, no
	// generated/ (combiner subsystem — ADR-025).
	const planned: string[] = [locals.configPath, locals.appModulePath];

	const configBlockOutcome = planConfigBlockAction(
		locals.configPath,
		'observability',
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
		action: 'observability',
		cwd,
		args: observabilityLocalsToHygenArgs(locals),
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
		actionFolder: 'observability-config',
		configPath: locals.configPath,
		subsystem: 'observability',
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
// #287 — auth subsystem Hygen scaffold wiring
// ---------------------------------------------------------------------------

interface AuthScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	configBlockOutcome?: ConfigBlockOutcome;
}

function runAuthScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; forceConfig: boolean },
): AuthScaffoldOutcome {
	const locals = resolveAuthScaffoldLocals({
		cwd,
		config,
	});

	// Files the auth templates will target (used by --dry-run output and
	// JSON reporting). Ordering matches the template set: schema first
	// (sole emitter — see backendFileFilter), then config block, then
	// app.module.ts TODO, then .env.config.
	const planned: string[] = [
		locals.schemaPath,
		locals.configPath,
		locals.appModulePath,
		locals.envConfigPath,
	];

	const configBlockOutcome = planConfigBlockAction(
		locals.configPath,
		'auth',
		opts.forceConfig,
	);

	if (configBlockOutcome === 'parse-error') {
		return { ok: false, planned, configBlockOutcome };
	}

	if (opts.dryRun) {
		return { ok: true, planned, configBlockOutcome };
	}

	// Hygen's `inject: append:` requires the target to exist. `.env.config`
	// almost certainly does NOT exist on a fresh `project init` — touch it
	// here so the inject lands. (codegen.config.yaml + app.module.ts both
	// land via `project init`, but `.env.config` is auth-subsystem-specific.)
	if (!fs.existsSync(locals.envConfigPath)) {
		fs.mkdirSync(path.dirname(locals.envConfigPath), { recursive: true });
		fs.writeFileSync(locals.envConfigPath, '', 'utf-8');
	}

	const result = invokeHygen({
		generator: 'subsystem',
		action: 'auth',
		cwd,
		args: authLocalsToHygenArgs(locals),
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
		actionFolder: 'auth-config',
		configPath: locals.configPath,
		subsystem: 'auth',
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
// #287 — auth-integrations starter vendor flow
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk root of the bundled `examples/auth-integrations`
 * starter. Mirrors `runtimeRoot()`'s dev-vs-published-tarball logic:
 * dev source has the directory at the package root; the published tarball
 * mirrors it under `dist/examples/auth-integrations/`.
 */
function authIntegrationsExamplesRoot(): string {
	const pkgRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const topLevel = path.join(pkgRoot, 'examples', 'auth-integrations');
	if (fs.existsSync(topLevel)) return topLevel;
	return path.join(pkgRoot, 'dist', 'examples', 'auth-integrations');
}

interface AuthIntegrationsCopyResult {
	written: string[];
	skipped: string[];
}

/**
 * Recursively copy `srcDir` → `destDir`. Idempotent: existing files are
 * skipped unless `force` is true. Returns the lists of copied vs skipped
 * absolute destination paths.
 *
 * Optional `transform` rewrites file contents on copy (used by the
 * auth-integrations install to swap bare `@pattern-stack/codegen/runtime/
 * subsystems/auth` imports for relative paths into the consumer's
 * vendored auth subsystem). Binary files are left as-is — `transform`
 * is only invoked for `.ts`/`.tsx` files.
 */
function copyTreeIdempotent(
	srcDir: string,
	destDir: string,
	force: boolean,
	transform?: (content: string, destPath: string) => string,
): AuthIntegrationsCopyResult {
	const written: string[] = [];
	const skipped: string[] = [];

	const walk = (src: string, dest: string): void => {
		const entries = fs.readdirSync(src, { withFileTypes: true });
		for (const entry of entries) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);
			if (entry.isDirectory()) {
				fs.mkdirSync(destPath, { recursive: true });
				walk(srcPath, destPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (fs.existsSync(destPath) && !force) {
				skipped.push(destPath);
				continue;
			}
			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			const isTextSource =
				transform && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'));
			if (isTextSource && transform) {
				const raw = fs.readFileSync(srcPath, 'utf-8');
				fs.writeFileSync(destPath, transform(raw, destPath), 'utf-8');
			} else {
				fs.copyFileSync(srcPath, destPath);
			}
			written.push(destPath);
		}
	};

	if (!fs.existsSync(srcDir)) return { written, skipped };
	fs.mkdirSync(destDir, { recursive: true });
	walk(srcDir, destDir);
	return { written, skipped };
}

/**
 * Build a transform that rewrites every
 * `from '@pattern-stack/codegen/runtime/subsystems/auth'` import in the
 * vendored auth-integrations adapters to a relative path that resolves
 * against the consumer's vendored auth subsystem at
 * `<subsystemsRoot>/auth`.
 *
 * Two reasons we can't keep the bare imports:
 *   1. The package's `exports` map exposes `./runtime/*` against
 *      `dist/runtime/*` (compiled `.d.ts` + `.js`), not against deep
 *      subdirectory paths — so `tsc --noEmit` fails to resolve the
 *      sub-path in published consumers.
 *   2. Even when types resolve, the package re-emits its own copies
 *      of the auth tokens at runtime; injecting against those tokens
 *      vs the consumer's vendored copy creates duplicate-DI-token
 *      bugs (different Symbol identities).
 *
 * Vendoring the auth subsystem means there's exactly one set of token
 * Symbols, owned by the consumer, and these adapters import from it
 * directly via relative paths.
 */
const AUTH_BARE_IMPORT_RE =
	/(['"])@pattern-stack\/codegen\/runtime\/subsystems\/auth\1/g;

function buildAuthImportRewriter(
	subsystemsRoot: string,
): (content: string, destPath: string) => string {
	const authRoot = path.join(subsystemsRoot, 'auth');
	return (content: string, destPath: string): string => {
		if (!AUTH_BARE_IMPORT_RE.test(content)) {
			AUTH_BARE_IMPORT_RE.lastIndex = 0;
			return content;
		}
		AUTH_BARE_IMPORT_RE.lastIndex = 0;
		let rel = path.relative(path.dirname(destPath), authRoot);
		if (!rel.startsWith('.')) rel = `./${rel}`;
		// Use forward slashes regardless of platform — TS module specifiers
		// are POSIX even on Windows.
		const relPosix = rel.split(path.sep).join('/');
		return content.replace(
			AUTH_BARE_IMPORT_RE,
			(_match, quote: string) => `${quote}${relPosix}${quote}`,
		);
	};
}

interface AuthIntegrationsScaffoldOutcome {
	ok: boolean;
	planned: string[];
	error?: string;
	written?: string[];
	skipped?: string[];
	authModuleRegistered?: boolean;
}

function runAuthIntegrationsScaffold(
	cwd: string,
	config: Context['config'],
	opts: { dryRun: boolean; json: boolean; force: boolean },
): AuthIntegrationsScaffoldOutcome {
	const locals = resolveAuthIntegrationsScaffoldLocals({
		cwd,
		config,
		fileExists: (p: string) => fs.existsSync(p),
		readFile: (p: string) =>
			fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null,
	});

	const examplesRoot = authIntegrationsExamplesRoot();
	if (!fs.existsSync(examplesRoot)) {
		return {
			ok: false,
			planned: [],
			error: `auth-integrations starter source missing: ${examplesRoot}`,
		};
	}

	const adaptersSrc = path.join(examplesRoot, 'runtime', 'integrations');
	// #303 fix #5: vendor next to the codegen-emitted entity module under
	// `<vendorRoot>/integrations/` (default `<backendSrc>/modules/integrations/`),
	// NOT under `<sharedRoot>/integrations/`.
	const adaptersDest = path.join(locals.vendorRoot, 'integrations');
	const integrationYamlSrc = path.join(
		examplesRoot,
		'definitions',
		'entities',
		'integration.yaml',
	);
	const integrationYamlDest = locals.definitionsPath;

	const planned: string[] = [
		adaptersDest,
		integrationYamlDest,
		locals.appModulePath,
	];

	if (opts.dryRun) {
		return {
			ok: true,
			planned,
			authModuleRegistered: locals.authModuleRegistered,
		};
	}

	// Vendor the adapters tree, rewriting the bare-package auth imports
	// to relative paths that resolve against the consumer's vendored
	// auth subsystem (see buildAuthImportRewriter).
	const subsystemsRoot = resolveSubsystemsRootFromConfig(cwd, config);
	const adapterCopy = copyTreeIdempotent(
		adaptersSrc,
		adaptersDest,
		opts.force,
		buildAuthImportRewriter(subsystemsRoot),
	);

	// Vendor the integration.yaml.
	let yamlWritten = false;
	let yamlSkipped = false;
	try {
		if (fs.existsSync(integrationYamlDest) && !opts.force) {
			yamlSkipped = true;
		} else if (fs.existsSync(integrationYamlSrc)) {
			fs.mkdirSync(path.dirname(integrationYamlDest), { recursive: true });
			fs.copyFileSync(integrationYamlSrc, integrationYamlDest);
			yamlWritten = true;
		}
	} catch (err) {
		return {
			ok: false,
			planned,
			error: `failed to vendor integration.yaml: ${
				err instanceof Error ? err.message : String(err)
			}`,
			authModuleRegistered: locals.authModuleRegistered,
		};
	}

	// Inject the app.module.ts TODO via Hygen.
	const result = invokeHygen({
		generator: 'subsystem',
		action: 'auth-integrations',
		cwd,
		args: authIntegrationsLocalsToHygenArgs(locals),
		inherit: !opts.json,
	});

	if (!result.ok) {
		return {
			ok: false,
			planned,
			error: result.stderr?.trim() || 'hygen exited non-zero',
			written: adapterCopy.written.concat(yamlWritten ? [integrationYamlDest] : []),
			skipped: adapterCopy.skipped.concat(yamlSkipped ? [integrationYamlDest] : []),
			authModuleRegistered: locals.authModuleRegistered,
		};
	}

	return {
		ok: true,
		planned,
		written: adapterCopy.written.concat(yamlWritten ? [integrationYamlDest] : []),
		skipped: adapterCopy.skipped.concat(yamlSkipped ? [integrationYamlDest] : []),
		authModuleRegistered: locals.authModuleRegistered,
	};
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

		// #2: report the full present set so half-installed subsystems (a
		// directory carrying protocol/token stubs but no `<name>.module.ts`,
		// e.g. an events install that vendored bridge stubs) surface as
		// `incomplete`, not `installed`.
		const states = await detectSubsystemStates(ctx);
		const byName = new Map<string, InstalledSubsystem>();
		for (const i of states) byName.set(i.name, i);

		const rows = SUBSYSTEMS.map((s) => {
			const inst = byName.get(s.name);
			return {
				name: s.name,
				status: inst ? inst.status : 'available',
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
// SubsystemRemoveCommand
// ---------------------------------------------------------------------------

/**
 * Subsystem removal.
 *
 * Scope (intentionally narrow): deletes the vendored
 * `<subsystems-root>/<name>/` directory and regenerates
 * `<generated>/subsystems.ts` so the removed subsystem drops out of the
 * `SUBSYSTEM_MODULES` barrel.
 *
 * Out of scope (would require parsing/rewriting consumer source):
 *   - The subsystem's `<name>:` block in `codegen.config.yaml`.
 *   - The `forRoot()` import + registration line in `app.module.ts`.
 *   - The shared runtime dependencies (types/drizzle.ts, constants/tokens.ts)
 *     that other subsystems may still need.
 *
 * The CLI prints a next-step pointing the user at the manual removal of
 * those — explicit + auditable beats a silent rewrite of YAML/TS.
 *
 * The `openapi-config` pseudo-subsystem has no runtime dir to delete (its
 * "install" is purely a YAML block injection); we refuse removal there and
 * point the user at the config file.
 *
 * The `auth-integrations` starter vendors into `<modules>/integrations/`
 * outside the subsystems root and is intentionally NOT auto-removable here —
 * removing it cleanly means also pulling the codegen-emitted `integration`
 * entity module, which is the entity layer's lifecycle, not ours.
 */
export class SubsystemRemoveCommand extends Command {
	static paths = [['subsystem', 'remove']];
	static usage = Command.Usage({
		description: 'Remove a vendored subsystem',
		examples: [
			['Remove the jobs subsystem', 'codegen subsystem remove jobs'],
			[
				'Skip the git-safety check (uncommitted edits will be lost)',
				'codegen subsystem remove jobs --force',
			],
			['Non-interactive parity with install', 'codegen subsystem remove jobs --yes'],
		],
	});

	name = Option.String({ required: true });
	// #7: parity with `subsystem install` so a non-interactive caller can pass
	// the same flag set across install/remove. Accepted but currently a no-op
	// (remove has no interactive prompt yet); kept for forward-compatibility.
	yes = Option.Boolean('--yes,-y', false);
	force = Option.Boolean('--force', false);
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
				`Unknown subsystem '${this.name}'. Known: ${SUBSYSTEMS.map((s) => s.name).join(', ')}`,
			);
			return 2;
		}

		// Pseudo-subsystems with no vendored runtime dir aren't removable by
		// this command. Surface the right next-step instead of a silent no-op.
		if (desc.name === 'openapi-config') {
			printError(
				"openapi-config has no vendored runtime to remove — it's a config-only pseudo-subsystem.",
			);
			printInfo(
				'To uninstall: delete the `openapi:` block from codegen.config.yaml and uninstall the @nestjs/swagger / @anatine/zod-openapi peer deps.',
			);
			return 1;
		}
		if (desc.name === 'auth-integrations') {
			printError(
				'auth-integrations is vendored under <modules>/integrations/ alongside the codegen-emitted entity layer — not auto-removable here.',
			);
			printInfo(
				'To uninstall: remove the integrations/ directory and the IntegrationsAuthModule registration from app.module.ts by hand.',
			);
			return 1;
		}

		// Use the module-file-keyed detection from #4/#2 — we only remove
		// fully-installed subsystems. (An `incomplete` stub dir, e.g. the
		// bridge/ shells an events install drops, is the events install's to
		// clean up — removing the dir directly would break the events drizzle
		// backend's imports.)
		const installed = await detectInstalledSubsystems(ctx);
		const target = installed.find((i) => i.name === desc.name);
		if (!target) {
			if (isJsonMode()) {
				printJson({
					command: 'subsystem remove',
					subsystem: desc.name,
					status: 'not-installed',
				});
			} else {
				printError(`${desc.name} is not installed — nothing to remove.`);
			}
			return 1;
		}

		const subsystemDir = target.path;
		if (!fs.existsSync(subsystemDir)) {
			// Detection said yes, fs says no — inconsistency. Bail.
			printError(
				`Detected install at ${subsystemDir} but the directory is gone — refusing to act.`,
			);
			return 1;
		}

		// Git safety — mirrors `SubsystemInstallCommand`. Uncommitted edits
		// inside the subsystem dir would be silently destroyed otherwise.
		if (!this.force) {
			const rel = path.relative(ctx.cwd, subsystemDir) || subsystemDir;
			const gitCheck = checkGitSafety([rel], ctx.cwd);
			if (gitCheck.inRepo && !gitCheck.clean) {
				printWarning(
					`Uncommitted changes under ${subsystemDir}. Pass --force to delete anyway.`,
				);
				if (!isJsonMode()) return 1;
			}
		}

		// Delete the vendored directory.
		try {
			fs.rmSync(subsystemDir, { recursive: true, force: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			printError(`Failed to remove ${subsystemDir}: ${message}`);
			return 1;
		}

		// Regenerate the barrel — detection now no longer finds this subsystem,
		// so `SUBSYSTEM_MODULES` won't reference it. Soft-fail (the regen is
		// opt-in like in install) so a missing generated dir doesn't fail the
		// removal itself.
		let barrelRegenerated = false;
		try {
			const generatedDir = resolveGeneratedDir(ctx);
			await regenerateSubsystemBarrel({ ctx, generatedDir });
			barrelRegenerated = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			printWarning(`subsystem barrel regeneration failed — ${msg}`);
		}

		if (isJsonMode()) {
			printJson({
				command: 'subsystem remove',
				subsystem: desc.name,
				status: 'removed',
				path: subsystemDir,
				barrelRegenerated,
			});
			return 0;
		}

		printSuccess(
			`${desc.name} subsystem removed (${path.relative(ctx.cwd, subsystemDir) || subsystemDir}).`,
		);
		if (barrelRegenerated) {
			printInfo('Regenerated <generated>/subsystems.ts barrel.');
		}
		printInfo('Next steps (manual):');
		printInfo(
			`  1. Remove the \`${capitalize(desc.name)}Module.forRoot(...)\` registration from app.module.ts.`,
		);
		printInfo(
			`  2. Remove the \`${desc.name}:\` block from codegen.config.yaml (if you no longer want it).`,
		);
		return 0;
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
