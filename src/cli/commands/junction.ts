/**
 * Junction noun — codegen junction new / junction list
 *
 * Generates code for first-class junction definitions (explicit M:N tables
 * with role + temporal + sourcing metadata). Mirrors the relationship noun
 * but delegates to the junction template set.
 *
 * Three divergences from the relationship noun (per spec section "CLI noun"):
 *   1. Loader: loadJunctionFromYaml (not loadRelationshipFromYaml)
 *   2. Filter: detectYamlType() === 'junction' (not 'relationship')
 *   3. Hygen:  invokeJunctionNew() calling generator: 'junction'
 *   4. Dir:    junctions/ (not relationships/)
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import { loadJunctionFromYaml, detectYamlType } from '../../utils/yaml-loader.js';

import { loadContext, type Context } from '../shared/context.js';
import { invokeJunctionNew } from '../shared/hygen.js';
import { checkGitSafety } from '../shared/git-safety.js';
import {
	regenerateBarrels,
	resolveGeneratedDir,
	resolveArchitecture,
	listJunctionYamls,
} from '../shared/barrel-generator.js';

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

interface JunctionSummaryRow {
	name: string;
	left: string;
	right: string;
	hasRole: boolean;
	temporal: boolean;
	sourced: boolean;
	file: string;
}

function summarizeJunctionFile(filePath: string): JunctionSummaryRow | null {
	const result = loadJunctionFromYaml(filePath);
	if (!result.success) return null;
	const def = result.definition;
	const name = def.name ?? `${def.between[0]}_${def.between[1]}`;
	const roleChoices = def.fields?.role?.choices;
	const hasRole = Array.isArray(roleChoices) && roleChoices.length > 0;
	return {
		name,
		left: def.between[0],
		right: def.between[1],
		hasRole,
		temporal: def.temporal ?? true,
		sourced: def.sourced ?? true,
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
	const junctionDir = path.resolve(ctx.cwd, 'junctions');
	const files = listJunctionYamls(junctionDir);

	if (files.length === 0) {
		return {
			title: 'junctions',
			body: [
				'No junction definitions found.',
				'',
				`Create one at ${theme.system('junctions/<name>.yaml')} to get started.`,
			],
		};
	}

	const rows = files
		.map(summarizeJunctionFile)
		.filter((r): r is JunctionSummaryRow => r !== null);

	const nameCol = Math.max(4, ...rows.map((r) => r.name.length));
	const pairingCol = Math.max(7, ...rows.map((r) => `${r.left} × ${r.right}`.length));

	const body = rows.map((r) => {
		const pairing = `${r.left} × ${r.right}`;
		const flags = [
			r.hasRole ? 'role' : '',
			r.temporal ? 'temporal' : '',
			r.sourced ? 'sourced' : '',
		]
			.filter(Boolean)
			.join(', ');
		return `${theme.system(icons.bullet)} ${padRight(r.name, nameCol)}  ${theme.muted(
			padRight(pairing, pairingCol)
		)}  ${theme.muted(flags)}`;
	});

	return {
		title: 'junctions',
		body,
		footer: `${rows.length} junctions`,
	};
}

async function hints(_ctx: Context): Promise<Hint[]> {
	return [
		{ command: 'codegen junction new <file>', description: 'Generate one junction' },
		{ command: 'codegen junction new --all', description: 'Generate all junctions' },
		{ command: 'codegen junction list', description: 'List junction definitions' },
	];
}

// ---------------------------------------------------------------------------
// JunctionNewCommand
// ---------------------------------------------------------------------------

export class JunctionNewCommand extends Command {
	static paths = [['junction', 'new']];
	static usage = Command.Usage({
		description: 'Generate code for one or more junctions from YAML',
		examples: [
			['Generate a single junction', 'codegen junction new junctions/opportunity_contact.yaml'],
			['Generate all junctions', 'codegen junction new --all'],
			['Preview without writing', 'codegen junction new junctions/opportunity_contact.yaml --dry-run'],
		],
	});

	yaml = Option.String({ required: false });
	all = Option.Boolean('--all', false);
	dryRun = Option.Boolean('--dry-run', false);
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

		if (this.all && this.yaml) {
			printError('Pass either a YAML path or --all, not both.');
			return 2;
		}

		let targets: string[] = [];
		if (this.all) {
			const dir = path.resolve(ctx.cwd, 'junctions');
			targets = listJunctionYamls(dir);
			if (targets.length === 0) {
				printError(`No junction YAML files found in ${dir}`);
				return 1;
			}
		} else if (this.yaml) {
			targets = [path.resolve(ctx.cwd, this.yaml)];
		} else {
			printError('Missing YAML path. Pass a file or --all.');
			return 2;
		}

		// Pre-flight: validate each YAML.
		const validated: Array<{ file: string; name: string }> = [];
		const invalid: Array<{ file: string; message: string }> = [];
		for (const file of targets) {
			const result = loadJunctionFromYaml(file);
			if (result.success) {
				const def = result.definition;
				const name = def.name ?? `${def.between[0]}_${def.between[1]}`;
				validated.push({ file, name });
			} else {
				invalid.push({ file, message: result.error });
			}
		}

		if (invalid.length > 0) {
			for (const i of invalid) {
				printError(`${path.basename(i.file)} — ${i.message}`);
			}
			if (!isJsonMode()) return 1;
		}

		// Git safety
		if (!this.force) {
			const gitCheck = checkGitSafety(['src'], ctx.cwd);
			if (gitCheck.inRepo && !gitCheck.clean) {
				printWarning(
					`Uncommitted changes in ${gitCheck.dirty.length} files under src/. Pass --force to overwrite.`
				);
				if (!isJsonMode()) return 1;
			}
		}

		if (this.dryRun) {
			if (isJsonMode()) {
				printJson({
					command: 'junction new',
					dryRun: true,
					junctions: validated.map((v) => ({ name: v.name, file: v.file })),
					totals: { planned: validated.length, invalid: invalid.length },
				});
			} else {
				printInfo(`Dry run — ${validated.length} junctions would be generated:`);
				for (const v of validated) {
					console.log(`  ${theme.muted(icons.arrow)} ${v.name}  ${theme.muted(v.file)}`);
				}
			}
			return invalid.length > 0 ? 1 : 0;
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
			const res = invokeJunctionNew(v.file, ctx.cwd);
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
			}
		}

		// Regenerate barrels so new junction modules land in GENERATED_MODULES
		// and src/generated/schema.ts. Mirrors what `entity new` and `relationship new` do.
		const entitiesDir = ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');
		const relationshipsDir = path.resolve(ctx.cwd, 'relationships');
		const junctionsDir = path.resolve(ctx.cwd, 'junctions');
		const generatedDir = resolveGeneratedDir(ctx);
		const architecture = resolveArchitecture(ctx);
		let barrelResult: Awaited<ReturnType<typeof regenerateBarrels>> | null = null;
		try {
			barrelResult = await regenerateBarrels({
				ctx,
				entitiesDir,
				relationshipsDir,
				junctionsDir,
				generatedDir,
				architecture,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!isJsonMode()) {
				printWarning(`barrel regeneration failed — ${msg}`);
			}
		}

		if (isJsonMode()) {
			printJson({
				command: 'junction new',
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
			});
		} else {
			const total = validated.length + invalid.length;
			console.log('');
			if (failed.length === 0) {
				printSuccess(`${total} junctions · ${succeeded.length} succeeded`);
			} else {
				printWarning(
					`${total} junctions · ${succeeded.length} succeeded · ${failed.length} failed`
				);
			}
			if (barrelResult) {
				printInfo(
					`barrels regenerated (${barrelResult.entityCount} modules) → ${path.relative(ctx.cwd, barrelResult.modulesBarrel)}, ${path.relative(ctx.cwd, barrelResult.schemaBarrel)}`,
				);
			}
		}

		return failed.length === 0 ? 0 : 1;
	}
}

// ---------------------------------------------------------------------------
// JunctionListCommand
// ---------------------------------------------------------------------------

export class JunctionListCommand extends Command {
	static paths = [['junction', 'list']];
	static usage = Command.Usage({
		description: 'List defined junctions as a table',
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

		const junctionDir = path.resolve(ctx.cwd, 'junctions');
		const files = listJunctionYamls(junctionDir);

		if (files.length === 0) {
			printInfo('No junction definitions found.');
			return 0;
		}

		const rows = files
			.map(summarizeJunctionFile)
			.filter((r): r is JunctionSummaryRow => r !== null);

		if (isJsonMode()) {
			printJson({
				command: 'junction list',
				junctions: rows,
			});
			return 0;
		}

		const nameW = Math.max(4, ...rows.map((r) => r.name.length));
		const leftW = Math.max(4, ...rows.map((r) => r.left.length));
		const rightW = Math.max(5, ...rows.map((r) => r.right.length));

		console.log(
			theme.muted(
				`${padRight('NAME', nameW)}  ${padRight('LEFT', leftW)}  ${padRight('RIGHT', rightW)}  ROLE  FLAGS`
			)
		);
		for (const r of rows) {
			const flags = [r.temporal ? 'T' : '', r.sourced ? 'S' : ''].filter(Boolean).join(',');
			console.log(
				`${padRight(r.name, nameW)}  ${padRight(r.left, leftW)}  ${padRight(r.right, rightW)}  ${padRight(r.hasRole ? 'yes' : 'no', 4)}  ${flags}`
			);
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const junctionNoun: NounModule = {
	name: 'junction',
	commandClasses: [JunctionNewCommand, JunctionListCommand] as CommandClass[],
	summary,
	hints,
};

export default junctionNoun;
