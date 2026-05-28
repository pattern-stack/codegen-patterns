/**
 * `codegen update` (aliased; canonical path `codegen project update`) —
 * re-sync the package-owned files vendored into a consumer project after a
 * `@pattern-stack/codegen` version bump.
 *
 * The package vendors three kinds of file into the consumer tree:
 *   1. Shared runtime closure — base classes, types, constants, the events
 *      protocol, the Zod pipe, EAV helpers, the OpenAPI registry. The
 *      canonical list is `VENDORED_RUNTIME_FILES` (init-scaffold).
 *   2. Installed subsystems' runtime — `runtime/subsystems/<name>/` copied to
 *      `<subsystems-root>/<name>/` at `subsystem install`.
 *   3. Consumer skills — `.claude/skills/` (vendored by `skills install`).
 *
 * After `bun add @pattern-stack/codegen@latest` all three are stale. `update`
 * re-syncs them to the installed package version. It NEVER touches files the
 * consumer owns: `codegen.config.yaml`, `app.module.ts`, `main.ts`,
 * `database.module.ts`, entity YAML, or the generated barrels.
 *
 * Overwrite model: divergent package-owned files are overwritten (the
 * cross-version delta IS a content diff). The safety net is the git-clean
 * gate (refuse when the targets have uncommitted changes unless `--force`)
 * plus `--dry-run`.
 *
 * Known v1 limitation: the tenancy-gated Drizzle schema files
 * (`domain-events.schema.ts`, etc.) are Hygen-owned and skipped by the
 * subsystem copy filter, so `update` does NOT refresh them. If a schema SHAPE
 * changed across versions, re-run `codegen subsystem install <name> --force
 * --force-config` for that subsystem.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';

import { loadContext, type Context } from '../shared/context.js';
import { checkGitSafety } from '../shared/git-safety.js';
import {
	VENDORED_RUNTIME_FILES,
	loadRuntimeFile,
	runtimeRoot,
} from '../shared/init-scaffold.js';
import { copyRuntime } from '../shared/runtime-copier.js';
import {
	detectInstalledSubsystems,
	type InstalledSubsystem,
} from '../shared/subsystem-detect.js';
import { backendFileFilter, subsystemSource } from './subsystem.js';
import { runSkillsInstall } from './skills.js';

import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';

// Subsystems whose install does NOT lay down a `runtime/subsystems/<name>/`
// tree at `<subsystems-root>/<name>/`, so the runtime re-sync skips them.
// `openapi-config` is config-only (registry vendored via VENDORED_RUNTIME_FILES);
// `auth-integrations` is vendored from examples/ into a modules/ dir.
const NON_RUNTIME_SUBSYSTEMS = new Set(['openapi-config', 'auth-integrations']);

type ChangeAction = 'created' | 'updated' | 'unchanged';

interface FileChange {
	path: string;
	action: ChangeAction;
}

// ---------------------------------------------------------------------------
// 1. shared vendored runtime closure
// ---------------------------------------------------------------------------

/**
 * Classify (and optionally write) every file in VENDORED_RUNTIME_FILES against
 * the consumer tree. Returns the per-file change list (relative paths).
 */
function syncVendoredRuntime(cwd: string, write: boolean): FileChange[] {
	const changes: FileChange[] = [];
	for (const v of VENDORED_RUNTIME_FILES) {
		const dest = path.join(cwd, v.target);
		const content = loadRuntimeFile(v.runtime);
		const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;

		let action: ChangeAction;
		if (existing === null) action = 'created';
		else if (existing === content) action = 'unchanged';
		else action = 'updated';

		if (write && action !== 'unchanged') {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, content, 'utf-8');
		}
		changes.push({ path: v.target, action });
	}
	return changes;
}

// ---------------------------------------------------------------------------
// 2. installed subsystems' runtime
// ---------------------------------------------------------------------------

