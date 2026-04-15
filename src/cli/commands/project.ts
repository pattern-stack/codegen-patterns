/**
 * Project noun — codegen project / init / scan / config / inspect / graph
 *
 * Implements the `project` surface:
 *   - codegen project           summary pane (initialized? framework? config?)
 *   - codegen project init      scaffold a consumer project (see init-scaffold.ts)
 *   - codegen project scan      run scanner + propose/write codegen.config.yaml
 *   - codegen project config    print resolved config (YAML or JSON)
 *   - codegen project inspect   legacy analyze/stats/doc/manifest/suggestions
 *   - codegen project graph     visualize entity-relationship graph in browser
 *
 * Legacy verbs (`analyze`, `stats`, `doc`, `manifest`, `suggestions`) from
 * `src/cli.ts` are hosted under `codegen project inspect --kind <k>` to keep
 * the noun surface tidy while preserving behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';
import { stringify as stringifyYaml } from 'yaml';

import { analyzeDomain } from '../../index.js';
import { serializeDomainGraph } from '../../analyzer/serialize-graph.js';
import {
	suggestTransitiveRelationships,
	readManifest,
	writeManifest,
	buildManifest,
	isManifestStale,
	getPendingSuggestions,
	updateSuggestionStatus,
	updateAllSuggestionStatus,
	getManifestDir,
} from '../../analyzer/index.js';
import { formatConsole } from '../../formatters/console-formatter.js';
import { formatJson, formatStatsJson } from '../../formatters/json-formatter.js';
import { formatMarkdown } from '../../formatters/markdown-formatter.js';
import { scanProject, generateConfig } from '../../scanner/index.js';

import { loadContext, type Context } from '../shared/context.js';
import { buildInitPlan, writePlan, type InitPlan } from '../shared/init-scaffold.js';

import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import type { PaneOutput } from '../ui/pane.js';
import type { Hint } from '../ui/hints.js';
import type { NounModule } from '../noun-module.js';

// ---------------------------------------------------------------------------
// summary + hints
// ---------------------------------------------------------------------------

async function summary(ctx: Context): Promise<PaneOutput> {
	if (!ctx.isInitialized) {
		return {
			title: 'project',
			body: [
				`${theme.warning(icons.warning)} project not initialized`,
				'',
				'  no codegen.config.yaml detected',
				'  no entities/ directory detected',
			],
			footer: `cwd: ${ctx.cwd}`,
		};
	}

	const body: string[] = [];
	body.push(`${theme.success(icons.check)} project initialized`);
	body.push('');
	body.push(`  config:       ${ctx.configPath ?? '(none)'}`);

	const fw = ctx.framework?.framework?.detected ?? 'unknown';
	const orm = ctx.framework?.orm?.detected ?? 'unknown';
	const arch =
		(ctx.config?.generate as { architecture?: string } | undefined)?.architecture ??
		ctx.framework?.architecture?.detected ??
		'clean';
	const generated =
		(ctx.config?.paths as { generated?: string } | undefined)?.generated ?? 'src/generated';

	body.push(`  framework:    ${fw}`);
	body.push(`  orm:          ${orm}`);
	body.push(`  architecture: ${arch}`);
	body.push(`  entities:     ${ctx.entityCount}`);
	body.push(`  subsystems:   ${ctx.installedSubsystems.length}/4 installed`);
	body.push(`  generated:    ${generated}`);

	return {
		title: 'project',
		body,
		footer: `cwd: ${ctx.cwd}`,
	};
}

async function hints(ctx: Context): Promise<Hint[]> {
	if (!ctx.isInitialized) {
		return [
			{ command: 'codegen init', description: 'Scaffold consumer project' },
			{ command: 'codegen project scan', description: 'Detect framework + ORM' },
		];
	}
	const out: Hint[] = [
		{ command: 'codegen project config', description: 'Print resolved config' },
	];
	if (ctx.entityCount === 0) {
		out.push({
			command: 'codegen entity new entities/example.yaml',
			description: 'Generate first entity',
		});
	} else {
		out.push({ command: 'codegen entity', description: 'Entity summary + hints' });
	}
	if (ctx.installedSubsystems.length < 4) {
		out.push({
			command: 'codegen subsystem',
			description: 'Install events/jobs/cache/storage',
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// ProjectInitCommand
// ---------------------------------------------------------------------------

export class ProjectInitCommand extends Command {
	static paths = [['project', 'init']];
	static usage = Command.Usage({
		description: 'Scaffold a consumer project (config, shims, barrels, app.module)',
		examples: [
			['Initialize with defaults', 'codegen project init --yes'],
			['Preview without writing', 'codegen project init --dry-run'],
			['Create tsconfig if missing', 'codegen project init --yes --with-tsconfig'],
			['Overwrite existing shims', 'codegen project init --force'],
		],
	});

	yes = Option.Boolean('--yes,-y', false);
	dryRun = Option.Boolean('--dry-run', false);
	force = Option.Boolean('--force', false);
	withTsconfig = Option.Boolean('--with-tsconfig', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			json: this.json,
			skipDetection: false,
		});

		const plan = await buildInitPlan(ctx, {
			cwd: ctx.cwd,
			force: this.force,
			withTsconfig: this.withTsconfig,
			skipScan: false,
		});

		if (this.force && !isJsonMode()) {
			printWarning('--force: existing scaffold files will be overwritten.');
		}

		if (this.dryRun) {
			return renderPlanOnly(plan, { dryRun: true });
		}

		if (!this.yes && !isJsonMode()) {
			renderPlanOnly(plan, { dryRun: false });
			console.log('');
			const confirmed = await askConfirm('Proceed?');
			if (!confirmed) {
				printInfo('Aborted.');
				return 0;
			}
			console.log('');
		}

		const result = writePlan(plan);

		if (isJsonMode()) {
			printJson({
				command: 'project init',
				summary: plan.summary,
				planned: plan.entries.length,
				created: result.created.map((e) => e.relPath),
				merged: result.merged.map((e) => e.relPath),
				overwritten: result.overwritten.map((e) => e.relPath),
				skipped: result.skipped.map((e) => ({ path: e.relPath, reason: e.reason })),
			});
			return 0;
		}

		printSuccess('project init complete');
		console.log('');
		console.log(`  ${theme.muted('framework:')}    ${plan.summary.framework}`);
		console.log(`  ${theme.muted('orm:')}          ${plan.summary.orm}`);
		console.log(`  ${theme.muted('architecture:')} ${plan.summary.architecture}`);
		console.log(`  ${theme.muted('frontend:')}     ${plan.summary.frontend}`);
		console.log('');

		for (const e of result.created) {
			console.log(`  ${theme.success(icons.check)} ${theme.muted('create  ')} ${e.relPath}`);
		}
		for (const e of result.merged) {
			console.log(
				`  ${theme.success(icons.check)} ${theme.muted('merge   ')} ${e.relPath}${
					e.reason ? theme.muted('  (' + e.reason + ')') : ''
				}`
			);
		}
		for (const e of result.overwritten) {
			console.log(
				`  ${theme.warning(icons.warning)} ${theme.muted('replace ')} ${e.relPath}`
			);
		}
		for (const e of result.skipped) {
			console.log(
				`  ${theme.muted(icons.dash)} ${theme.muted('skip    ')} ${e.relPath}${
					e.reason ? theme.muted('  (' + e.reason + ')') : ''
				}`
			);
		}
		console.log('');
		printInfo('Next steps:');
		console.log(`  1. ${theme.system('bun add')} the peer deps (see docs/CONSUMER-SETUP.md)`);
		console.log(
			`  2. ${theme.system('codegen entity new entities/<file>.yaml')} to generate your first entity`
		);
		console.log(`  3. ${theme.system('bunx tsc --noEmit')} to verify the scaffold typechecks`);

		return 0;
	}
}

function askConfirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} [Y/n] `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() !== 'n');
		});
	});
}

function renderPlanOnly(plan: InitPlan, opts: { dryRun: boolean }): number {
	if (isJsonMode()) {
		printJson({
			command: 'project init',
			dryRun: opts.dryRun,
			summary: plan.summary,
			entries: plan.entries.map((e) => ({
				path: e.relPath,
				action: e.action,
				reason: e.reason,
				directory: Boolean(e.directory),
			})),
		});
		return 0;
	}
	printInfo(`Dry run — ${plan.entries.length} entries planned`);
	console.log('');
	console.log(`  ${theme.muted('framework:')}    ${plan.summary.framework}`);
	console.log(`  ${theme.muted('orm:')}          ${plan.summary.orm}`);
	console.log(`  ${theme.muted('architecture:')} ${plan.summary.architecture}`);
	console.log('');
	for (const e of plan.entries) {
		const icon =
			e.action === 'create'
				? theme.success(icons.check)
				: e.action === 'merge'
					? theme.success(icons.arrow)
					: e.action === 'overwrite'
						? theme.warning(icons.warning)
						: theme.muted(icons.dash);
		const tag = e.action.padEnd(8);
		const reason = e.reason ? `  ${theme.muted('(' + e.reason + ')')}` : '';
		console.log(`  ${icon} ${theme.muted(tag)} ${e.relPath}${reason}`);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// ProjectScanCommand
// ---------------------------------------------------------------------------

export class ProjectScanCommand extends Command {
	static paths = [['project', 'scan']];
	static usage = Command.Usage({
		description: 'Detect framework/ORM/architecture and propose a codegen.config.yaml',
		examples: [
			['Scan the current directory', 'codegen project scan'],
			['Write config without prompting', 'codegen project scan --write'],
			['Preview only', 'codegen project scan --dry-run'],
		],
	});

	directory = Option.String({ required: false });
	write = Option.Boolean('--write', false);
	dryRun = Option.Boolean('--dry-run', false);
	verbose = Option.Boolean('--verbose,-v', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const baseCwd = this.cwd ? path.resolve(this.cwd) : process.cwd();
		const target = this.directory ? path.resolve(baseCwd, this.directory) : baseCwd;

		if (!fs.existsSync(target)) {
			printError(`Directory not found: ${target}`);
			return 1;
		}

		const profile = await scanProject({ directory: target });
		const config = generateConfig(profile);

		const yamlConfig = {
			framework: config.framework,
			orm: config.orm,
			layout: {
				folder_structure: config.folder_structure,
				file_grouping: config.file_grouping,
			},
			naming: config.naming,
			paths: config.paths,
			generate: config.generate,
			_confidence: config.confidence,
		};
		const yamlText = stringifyYaml(yamlConfig, { indent: 2 });

		if (isJsonMode()) {
			printJson({
				command: 'project scan',
				directory: target,
				profile,
				proposed: config,
			});
			return 0;
		}

		printInfo(`Scanned ${target}`);
		console.log('');
		console.log(
			`  framework:    ${profile.framework.detected} ${theme.muted('(' + profile.framework.confidence + '%)')}`
		);
		console.log(
			`  orm:          ${profile.orm.detected} ${theme.muted('(' + profile.orm.confidence + '%)')}`
		);
		console.log(
			`  architecture: ${profile.architecture.detected} ${theme.muted('(' + profile.architecture.confidence + '%)')}`
		);
		console.log(
			`  naming:       ${profile.naming.fileCase.detected} ${theme.muted('(' + profile.naming.fileCase.confidence + '%)')}`
		);

		if (this.verbose) {
			console.log('');
			printMutedBlock('Evidence', [
				`framework:    ${profile.framework.evidence.join(', ') || '—'}`,
				`orm:          ${profile.orm.evidence.join(', ') || '—'}`,
				`architecture: ${profile.architecture.evidence.join(', ') || '—'}`,
			]);
		}

		const outPath = path.join(target, 'codegen.config.yaml');
		const existsNow = fs.existsSync(outPath);

		if (this.dryRun) {
			console.log('');
			printInfo('Dry run — proposed codegen.config.yaml:');
			console.log('');
			console.log(yamlText);
			return 0;
		}

		if (this.write) {
			if (existsNow) {
				printWarning(`${outPath} already exists — pass --force via edit; skipping.`);
				return 0;
			}
			fs.writeFileSync(outPath, yamlText);
			printSuccess(`wrote ${outPath}`);
			return 0;
		}

		console.log('');
		printInfo(
			`Preview — re-run with ${theme.system('--write')} to save to ${theme.muted('codegen.config.yaml')}`
		);
		console.log('');
		console.log(yamlText);
		return 0;
	}
}

function printMutedBlock(title: string, lines: string[]): void {
	if (isJsonMode()) return;
	console.log(theme.muted(title + ':'));
	for (const l of lines) console.log(theme.muted('  ' + l));
}

// ---------------------------------------------------------------------------
// ProjectConfigCommand
// ---------------------------------------------------------------------------

export class ProjectConfigCommand extends Command {
	static paths = [['project', 'config']];
	static usage = Command.Usage({
		description: 'Print the resolved codegen config (YAML or JSON)',
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

		const resolved = {
			configPath: ctx.configPath,
			cwd: ctx.cwd,
			isInitialized: ctx.isInitialized,
			entityCount: ctx.entityCount,
			entitiesDir: ctx.entitiesDir,
			config: ctx.config ?? {},
		};

		if (isJsonMode()) {
			printJson({ command: 'project config', ...resolved });
			return 0;
		}

		if (!ctx.isInitialized) {
			printWarning('project is not initialized');
			printInfo(`run ${theme.system('codegen init')} to scaffold a project`);
			return 0;
		}

		printInfo(`config: ${ctx.configPath ?? '(none)'}`);
		console.log('');
		console.log(stringifyYaml(ctx.config ?? {}, { indent: 2 }));
		return 0;
	}
}

// ---------------------------------------------------------------------------
// ProjectInspectCommand — analyze/stats/doc/manifest/suggestions
// ---------------------------------------------------------------------------

type InspectKind = 'analyze' | 'stats' | 'doc' | 'manifest' | 'suggestions';

export class ProjectInspectCommand extends Command {
	static paths = [['project', 'inspect']];
	static usage = Command.Usage({
		description: 'Domain analysis, statistics, documentation, and manifest operations',
		examples: [
			['Full analysis', 'codegen project inspect --kind analyze'],
			['Statistics only', 'codegen project inspect --kind stats'],
			['Markdown docs', 'codegen project inspect --kind doc --output domain.md'],
			['Refresh manifest', 'codegen project inspect --kind manifest --force'],
			['Review suggestions', 'codegen project inspect --kind suggestions'],
		],
	});

	kind = Option.String('--kind', { required: true });
	dir = Option.String({ required: false });
	format = Option.String('--format', 'console');
	output = Option.String('--output,-o', { required: false });
	strict = Option.Boolean('--strict', false);
	entity = Option.String('--entity', { required: false });
	force = Option.Boolean('--force', false);
	accept = Option.String('--accept', { required: false });
	skip = Option.String('--skip', { required: false });
	acceptAll = Option.Boolean('--accept-all', false);
	skipAll = Option.Boolean('--skip-all', false);
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

		const kind = this.kind as InspectKind;

		if (kind === 'suggestions') {
			return this.runSuggestions(ctx);
		}
		if (kind === 'manifest') {
			return this.runManifest(ctx);
		}
		if (kind === 'analyze' || kind === 'stats' || kind === 'doc') {
			return this.runAnalysis(ctx, kind);
		}

		printError(
			`Unknown --kind '${this.kind}'. Valid: analyze, stats, doc, manifest, suggestions`
		);
		return 2;
	}

	private resolveEntitiesDir(ctx: Context): string | null {
		if (this.dir) return path.resolve(ctx.cwd, this.dir);
		return ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');
	}

	private async runAnalysis(
		ctx: Context,
		kind: 'analyze' | 'stats' | 'doc'
	): Promise<number> {
		const entitiesDir = this.resolveEntitiesDir(ctx);
		if (!entitiesDir || !fs.existsSync(entitiesDir)) {
			printError(`Directory not found: ${entitiesDir ?? '(no entities/ dir)'}`);
			return 1;
		}

		const result = await analyzeDomain(entitiesDir);

		let filtered = result;
		if (this.entity) {
			const e = result.entities.find((x) => x.name === this.entity);
			if (!e) {
				printError(`Entity not found: ${this.entity}`);
				return 1;
			}
			filtered = {
				...result,
				entities: [e],
				issues: result.issues.filter((i) => i.entity === this.entity || !i.entity),
			};
		}

		const format = kind === 'doc' ? 'markdown' : (this.format as 'console' | 'json' | 'markdown');
		let out: string;
		if (kind === 'stats') {
			out = format === 'json' ? formatStatsJson(filtered) : formatStatsConsole(filtered);
		} else if (format === 'json') {
			out = formatJson(filtered);
		} else if (format === 'markdown') {
			out = formatMarkdown(filtered);
		} else {
			out = formatConsole(filtered);
		}

		if (this.output) {
			fs.writeFileSync(this.output, out);
			if (!isJsonMode()) printSuccess(`wrote ${this.output}`);
		} else {
			console.log(out);
		}

		const hasErrors = filtered.issues.some((i) => i.severity === 'error');
		const hasWarnings = filtered.issues.some((i) => i.severity === 'warning');
		if (hasErrors) return 1;
		if (this.strict && hasWarnings) return 1;
		return 0;
	}

	private async runManifest(ctx: Context): Promise<number> {
		const entitiesDir = this.resolveEntitiesDir(ctx);
		if (!entitiesDir || !fs.existsSync(entitiesDir)) {
			printError(`Directory not found: ${entitiesDir ?? '(no entities/ dir)'}`);
			return 1;
		}

		if (!this.force) {
			const stale = await isManifestStale(ctx.cwd, entitiesDir);
			if (!stale) {
				if (isJsonMode()) {
					printJson({ command: 'project inspect', kind: 'manifest', status: 'up-to-date' });
				} else {
					printInfo('Manifest is up to date. Use --force to re-scan.');
				}
				return 0;
			}
		}

		const analysis = await analyzeDomain(entitiesDir);
		const transitiveSuggestions = suggestTransitiveRelationships(analysis.graph);
		const existing = readManifest(ctx.cwd);
		const manifest = await buildManifest(
			analysis,
			transitiveSuggestions,
			entitiesDir,
			existing
		);
		writeManifest(ctx.cwd, manifest);

		if (isJsonMode()) {
			printJson({
				command: 'project inspect',
				kind: 'manifest',
				statistics: manifest.statistics,
				suggestions: manifest.suggestions,
			});
			return 0;
		}

		printSuccess(`manifest updated → ${getManifestDir()}/manifest.json`);
		console.log(`  entities:      ${manifest.statistics.totalEntities}`);
		console.log(`  relationships: ${manifest.statistics.totalRelationships}`);
		console.log(`  fields:        ${manifest.statistics.totalFields}`);
		const pending = manifest.suggestions.transitive.filter((s) => s.status === 'pending');
		if (pending.length > 0) {
			printInfo(
				`${pending.length} pending suggestion${pending.length === 1 ? '' : 's'} — run ${theme.system(
					'codegen project inspect --kind suggestions'
				)}`
			);
		}
		return 0;
	}

	private async runSuggestions(ctx: Context): Promise<number> {
		if (this.acceptAll) {
			const n = updateAllSuggestionStatus(ctx.cwd, 'accepted');
			if (isJsonMode()) {
				printJson({ command: 'project inspect', kind: 'suggestions', acceptedAll: n });
				return 0;
			}
			if (n > 0) printSuccess(`accepted ${n} suggestion${n === 1 ? '' : 's'}`);
			else printInfo('No pending suggestions.');
			return 0;
		}
		if (this.skipAll) {
			const n = updateAllSuggestionStatus(ctx.cwd, 'skipped');
			if (isJsonMode()) {
				printJson({ command: 'project inspect', kind: 'suggestions', skippedAll: n });
				return 0;
			}
			if (n > 0) printSuccess(`skipped ${n} suggestion${n === 1 ? '' : 's'}`);
			else printInfo('No pending suggestions.');
			return 0;
		}
		if (this.accept) {
			const ok = updateSuggestionStatus(ctx.cwd, this.accept, 'accepted');
			if (!ok) {
				printError(`Suggestion not found: ${this.accept}`);
				return 1;
			}
			printSuccess(`accepted ${this.accept}`);
			return 0;
		}
		if (this.skip) {
			const ok = updateSuggestionStatus(ctx.cwd, this.skip, 'skipped');
			if (!ok) {
				printError(`Suggestion not found: ${this.skip}`);
				return 1;
			}
			printSuccess(`skipped ${this.skip}`);
			return 0;
		}

		const pending = getPendingSuggestions(ctx.cwd);
		if (isJsonMode()) {
			printJson({ command: 'project inspect', kind: 'suggestions', pending });
			return 0;
		}
		if (pending.length === 0) {
			printInfo('No pending suggestions.');
			return 0;
		}
		console.log(theme.system(`${pending.length} pending suggestions:`));
		for (const s of pending) {
			console.log('');
			console.log(`  ${theme.muted(s.id)}  ${s.source} → ${s.target}  (${s.suggestedName})`);
		}
		return 0;
	}
}

// Local stats console formatter — avoids pulling in src/cli.ts. Keeps the
// legacy look-and-feel for the inspect command.
function formatStatsConsole(result: {
	statistics: {
		totalEntities: number;
		totalFields: number;
		totalRelationships: number;
		averageFieldsPerEntity: number;
		fieldsByType: Record<string, number>;
		relationshipsByType: Record<string, number>;
	};
}): string {
	const lines: string[] = [];
	lines.push('');
	lines.push(theme.system('Domain Statistics'));
	lines.push('');
	lines.push(`   Entities:      ${result.statistics.totalEntities}`);
	lines.push(
		`   Fields:        ${result.statistics.totalFields} (avg ${result.statistics.averageFieldsPerEntity.toFixed(1)}/entity)`
	);
	lines.push(`   Relationships: ${result.statistics.totalRelationships}`);
	lines.push('');
	lines.push('   Field types:');
	for (const [type, count] of Object.entries(result.statistics.fieldsByType).sort(
		(a, b) => b[1] - a[1]
	)) {
		lines.push(`     ${type.padEnd(12)} ${count}`);
	}
	if (result.statistics.totalRelationships > 0) {
		lines.push('');
		lines.push('   Relationship types:');
		for (const [type, count] of Object.entries(result.statistics.relationshipsByType).sort(
			(a, b) => b[1] - a[1]
		)) {
			lines.push(`     ${type.padEnd(12)} ${count}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}


// ---------------------------------------------------------------------------
// ProjectGraphCommand
// ---------------------------------------------------------------------------

export class ProjectGraphCommand extends Command {
	static paths = [['project', 'graph']];
	static usage = Command.Usage({
		description: 'Visualize the entity-relationship graph in a browser',
		examples: [
			['Open interactive graph viewer', 'codegen project graph'],
			['Export graph as JSON', 'codegen project graph --json'],
			['Write graph JSON to file', 'codegen project graph --output graph.json'],
		],
	});

	dir = Option.String({ required: false });
	output = Option.String('--output,-o', { required: false });
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

		const entitiesDir = this.dir
			? path.resolve(ctx.cwd, this.dir)
			: ctx.entitiesDir ?? path.resolve(ctx.cwd, 'entities');

		if (!fs.existsSync(entitiesDir)) {
			printError(`Entity directory not found: ${entitiesDir}`);
			return 1;
		}

		// Relationships dir: check alongside entities, then as subdirectory, then at cwd level
		const relCandidates = [
			path.resolve(path.dirname(entitiesDir), 'relationships'),
			path.resolve(entitiesDir, 'relationships'),
			path.resolve(ctx.cwd, 'relationships'),
		];
		const relationshipsDir = relCandidates.find((d) => fs.existsSync(d));

		const result = await analyzeDomain(entitiesDir, relationshipsDir);
		const serialized = serializeDomainGraph(result.graph);

		if (isJsonMode()) {
			printJson({
				command: 'project graph',
				entities: result.entities.length,
				relationshipDefinitions: result.relationshipDefinitions.length,
				edges: result.graph.edges.length,
				graph: serialized,
			});
			return 0;
		}

		if (this.output) {
			const outPath = path.resolve(ctx.cwd, this.output);
			fs.writeFileSync(outPath, JSON.stringify(serialized, null, 2));
			printSuccess(`Graph written to ${outPath}`);
			printInfo(`${result.entities.length} entities, ${result.relationshipDefinitions.length} relationships, ${result.graph.edges.length} edges`);
			return 0;
		}

		// Write to temp file and provide viewer instructions
		const os = await import('node:os');
		const tmpDir = fs.mkdtempSync(path.join(os.default.tmpdir(), 'codegen-graph-'));
		const graphPath = path.join(tmpDir, 'graph.json');
		fs.writeFileSync(graphPath, JSON.stringify(serialized, null, 2));

		const viewerDir = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'schema-graph-viewer');
		const viewerDist = path.join(viewerDir, 'dist', 'index.html');

		if (fs.existsSync(viewerDist)) {
			fs.copyFileSync(graphPath, path.join(viewerDir, 'dist', 'graph.json'));
			printSuccess('Graph exported');
			printInfo(`${result.entities.length} entities, ${result.relationshipDefinitions.length} relationships, ${result.graph.edges.length} edges`);
			printInfo(`Graph JSON: ${graphPath}`);
			printInfo(`Open the viewer: cd ${viewerDir} && npx vite preview`);
		} else {
			printSuccess('Graph exported');
			printInfo(`${result.entities.length} entities, ${result.relationshipDefinitions.length} relationships, ${result.graph.edges.length} edges`);
			printInfo(`Graph JSON: ${graphPath}`);
			printInfo(`To view: cd ${viewerDir} && bun install && bun run dev`);
		}

		return 0;
	}
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const projectNoun: NounModule = {
	name: 'project',
	commandClasses: [
		ProjectInitCommand,
		ProjectScanCommand,
		ProjectConfigCommand,
		ProjectInspectCommand,
		ProjectGraphCommand,
	] as CommandClass[],
	summary,
	hints,
};

export default projectNoun;
