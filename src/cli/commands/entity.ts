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

import { loadEntityFromYaml } from '../../utils/yaml-loader.js';
import { analyzeDomain, validateEntities } from '../../index.js';

import { loadContext, type Context } from '../shared/context.js';
import { invokeEntityNew } from '../shared/hygen.js';
import { checkGitSafety } from '../shared/git-safety.js';
import {
	regenerateBarrels,
	resolveArchitecture,
	resolveGeneratedDir,
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

function listEntityYamls(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
		.map((f) => path.join(dir, f));
}

interface EntitySummaryRow {
	name: string;
	family: string;
	fields: number;
	queries: number;
	file: string;
}

function summarizeEntityFile(filePath: string): EntitySummaryRow | null {
	const result = loadEntityFromYaml(filePath);
	if (!result.success) return null;
	const def = result.definition;
	return {
		name: def.entity.name,
		family: (def.entity as { family?: string }).family ?? 'base',
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

	const files = listEntityYamls(ctx.entitiesDir);
	const rows = files.map(summarizeEntityFile).filter((r): r is EntitySummaryRow => r !== null);

	const families = new Set(rows.map((r) => r.family));
	const queryCount = rows.reduce((sum, r) => sum + r.queries, 0);

	const nameCol = Math.max(4, ...rows.map((r) => r.name.length));
	const famCol = Math.max(6, ...rows.map((r) => r.family.length));

	const body = rows.map((r) => {
		const fields = `${r.fields} fields`.padEnd(10);
		const queries = `${r.queries} queries`.padEnd(10);
		return `${theme.system(icons.bullet)} ${padRight(r.name, nameCol)}  ${theme.muted(
			padRight(r.family, famCol)
		)}  ${theme.muted(fields)} ${theme.muted(queries)}`;
	});

	return {
		title: 'entities',
		body,
		footer: `${rows.length} entities · ${families.size} families · ${queryCount} queries`,
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
	return [
		{ command: 'codegen entity new <file>', description: 'Generate one entity' },
		{ command: 'codegen entity new --all', description: 'Regenerate all entities' },
		{ command: 'codegen entity validate', description: 'Validate YAML definitions' },
		{ command: 'codegen entity list', description: 'List entities as a table' },
	];
}

// ---------------------------------------------------------------------------
// EntityNewCommand
// ---------------------------------------------------------------------------

export class EntityNewCommand extends Command {
	static paths = [['entity', 'new']];
	static usage = Command.Usage({
		description: 'Generate code for one or more entities from YAML',
		examples: [
			['Generate a single entity', 'codegen entity new entities/contact.yaml'],
			['Regenerate all entities', 'codegen entity new --all'],
			['Preview without writing', 'codegen entity new entities/contact.yaml --dry-run'],
		],
	});

	yaml = Option.String({ required: false });
	all = Option.Boolean('--all', false);
	dryRun = Option.Boolean('--dry-run', false);
	force = Option.Boolean('--force', false);
	only = Option.String('--only', { required: false });
	continueOnError = Option.Boolean('--continue-on-error', false);
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
			targets = listEntityYamls(dir);
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

		// Pre-flight: validate each YAML.
		const validated: Array<{ file: string; name: string }> = [];
		const invalid: Array<{ file: string; message: string }> = [];
		for (const file of targets) {
			const result = loadEntityFromYaml(file);
			if (result.success) {
				validated.push({ file, name: result.definition.entity.name });
			} else {
				invalid.push({ file, message: result.error });
			}
		}

		if (invalid.length > 0 && !this.continueOnError) {
			for (const i of invalid) {
				printError(`${path.basename(i.file)} — ${i.message}`);
			}
			if (!isJsonMode()) {
				return 1;
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
		const generatedDir = resolveGeneratedDir(ctx);
		const architecture = resolveArchitecture(ctx);

		if (this.dryRun) {
			const barrelPlan = await regenerateBarrels({
				ctx,
				entitiesDir,
				generatedDir,
				architecture,
				dryRun: true,
			});

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

	family = Option.String('--family', { required: false });
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

		const files = listEntityYamls(ctx.entitiesDir);
		const rows = files
			.map(summarizeEntityFile)
			.filter((r): r is EntitySummaryRow => r !== null)
			.filter((r) => (this.family ? r.family === this.family : true));

		if (isJsonMode()) {
			printJson({
				command: 'entity list',
				entities: rows,
			});
			return 0;
		}

		if (this.format === 'tree') {
			const byFamily = new Map<string, EntitySummaryRow[]>();
			for (const r of rows) {
				const list = byFamily.get(r.family) ?? [];
				list.push(r);
				byFamily.set(r.family, list);
			}
			for (const [fam, list] of byFamily) {
				console.log(theme.system(fam));
				for (const r of list) {
					console.log(`  ${theme.muted(icons.bullet)} ${r.name}  ${theme.muted(`${r.fields} fields`)}`);
				}
			}
			return 0;
		}

		// plain
		const nameW = Math.max(4, ...rows.map((r) => r.name.length));
		const famW = Math.max(6, ...rows.map((r) => r.family.length));
		console.log(
			theme.muted(
				`${padRight('NAME', nameW)}  ${padRight('FAMILY', famW)}  ${padRight('FIELDS', 8)} ${padRight('QUERIES', 8)}`
			)
		);
		for (const r of rows) {
			console.log(
				`${padRight(r.name, nameW)}  ${padRight(r.family, famW)}  ${padRight(String(r.fields), 8)} ${padRight(String(r.queries), 8)}`
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