interface SubsystemSyncResult {
	name: string;
	changes: FileChange[];
	skippedReason?: string;
}

async function syncSubsystemRuntime(
	cwd: string,
	inst: InstalledSubsystem,
	write: boolean,
): Promise<SubsystemSyncResult> {
	if (NON_RUNTIME_SUBSYSTEMS.has(inst.name)) {
		return { name: inst.name, changes: [], skippedReason: 'config-only / vendored elsewhere' };
	}

	const source = subsystemSource(inst.name);
	if (!fs.existsSync(source)) {
		return { name: inst.name, changes: [], skippedReason: 'no runtime source in package' };
	}

	// Match `subsystem install` dep placement: deps land at
	// resolve(<subsystems-root>, '..') i.e. the parent of the subsystems dir.
	const subsystemsRoot = path.dirname(inst.path);
	const result = await copyRuntime({
		sourceDir: source,
		targetDir: inst.path,
		filter: backendFileFilter(inst.backend, inst.name),
		resolveDeps: true,
		runtimeRoot: runtimeRoot(),
		depsTargetRoot: path.resolve(subsystemsRoot, '..'),
		dryRun: !write,
		// Refresh files already vendored for this subsystem; never install new
		// ones (that's `subsystem install`). copyRuntime classifies accurately
		// in dry-run too, so this report is correct either way.
		onlyExisting: true,
	});

	const changes: FileChange[] = [];
	for (const p of result.written) changes.push({ path: rel(cwd, p), action: 'created' });
	for (const p of result.updated) changes.push({ path: rel(cwd, p), action: 'updated' });
	for (const p of result.unchanged) changes.push({ path: rel(cwd, p), action: 'unchanged' });
	return { name: inst.name, changes };
}

