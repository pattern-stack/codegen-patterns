/**
 * Skills noun — install / list consumer-facing Claude Code skills.
 *
 * `@pattern-stack/codegen` ships a curated set of consumer skills under the
 * package's `consumer-skills/` directory. These teach a coding agent how to
 * USE the generated code in its own project (author entities, wire subsystems,
 * write job handlers, etc.) — distinct from the repo's own dev-facing skills.
 *
 * `codegen skills install` vendor-copies them into the consumer's
 * `.claude/skills/`. The copy is drift-aware: a skill file the consumer has
 * locally edited is left untouched unless `--force` is passed. `codegen
 * update` re-runs the same install to refresh skills after a package bump.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import { loadContext, type Context } from '../shared/context.js';
import { checkGitSafety } from '../shared/git-safety.js';
import {
	copyTreeWithReport,
	type TreeCopyReport,
} from '../shared/tree-copier.js';

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

/**
 * Absolute path to the bundled `consumer-skills/` source tree. Mirrors
 * `runtimeRoot()` (init-scaffold / subsystem): dev source has it at the
 * package root; the published npm tarball ships it at the root too (via the
 * `files` array). The `dist/` fallback is defensive.
 */
export function consumerSkillsRoot(): string {
	const pkgRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const topLevel = path.join(pkgRoot, 'consumer-skills');
	if (fs.existsSync(topLevel)) return topLevel;
	return path.join(pkgRoot, 'dist', 'consumer-skills');
}

/** Target `.claude/skills/` directory inside the consumer project. */
export function skillsTargetDir(cwd: string): string {
	return path.join(cwd, '.claude', 'skills');
}

