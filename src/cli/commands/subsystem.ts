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

import { loadContext, type Context } from '../shared/context.js';
import { checkGitSafety } from '../shared/git-safety.js';
import { copyRuntime } from '../shared/runtime-copier.js';
import {
	SUBSYSTEMS,
	detectInstalledSubsystems,
	type SubsystemDescriptor,
	type SubsystemName,
	type SubsystemBackend,
	type InstalledSubsystem,
} from '../shared/subsystem-detect.js';

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

const DEFAULT_SUBSYSTEMS_REL = 'shared/subsystems';

function runtimeRoot(): string {
	// src/cli/commands/subsystem.ts → ../../../runtime
	return path.resolve(import.meta.dirname, '..', '..', '..', 'runtime');
}

function subsystemSource(name: SubsystemName): string {
	return path.join(runtimeRoot(), 'subsystems', name);
}

function resolveTargetRoot(ctx: Context, overrideTarget?: string): string {
	if (overrideTarget) return path.resolve(ctx.cwd, overrideTarget);
	const configured = ctx.config?.paths?.subsystems as string | undefined;
	if (configured) return path.resolve(ctx.cwd, configured);
	return path.resolve(ctx.cwd, DEFAULT_SUBSYSTEMS_REL);
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

function backendFileFilter(backend: SubsystemBackend): (file: string) => boolean {
	return (file: string) => {
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
		],
	});

	name = Option.String({ required: true });
	backend = Option.String('--backend', { required: false });
	target = Option.String('--target', { required: false });
	force = Option.Boolean('--force', false);
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

		const targetRoot = resolveTargetRoot(ctx, this.target);
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
			filter: backendFileFilter(backend),
			resolveDeps: true,
			runtimeRoot: runtimeRoot(),
			depsTargetRoot: path.resolve(targetRoot, '..'),
			dryRun: this.dryRun,
		});

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
			});
			return 0;
		}

		if (this.dryRun) {
			printInfo(`Dry run — ${result.planned.length} files would be written`);
			for (const p of result.planned) {
				console.log(`  ${theme.muted(icons.arrow)} ${path.relative(ctx.cwd, p) || p}`);
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
		printSuccess(`${desc.name} subsystem installed with ${backend} backend.`);
		printInfo(
			`Register ${capitalize(desc.name)}Module.forRoot({ backend: '${backend}' }) in your app.module.ts`
		);
		return 0;
	}
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
