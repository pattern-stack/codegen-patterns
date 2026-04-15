/**
 * Relationship noun — codegen relationship new / relationship list
 *
 * Generates code for first-class relationship definitions (junction tables
 * between core entities). Mirrors the entity noun but delegates to the
 * relationship template set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import { loadRelationshipFromYaml, detectYamlType } from '../../utils/yaml-loader.js';

import { loadContext, type Context } from '../shared/context.js';
import { invokeRelationshipNew } from '../shared/hygen.js';
import { checkGitSafety } from '../shared/git-safety.js';

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

function listRelationshipYamls(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
		.filter((f) => {
			// Only include files that are actual relationship definitions
			const fullPath = path.join(dir, f);
			return detectYamlType(fullPath) === 'relationship';
		})
		.map((f) => path.join(dir, f));
}

interface RelationshipSummaryRow {
	name: string;
	from: string;
	to: string;
	types: number;
	temporal: boolean;
	sourced: boolean;
	file: string;
}

function summarizeRelationshipFile(filePath: string): RelationshipSummaryRow | null {
	const result = loadRelationshipFromYaml(filePath);
	if (!result.success) return null;
	const def = result.definition;
	const types = def.relationship.types
		? Array.isArray(def.relationship.types)
			? def.relationship.types.length
			: Object.keys(def.relationship.types).length
		: 0;
	return {
		name: def.relationship.name,
		from: def.relationship.from,
		to: def.relationship.to,
		types,
		temporal: def.relationship.temporal,
		sourced: def.relationship.sourced,
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
	const relDir = path.resolve(ctx.cwd, 'relationships');
	const files = listRelationshipYamls(relDir);

	if (files.length === 0) {
		return {
			title: 'relationships',
			body: [
				'No relationship definitions found.',
				'',
				`Create one at ${theme.system('relationships/<name>.yaml')} to get started.`,
			],
		};
	}

	const rows = files
		.map(summarizeRelationshipFile)
		.filter((r): r is RelationshipSummaryRow => r !== null);

	const nameCol = Math.max(4, ...rows.map((r) => r.name.length));
	const endpointsCol = Math.max(9, ...rows.map((r) => `${r.from} → ${r.to}`.length));

	const body = rows.map((r) => {
		const endpoints = `${r.from} → ${r.to}`;
		const flags = [
			r.types > 0 ? `${r.types} types` : '',
			r.temporal ? 'temporal' : '',
			r.sourced ? 'sourced' : '',
		]
			.filter(Boolean)
			.join(', ');
		return `${theme.system(icons.bullet)} ${padRight(r.name, nameCol)}  ${theme.muted(
			padRight(endpoints, endpointsCol)
		)}  ${theme.muted(flags)}`;
	});

	return {
		title: 'relationships',
		body,
		footer: `${rows.length} relationships`,
	};
}

async function hints(_ctx: Context): Promise<Hint[]> {
	return [
		{ command: 'codegen relationship new <file>', description: 'Generate one relationship' },
		{ command: 'codegen relationship new --all', description: 'Generate all relationships' },
		{ command: 'codegen relationship list', description: 'List relationship definitions' },
	];
}

// ---------------------------------------------------------------------------
// RelationshipNewCommand
// ---------------------------------------------------------------------------

export class RelationshipNewCommand extends Command {
	static paths = [['relationship', 'new']];
	static usage = Command.Usage({
		description: 'Generate code for one or more relationships from YAML',
		examples: [
			['Generate a single relationship', 'codegen relationship new relationships/person_organization.yaml'],
			['Generate all relationships', 'codegen relationship new --all'],
			['Preview without writing', 'codegen relationship new relationships/person_organization.yaml --dry-run'],
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
			const dir = path.resolve(ctx.cwd, 'relationships');
			targets = listRelationshipYamls(dir);
			if (targets.length === 0) {
				printError(`No relationship YAML files found in ${dir}`);
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
			const result = loadRelationshipFromYaml(file);
			if (result.success) {
				validated.push({ file, name: result.definition.relationship.name });
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
					command: 'relationship new',
					dryRun: true,
					relationships: validated.map((v) => ({ name: v.name, file: v.file })),
					totals: { planned: validated.length, invalid: invalid.length },
				});
			} else {
				printInfo(`Dry run — ${validated.length} relationships would be generated:`);
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
			const res = invokeRelationshipNew(v.file, ctx.cwd);
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

		if (isJsonMode()) {
			printJson({
				command: 'relationship new',
				totals: {
					succeeded: succeeded.length,
					failed: failed.length,
				},
				succeeded,
				failed,
			});
		} else {
			const total = validated.length + invalid.length;
			console.log('');
			if (failed.length === 0) {
				printSuccess(`${total} relationships · ${succeeded.length} succeeded`);
			} else {
				printWarning(
					`${total} relationships · ${succeeded.length} succeeded · ${failed.length} failed`
				);
			}
		}

		return failed.length === 0 ? 0 : 1;
	}
}

// ---------------------------------------------------------------------------
// RelationshipListCommand
// ---------------------------------------------------------------------------

export class RelationshipListCommand extends Command {
	static paths = [['relationship', 'list']];
	static usage = Command.Usage({
		description: 'List defined relationships as a table',
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

		const relDir = path.resolve(ctx.cwd, 'relationships');
		const files = listRelationshipYamls(relDir);

		if (files.length === 0) {
			printInfo('No relationship definitions found.');
			return 0;
		}

		const rows = files
			.map(summarizeRelationshipFile)
			.filter((r): r is RelationshipSummaryRow => r !== null);

		if (isJsonMode()) {
			printJson({
				command: 'relationship list',
				relationships: rows,
			});
			return 0;
		}

		const nameW = Math.max(4, ...rows.map((r) => r.name.length));
		const fromW = Math.max(4, ...rows.map((r) => r.from.length));
		const toW = Math.max(2, ...rows.map((r) => r.to.length));

		console.log(
			theme.muted(
				`${padRight('NAME', nameW)}  ${padRight('FROM', fromW)}  ${padRight('TO', toW)}  TYPES  FLAGS`
			)
		);
		for (const r of rows) {
			const flags = [r.temporal ? 'T' : '', r.sourced ? 'S' : ''].filter(Boolean).join(',');
			console.log(
				`${padRight(r.name, nameW)}  ${padRight(r.from, fromW)}  ${padRight(r.to, toW)}  ${padRight(String(r.types), 5)}  ${flags}`
			);
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const relationshipNoun: NounModule = {
	name: 'relationship',
	commandClasses: [RelationshipNewCommand, RelationshipListCommand] as CommandClass[],
	summary,
	hints,
};

export default relationshipNoun;