function rel(cwd: string, abs: string): string {
	return path.relative(cwd, abs) || abs;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export class ProjectUpdateCommand extends Command {
	static paths = [['project', 'update']];
	static usage = Command.Usage({
		description:
			'Re-sync vendored runtime, installed subsystems, and consumer skills to the installed package version',
		examples: [
			['Re-sync everything after a package bump', 'codegen update'],
			['Preview without writing', 'codegen update --dry-run'],
			['Overwrite even with uncommitted changes', 'codegen update --force'],
			['Skip the skills re-sync', 'codegen update --skip-skills'],
		],
	});

	dryRun = Option.Boolean('--dry-run', false);
	force = Option.Boolean('--force', false);
	skipSkills = Option.Boolean('--skip-skills', false);
	skipSubsystems = Option.Boolean('--skip-subsystems', false);
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

		if (!ctx.isInitialized) {
			if (isJsonMode()) {
				printJson({ command: 'project update', status: 'not-initialized' });
			} else {
				printWarning('project is not initialized — run `codegen init` first');
			}
			return 1;
		}

		const installed = this.skipSubsystems ? [] : await detectInstalledSubsystems(ctx);

		// --- Git gate (classify dry first; never mix update writes with WIP) ---
		if (!this.dryRun && !this.force) {
			const vendoredDry = syncVendoredRuntime(ctx.cwd, false);
			const vendoredDirtyCandidates = vendoredDry
				.filter((c) => c.action === 'updated')
				.map((c) => path.join(ctx.cwd, c.path));
			const skillDirtyCandidates = this.skipSkills
				? []
				: (runSkillsInstall({ cwd: ctx.cwd, dryRun: true }).report?.updated.map((e) => e.dest) ??
					[]);
			const subsystemDirs = installed
				.filter((i) => !NON_RUNTIME_SUBSYSTEMS.has(i.name))
				.map((i) => i.path);

			const gate = checkGitSafety(
				[...vendoredDirtyCandidates, ...skillDirtyCandidates, ...subsystemDirs],
				ctx.cwd,
			);
			if (gate.inRepo && !gate.clean) {
				if (isJsonMode()) {
					printJson({
						command: 'project update',
						status: 'dirty-tree',
						dirty: gate.dirty,
					});
				} else {
					printWarning(
						`Uncommitted changes in ${gate.dirty.length} file(s) that update would overwrite. Commit them or pass --force.`,
					);
					for (const d of gate.dirty.slice(0, 10)) {
						console.log(`  ${theme.muted(icons.dash)} ${d}`);
					}
				}
				return 1;
			}
		}

		const write = !this.dryRun;

		// --- 1. shared vendored runtime ---
		const vendored = syncVendoredRuntime(ctx.cwd, write);

		// --- 2. installed subsystems ---
		const subsystemResults: SubsystemSyncResult[] = [];
		for (const inst of installed) {
			subsystemResults.push(await syncSubsystemRuntime(ctx.cwd, inst, write));
		}

		// --- 3. consumer skills ---
		const skills = this.skipSkills
			? null
			: runSkillsInstall({ cwd: ctx.cwd, dryRun: this.dryRun });

		// --- Report ---
		const tally = (changes: FileChange[]) => ({
			created: changes.filter((c) => c.action === 'created').length,
			updated: changes.filter((c) => c.action === 'updated').length,
			unchanged: changes.filter((c) => c.action === 'unchanged').length,
		});

		if (isJsonMode()) {
			printJson({
				command: 'project update',
				dryRun: this.dryRun,
				runtime: vendored,
				subsystems: subsystemResults.map((s) => ({
					name: s.name,
					skipped: s.skippedReason ?? null,
					...tally(s.changes),
				})),
				skills:
					skills && skills.report
						? {
								created: skills.report.created.length,
								updated: skills.report.updated.length,
								unchanged: skills.report.unchanged.length,
							}
						: null,
			});
			return 0;
		}

		printInfo(`Updating ${ctx.cwd} to the installed @pattern-stack/codegen version`);
		console.log('');

		// Runtime
		renderSection('shared runtime', vendored);

		// Subsystems
		for (const s of subsystemResults) {
			if (s.skippedReason) {
				console.log(
					`  ${theme.muted(icons.dash)} ${theme.muted(`subsystem ${s.name} skipped (${s.skippedReason})`)}`,
				);
				continue;
			}
			renderSection(`subsystem ${s.name}`, s.changes);
		}

		// Skills
		if (skills?.report) {
			renderSection(
				'skills',
				[
					...skills.report.created.map((e) => ({ path: e.relPath, action: 'created' as const })),
					...skills.report.updated.map((e) => ({ path: e.relPath, action: 'updated' as const })),
					...skills.report.unchanged.map((e) => ({
						path: e.relPath,
						action: 'unchanged' as const,
					})),
				],
			);
		} else if (this.skipSkills) {
			console.log(`  ${theme.muted(icons.dash)} ${theme.muted('skills skipped (--skip-skills)')}`);
		}

		console.log('');
		if (this.dryRun) {
			printWarning('dry-run — no files written');
			return 0;
		}
		printSuccess('update complete');
		printInfo(
			'Schema shape changes are NOT re-synced — if a subsystem schema changed across versions, run `codegen subsystem install <name> --force --force-config`.',
		);
		return 0;
	}
}

function renderSection(label: string, changes: FileChange[]): void {
	const created = changes.filter((c) => c.action === 'created');
	const updated = changes.filter((c) => c.action === 'updated');
	const unchanged = changes.filter((c) => c.action === 'unchanged');

	if (created.length === 0 && updated.length === 0 && unchanged.length === 0) return;

	const head =
		created.length + updated.length === 0
			? theme.muted(`${label} — up to date (${unchanged.length})`)
			: `${theme.system(label)} — ${created.length} new, ${updated.length} updated`;
	console.log(`  ${head}`);
	for (const c of [...created, ...updated]) {
		console.log(`    ${theme.success(icons.check)} ${theme.muted(c.action.padEnd(8))} ${c.path}`);
	}
}