/** List the available consumer skill names (top-level dirs in the source). */
export function availableSkills(): string[] {
	const root = consumerSkillsRoot();
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

// ---------------------------------------------------------------------------
// shared install routine (reused by `project init` + `codegen update`)
// ---------------------------------------------------------------------------

export interface SkillsInstallOptions {
	cwd: string;
	dryRun?: boolean;
}

export interface SkillsInstallResult {
	ok: boolean;
	sourceRoot: string;
	targetDir: string;
	report?: TreeCopyReport;
	error?: string;
}

/**
 * Vendor `consumer-skills/*` → `<cwd>/.claude/skills/`. Pure-ish: writes only
 * when `dryRun` is false. Returns a structured result so callers (the command,
 * `project init`, `codegen update`) can render their own output.
 */
export function runSkillsInstall(opts: SkillsInstallOptions): SkillsInstallResult {
	const sourceRoot = consumerSkillsRoot();
	const targetDir = skillsTargetDir(opts.cwd);

	if (!fs.existsSync(sourceRoot)) {
		return {
			ok: false,
			sourceRoot,
			targetDir,
			error: `consumer skills source missing: ${sourceRoot}`,
		};
	}

	const report = copyTreeWithReport({
		srcDir: sourceRoot,
		destDir: targetDir,
		dryRun: Boolean(opts.dryRun),
	});

	return { ok: true, sourceRoot, targetDir, report };
}

// ---------------------------------------------------------------------------
// summary + hints
// ---------------------------------------------------------------------------

async function summary(ctx: Context): Promise<PaneOutput> {
	const skills = availableSkills();
	const targetDir = skillsTargetDir(ctx.cwd);
	const installedDirs = fs.existsSync(targetDir)
		? new Set(
				fs
					.readdirSync(targetDir, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name),
			)
		: new Set<string>();

	const body: string[] = [];
	if (skills.length === 0) {
		body.push(theme.muted('No consumer skills bundled with this package build.'));
		return { title: 'skills', body, footer: '' };
	}

	body.push(theme.muted('Consumer skills:'));
	for (const name of skills) {
		const present = installedDirs.has(name);
		const icon = present ? theme.success(icons.check) : theme.muted(icons.dash);
		const status = present ? '' : theme.muted('not installed');
		body.push(`  ${icon} ${name.padEnd(12)} ${status}`);
	}

	const installedCount = skills.filter((s) => installedDirs.has(s)).length;
	return {
		title: 'skills',
		body,
		footer: `${installedCount} of ${skills.length} skills installed → ${path.relative(ctx.cwd, targetDir) || targetDir}`,
	};
}

async function hints(ctx: Context): Promise<Hint[]> {
	const skills = availableSkills();
	const targetDir = skillsTargetDir(ctx.cwd);
	const allPresent =
		skills.length > 0 &&
		fs.existsSync(targetDir) &&
		skills.every((s) => fs.existsSync(path.join(targetDir, s)));

	if (allPresent) {
		return [
			{ command: 'codegen update', description: 'Re-sync skills + runtime after a package bump' },
		];
	}
	return [
		{ command: 'codegen skills install', description: 'Vendor consumer skills into .claude/skills' },
	];
}

// ---------------------------------------------------------------------------
// shared report renderer
// ---------------------------------------------------------------------------

export function renderTreeReport(report: TreeCopyReport): void {
	const show = (entry: { relPath: string; action: string }): void => {
		const icon = theme.success(icons.check);
		console.log(`  ${icon} ${theme.muted(entry.action.padEnd(10))} ${entry.relPath}`);
	};
	// Surface writes; collapse the unchanged majority into a count.
	for (const e of [...report.created, ...report.updated]) show(e);
	if (report.unchanged.length > 0) {
		console.log(
			`  ${theme.muted(icons.dash)} ${theme.muted('unchanged'.padEnd(10))} ${theme.muted(
				`${report.unchanged.length} file${report.unchanged.length === 1 ? '' : 's'} already current`,
			)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// SkillsInstallCommand
// ---------------------------------------------------------------------------

export class SkillsInstallCommand extends Command {
	static paths = [['skills', 'install']];
	static usage = Command.Usage({
		description: 'Vendor consumer-facing skills into the project .claude/skills',
		examples: [
			['Install all consumer skills', 'codegen skills install'],
			['Preview without writing', 'codegen skills install --dry-run'],
			['Overwrite locally-edited skill files', 'codegen skills install --force'],
		],
	});

	force = Option.Boolean('--force', false);
	dryRun = Option.Boolean('--dry-run', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({ cwd: this.cwd, json: this.json, skipDetection: true });

		// Classify first (no writes) so we can git-gate the overwrite set.
		const preview = runSkillsInstall({ cwd: ctx.cwd, dryRun: true });
		if (!preview.ok) {
			if (isJsonMode()) {
				printJson({ command: 'skills install', status: 'error', error: preview.error });
			} else {
				printError(preview.error ?? 'skills install failed');
			}
			return 1;
		}

		// Git safety: refuse to overwrite skill files with uncommitted edits
		// unless --force. Created files don't exist yet, so only the `updated`
		// set can be dirty. Mirrors `subsystem install`.
		if (!this.dryRun && !this.force) {
			const updatedPaths = preview.report!.updated.map((e) => e.dest);
			const gate = checkGitSafety(updatedPaths, ctx.cwd);
			if (gate.inRepo && !gate.clean) {
				printWarning(
					`Uncommitted changes in ${gate.dirty.length} skill file(s). Commit them or pass --force to overwrite.`,
				);
				if (!isJsonMode()) return 1;
			}
		}

		const result = runSkillsInstall({ cwd: ctx.cwd, dryRun: this.dryRun });
		const report = result.report!;

		if (isJsonMode()) {
			printJson({
				command: 'skills install',
				dryRun: this.dryRun,
				target: result.targetDir,
				files: {
					created: report.created.map((e) => e.relPath),
					updated: report.updated.map((e) => e.relPath),
					unchanged: report.unchanged.map((e) => e.relPath),
				},
			});
			return 0;
		}

		printInfo(`target = ${path.relative(ctx.cwd, result.targetDir) || result.targetDir}`);
		console.log('');
		renderTreeReport(report);
		console.log('');

		if (this.dryRun) {
			printWarning('dry-run — no files written');
			return 0;
		}

		printSuccess(
			`skills installed (${report.created.length} new, ${report.updated.length} updated, ${report.unchanged.length} unchanged)`,
		);
		printInfo('Skills are auto-discovered by Claude Code from .claude/skills/.');
		return 0;
	}
}

// ---------------------------------------------------------------------------
// SkillsListCommand
// ---------------------------------------------------------------------------

export class SkillsListCommand extends Command {
	static paths = [['skills', 'list']];
	static usage = Command.Usage({
		description: 'List available consumer skills and their installed status',
	});

	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({ cwd: this.cwd, json: this.json, skipDetection: true });

		const skills = availableSkills();
		const targetDir = skillsTargetDir(ctx.cwd);
		const rows = skills.map((name) => {
			const dir = path.join(targetDir, name);
			return { name, status: fs.existsSync(dir) ? 'installed' : 'available' };
		});

		if (isJsonMode()) {
			printJson({ command: 'skills list', target: targetDir, skills: rows });
			return 0;
		}

		if (rows.length === 0) {
			printWarning('No consumer skills bundled with this package build.');
			return 0;
		}

		const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
		console.log(theme.muted(`${pad('NAME', 14)}STATUS`));
		for (const r of rows) console.log(`${pad(r.name, 14)}${r.status}`);
		return 0;
	}
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const skillsNoun: NounModule = {
	name: 'skills',
	commandClasses: [SkillsInstallCommand, SkillsListCommand] as CommandClass[],
	summary,
	hints,
};

export default skillsNoun;
