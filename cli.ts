#!/usr/bin/env bun
/**
 * Entity Code Generation & Domain Analysis CLI
 *
 * Generation commands:
 *   bun run codegen entity <yaml-file>     Generate entity from YAML
 *   bun run codegen all                    Generate all entities in entities/
 *
 * Analysis commands:
 *   bun run codegen validate <dir>         Validate YAML files only
 *   bun run codegen analyze <dir>          Full analysis with graph and issues
 *   bun run codegen stats <dir>            Statistics only
 *   bun run codegen doc <dir>              Generate markdown documentation
 *
 * Options:
 *   -f, --format <format>  Output format: console, json, markdown (default: console)
 *   -o, --output <file>    Write output to file
 *   -s, --strict           Treat warnings as errors
 *   -e, --entity <name>    Focus on specific entity
 *   -h, --help             Show help
 */

import { execSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { getProjectConfig } from './config/paths.mjs';
import * as clack from '@clack/prompts';
import { stringify as stringifyYaml } from 'yaml';
import { loadEntityFromYaml, formatLoadError } from './utils/yaml-loader';
import { analyzeDomain } from './index';
import { formatConsole } from './output/console-formatter';
import { formatJson, formatStatsJson } from './output/json-formatter';
import { formatMarkdown } from './output/markdown-formatter';
import { scanProject, generateConfig } from './scanner/index';
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
} from './analyzer';
import type { AnalysisResult, OutputFormat, ManifestSuggestion } from './analyzer/types';

const USAGE = `
Entity Code Generation & Domain Analysis CLI

Usage:
  bun run codegen <command> [options] [args]

Generation Commands:
  entity <yaml-file>     Generate entity from YAML definition
  all                    Generate all entities in entities/
  broadcast [yaml-file]  Generate WebSocket broadcast infrastructure
  scan [directory]       Scan project and generate codegen.config.yaml

Analysis Commands:
  validate <dir>         Validate all entity YAML files
  analyze <dir>          Full analysis with statistics and warnings
  stats <dir>            Show statistics only
  doc <dir>              Generate markdown documentation (alias for analyze -f markdown)

Manifest Commands:
  manifest [dir]         Scan entities and update .codegen/manifest.json
  suggestions            Review pending transitive relationship suggestions

Options:
  -h, --help               Show this help
  -f, --format <format>    Output format: console, json, markdown (default: console)
  -o, --output <file>      Write output to file instead of stdout
  -s, --strict             Treat warnings as errors (exit 1)
  -e, --entity <name>      Focus on specific entity
  -v, --verbose            Show detailed detection results
  --entities-dir <path>    Override entities directory (default: entities/)
  --force                  Force re-scan even if manifest is fresh
  --accept <id>            Accept a transitive suggestion by ID
  --skip <id>              Skip a transitive suggestion by ID
  --accept-all             Accept all pending suggestions
  --skip-all               Skip all pending suggestions

Environment Variables:
  CODEGEN_TEMPLATES_DIR    Path to Hygen templates (default: <script-dir>/templates)
  CODEGEN_ENTITIES_DIR     Path to entity YAML files (default: entities/)
  CODEGEN_MANIFEST_DIR     Directory for manifest.json (default: .codegen/)

Examples:
  bun run codegen entity entities/opportunity.yaml
  bun run codegen all
  bun run codegen broadcast
  bun run codegen scan .
  bun run codegen validate tools/codegen/test/fixtures/
  bun run codegen analyze tools/codegen/test/fixtures/ -f json
  bun run codegen stats tools/codegen/test/fixtures/
  bun run codegen doc tools/codegen/test/fixtures/ -o domain.md
`;

// ============================================================================
// Generation Functions (existing)
// ============================================================================

function validateYaml(filePath: string): boolean {
	const result = loadEntityFromYaml(filePath);

	if (!result.success) {
		console.log(formatLoadError(result));
		return false;
	}

	console.log(`[OK] Validation passed: ${result.definition.entity.name}`);
	console.log(`   Fields: ${Object.keys(result.definition.fields).length}`);
	console.log(
		`   Relationships: ${Object.keys(result.definition.relationships || {}).length}`
	);
	return true;
}

function generateEntity(filePath: string, quiet = false): boolean {
	// First validate
	const result = loadEntityFromYaml(filePath);

	if (!result.success) {
		console.log(formatLoadError(result));
		return false;
	}

	console.log(`[GEN] Generating entity: ${result.definition.entity.name}`);

	// Resolve templates directory dynamically
	const templatesDir = process.env.CODEGEN_TEMPLATES_DIR || join(import.meta.dirname, 'templates');

	// Run Hygen
	const fullPath = resolve(process.cwd(), filePath);
	const hygenCmd = `HYGEN_TMPLS="${templatesDir}" bunx hygen entity new --yaml "${fullPath}"`;

	try {
		execSync(hygenCmd, {
			stdio: 'inherit',
			cwd: process.cwd(),
		});
		if (!quiet) {
			console.log(`\n[OK] Entity generated successfully!`);
		}
		return true;
	} catch (error) {
		console.error('[FAIL] Generation failed');
		return false;
	}
}

function generateAll(entitiesDirOverride?: string) {
	const projectConfig = getProjectConfig();
	const entitiesDir = entitiesDirOverride
		|| process.env.CODEGEN_ENTITIES_DIR
		|| projectConfig?.paths?.entities_dir
		|| resolve(process.cwd(), 'entities');

	const resolvedDir = resolve(process.cwd(), entitiesDir);
	const files = readdirSync(resolvedDir).filter((f) => f.endsWith('.yaml'));

	if (files.length === 0) {
		console.error(`[FAIL] No YAML files found in ${entitiesDir}`);
		process.exit(1);
	}

	console.log(`[START] Generating ${files.length} entities from ${entitiesDir}...\n`);

	let success = 0;
	let failed = 0;

	for (const file of files) {
		const filePath = join(entitiesDir, file);
		if (generateEntity(filePath, true)) {
			success++;
		} else {
			failed++;
		}
		console.log('');
	}

	console.log(`\n[OK] Generated ${success} entities${failed > 0 ? `, ${failed} failed` : ''}`);
	console.log(`\n[NEXT] Next steps:`);
	console.log(`   1. Import modules in app.module.ts (if not auto-injected)`);
	console.log(`   2. Run: bun run db:generate --name add-entities`);
	console.log(`   3. Run: bun run db:migrate`);

	if (failed > 0) {
		process.exit(1);
	}
}

function generateBroadcast(yamlPath?: string): boolean {
	console.log(`[GEN] Generating broadcast infrastructure${yamlPath ? ` from ${yamlPath}` : ' with defaults'}`);

	const cwd = process.cwd();
	// Use env var or script location to find templates (works when running from any directory)
	const templatesDir = process.env.CODEGEN_TEMPLATES_DIR || join(import.meta.dirname, 'templates');

	// Build Hygen command
	let hygenCmd = 'bunx hygen broadcast new';
	if (yamlPath) {
		const fullYamlPath = resolve(cwd, yamlPath);
		if (!existsSync(fullYamlPath)) {
			console.error(`[FAIL] Config file not found: ${fullYamlPath}`);
			return false;
		}
		hygenCmd += ` --yaml "${fullYamlPath}"`;
	}

	try {
		execSync(hygenCmd, {
			stdio: 'inherit',
			cwd,
			env: { ...process.env, HYGEN_TMPLS: templatesDir },
		});
		console.log(`\n[OK] Broadcast infrastructure generated successfully!`);
		console.log(`\n[NEXT] Next steps:`);
		console.log(`   1. Import BroadcastModule in your app.module.ts`);
		console.log(`   2. Ensure @nestjs/websockets and socket.io are installed`);
		console.log(`   3. Connect clients to ws://localhost:3000/ws/broadcast`);
		return true;
	} catch (error) {
		console.error('[FAIL] Generation failed');
		return false;
	}
}

async function runScanCommand(directory: string, verbose: boolean): Promise<void> {
	clack.intro('🔍 Project Scanner');

	const spinner = clack.spinner();
	spinner.start('Scanning project structure...');

	try {
		const profile = await scanProject({ directory });
		spinner.stop('Scan complete!');

		// Show detection results
		console.log('');
		clack.note(
			[
				`Framework:    ${profile.framework.detected} (${profile.framework.confidence}% confidence)`,
				`ORM:          ${profile.orm.detected} (${profile.orm.confidence}% confidence)`,
				`Architecture: ${profile.architecture.detected} (${profile.architecture.confidence}% confidence)`,
				`Naming:       ${profile.naming.fileCase.detected} files (${profile.naming.fileCase.confidence}% confidence)`,
			].join('\n'),
			'Detection Results'
		);

		if (verbose) {
			console.log('');
			clack.note(
				[
					`Framework evidence: ${profile.framework.evidence.join(', ') || 'none'}`,
					`ORM evidence: ${profile.orm.evidence.join(', ') || 'none'}`,
					`Architecture evidence: ${profile.architecture.evidence.join(', ') || 'none'}`,
					`Naming suffixes: ${profile.naming.suffixes.join(', ') || 'none'}`,
				].join('\n'),
				'Evidence Details'
			);
		}

		// Generate config
		const config = generateConfig(profile);

		// Ask if user wants to save
		const shouldSave = await clack.confirm({
			message: `Save config to codegen.config.yaml? (${config.confidence.overall}% overall confidence)`,
			initialValue: true,
		});

		if (clack.isCancel(shouldSave)) {
			clack.cancel('Cancelled');
			process.exit(0);
		}

		if (shouldSave) {
			// Format config for YAML output
			const yamlConfig = {
				framework: config.framework,
				orm: config.orm,
				layout: {
					folder_structure: config.folder_structure,
					file_grouping: config.file_grouping,
				},
				naming: config.naming,
				paths: config.paths,
				_confidence: config.confidence,
			};

			const outputPath = join(directory, 'codegen.config.yaml');
			writeFileSync(outputPath, stringifyYaml(yamlConfig, { indent: 2 }));
			clack.log.success(`Config saved to ${outputPath}`);
		}

		clack.outro('Done!');
	} catch (error) {
		spinner.stop('Scan failed');
		clack.log.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

// ============================================================================
// Manifest Commands
// ============================================================================

async function runManifestCommand(
	entitiesDir: string,
	options: { force: boolean }
): Promise<void> {
	const projectRoot = process.cwd();

	// Check staleness unless forced
	if (!options.force) {
		const stale = await isManifestStale(projectRoot, entitiesDir);
		if (!stale) {
			console.log('\x1b[33m[INFO]\x1b[0m Manifest is up to date. Use --force to re-scan.');
			return;
		}
	}

	console.log(`\nScanning entities in ${entitiesDir}...\n`);

	// Run analysis
	const analysis = await analyzeDomain(entitiesDir);

	// Get transitive suggestions
	const transitiveSuggestions = suggestTransitiveRelationships(analysis.graph);

	// Build and write manifest
	const existingManifest = readManifest(projectRoot);
	const manifest = await buildManifest(
		analysis,
		transitiveSuggestions,
		entitiesDir,
		existingManifest
	);

	writeManifest(projectRoot, manifest);

	// Output summary
	console.log('\x1b[32m[OK]\x1b[0m Manifest updated');
	console.log(`   Entities:        ${manifest.statistics.totalEntities}`);
	console.log(`   Relationships:   ${manifest.statistics.totalRelationships}`);
	console.log(`   Fields:          ${manifest.statistics.totalFields}`);

	const pending = manifest.suggestions.transitive.filter(s => s.status === 'pending');
	if (pending.length > 0) {
		console.log(`\n\x1b[36m[INFO]\x1b[0m ${pending.length} transitive relationship suggestion${pending.length > 1 ? 's' : ''}:`);
		for (const s of pending) {
			console.log(`   ${s.source} → ${s.target} (${s.suggestedName})`);
		}
		console.log('\nRun \x1b[1mbun run codegen suggestions\x1b[0m to review.');
	}

	console.log(`\nWrote ${getManifestDir()}/manifest.json`);
}

function formatSuggestionBox(suggestion: ManifestSuggestion): string {
	const lines: string[] = [];
	const yamlLines = suggestion.yamlSnippet.split('\n');
	const maxWidth = Math.max(...yamlLines.map(l => l.length), 48);

	lines.push(`\x1b[36m--- ${suggestion.id} ---\x1b[0m`);
	lines.push(`Add to \x1b[1m${suggestion.source}.yaml\x1b[0m:\n`);
	lines.push('\x1b[90m+' + '-'.repeat(maxWidth + 2) + '+\x1b[0m');
	for (const line of yamlLines) {
		lines.push('\x1b[90m|\x1b[0m ' + line.padEnd(maxWidth) + ' \x1b[90m|\x1b[0m');
	}
	lines.push('\x1b[90m+' + '-'.repeat(maxWidth + 2) + '+\x1b[0m');
	return lines.join('\n');
}

async function runSuggestionsCommand(options: {
	accept?: string;
	skip?: string;
	acceptAll?: boolean;
	skipAll?: boolean;
}): Promise<void> {
	const projectRoot = process.cwd();

	if (options.acceptAll) {
		const count = updateAllSuggestionStatus(projectRoot, 'accepted');
		if (count > 0) {
			console.log(`\x1b[32m[OK]\x1b[0m Accepted ${count} suggestion${count > 1 ? 's' : ''}.`);
			console.log('\n\x1b[33m[NOTE]\x1b[0m Remember to add the YAML to your entity files manually.');
		} else {
			console.log('No pending suggestions to accept.');
		}
		return;
	}

	if (options.skipAll) {
		const count = updateAllSuggestionStatus(projectRoot, 'skipped');
		if (count > 0) {
			console.log(`\x1b[32m[OK]\x1b[0m Skipped ${count} suggestion${count > 1 ? 's' : ''}.`);
		} else {
			console.log('No pending suggestions to skip.');
		}
		return;
	}

	if (options.accept) {
		const success = updateSuggestionStatus(projectRoot, options.accept, 'accepted');
		if (success) {
			console.log(`\x1b[32m[OK]\x1b[0m Accepted ${options.accept}`);
			// Show the YAML to copy
			const manifest = readManifest(projectRoot);
			const suggestion = manifest?.suggestions.transitive.find(s => s.id === options.accept);
			if (suggestion) {
				console.log('\nAdd this to your entity YAML:\n');
				console.log(suggestion.yamlSnippet);
			}
		} else {
			console.error(`\x1b[31m[FAIL]\x1b[0m Suggestion not found: ${options.accept}`);
			process.exit(1);
		}
		return;
	}

	if (options.skip) {
		const success = updateSuggestionStatus(projectRoot, options.skip, 'skipped');
		if (success) {
			console.log(`\x1b[32m[OK]\x1b[0m Skipped ${options.skip}`);
		} else {
			console.error(`\x1b[31m[FAIL]\x1b[0m Suggestion not found: ${options.skip}`);
			process.exit(1);
		}
		return;
	}

	// List pending suggestions
	const pending = getPendingSuggestions(projectRoot);

	if (pending.length === 0) {
		console.log('No pending suggestions.');
		console.log('\nRun \x1b[1mbun run codegen manifest entities/\x1b[0m to scan for new suggestions.');
		return;
	}

	console.log(`\n\x1b[1m${pending.length} pending suggestion${pending.length > 1 ? 's' : ''}:\x1b[0m\n`);

	for (const s of pending) {
		console.log(formatSuggestionBox(s));
		console.log('');
	}

	console.log('Use \x1b[1m--accept <id>\x1b[0m, \x1b[1m--skip <id>\x1b[0m, \x1b[1m--accept-all\x1b[0m, or \x1b[1m--skip-all\x1b[0m to resolve.');
}

// ============================================================================
// Analysis Functions (new)
// ============================================================================

function formatValidateOutput(result: AnalysisResult, format: OutputFormat): string {
	const errors = result.issues.filter((i) => i.severity === 'error');

	switch (format) {
		case 'json':
			return formatJson({
				...result,
				issues: errors,
			});

		case 'markdown': {
			const lines: string[] = [];
			lines.push('# Validation Results');
			lines.push('');

			if (result.isValid) {
				lines.push('**Status:** Valid');
				lines.push('');
				lines.push(`Validated ${result.entities.length} entities successfully.`);
			} else {
				lines.push('**Status:** Invalid');
				lines.push('');
				lines.push(`Found ${errors.length} validation errors:`);
				lines.push('');
				for (const error of errors) {
					lines.push(`- **${error.entity ?? error.path}**: ${error.message}`);
				}
			}
			return lines.join('\n');
		}

		case 'console':
		default: {
			const consoleLines: string[] = [];

			if (result.isValid) {
				consoleLines.push('\x1b[32m[OK]\x1b[0m All entities validated successfully');
				consoleLines.push('');
				for (const entity of result.entities) {
					consoleLines.push(
						`   \x1b[36m${entity.name}\x1b[0m - ${entity.fields.size} fields, ${entity.relationships.size} relationships`
					);
				}
			} else {
				consoleLines.push(
					`\x1b[31m[FAIL]\x1b[0m Validation failed with ${errors.length} errors:`
				);
				consoleLines.push('');
				for (const error of errors) {
					const location = error.entity ?? error.path ?? 'unknown';
					consoleLines.push(`   \x1b[31m[X]\x1b[0m ${location}: ${error.message}`);
					if (error.suggestion) {
						consoleLines.push(`       -> ${error.suggestion}`);
					}
				}
			}

			return consoleLines.join('\n');
		}
	}
}

function formatAnalyzeOutput(result: AnalysisResult, format: OutputFormat): string {
	switch (format) {
		case 'json':
			return formatJson(result);

		case 'markdown':
			return formatMarkdown(result);

		case 'console':
		default:
			return formatConsole(result);
	}
}

function formatStatsOutput(result: AnalysisResult, format: OutputFormat): string {
	switch (format) {
		case 'json':
			return formatStatsJson(result);

		case 'markdown': {
			const lines: string[] = [];
			lines.push('# Domain Statistics');
			lines.push('');
			lines.push('| Metric | Value |');
			lines.push('|--------|-------|');
			lines.push(`| Entities | ${result.statistics.totalEntities} |`);
			lines.push(`| Fields | ${result.statistics.totalFields} |`);
			lines.push(`| Relationships | ${result.statistics.totalRelationships} |`);
			lines.push(
				`| Avg Fields/Entity | ${result.statistics.averageFieldsPerEntity.toFixed(1)} |`
			);
			lines.push('');

			lines.push('## Field Types');
			lines.push('');
			lines.push('| Type | Count |');
			lines.push('|------|-------|');
			for (const [type, count] of Object.entries(result.statistics.fieldsByType).sort(
				(a, b) => b[1] - a[1]
			)) {
				lines.push(`| ${type} | ${count} |`);
			}

			if (result.statistics.totalRelationships > 0) {
				lines.push('');
				lines.push('## Relationship Types');
				lines.push('');
				lines.push('| Type | Count |');
				lines.push('|------|-------|');
				for (const [type, count] of Object.entries(
					result.statistics.relationshipsByType
				).sort((a, b) => b[1] - a[1])) {
					lines.push(`| ${type} | ${count} |`);
				}
			}

			return lines.join('\n');
		}

		case 'console':
		default: {
			const consoleLines: string[] = [];
			consoleLines.push('');
			consoleLines.push('\x1b[1m\x1b[36mDomain Statistics\x1b[0m');
			consoleLines.push('');
			consoleLines.push(`   Entities:        ${result.statistics.totalEntities}`);
			consoleLines.push(
				`   Fields:          ${result.statistics.totalFields} (avg ${result.statistics.averageFieldsPerEntity.toFixed(1)}/entity)`
			);
			consoleLines.push(`   Relationships:   ${result.statistics.totalRelationships}`);
			consoleLines.push('');

			consoleLines.push('   Field types:');
			for (const [type, count] of Object.entries(result.statistics.fieldsByType).sort(
				(a, b) => b[1] - a[1]
			)) {
				const bar = '\x1b[34m' + '|'.repeat(Math.min(count, 20)) + '\x1b[0m';
				consoleLines.push(`     ${type.padEnd(12)} ${bar} ${count}`);
			}

			if (result.statistics.totalRelationships > 0) {
				consoleLines.push('');
				consoleLines.push('   Relationship types:');
				for (const [type, count] of Object.entries(
					result.statistics.relationshipsByType
				).sort((a, b) => b[1] - a[1])) {
					const bar = '\x1b[35m' + '|'.repeat(Math.min(count, 20)) + '\x1b[0m';
					consoleLines.push(`     ${type.padEnd(12)} ${bar} ${count}`);
				}
			}

			consoleLines.push('');
			return consoleLines.join('\n');
		}
	}
}

async function runAnalysisCommand(
	command: string,
	entitiesDir: string,
	options: {
		format: OutputFormat;
		output?: string;
		strict: boolean;
		entity?: string;
	}
) {
	console.log(`\nAnalyzing domain in ${entitiesDir}...\n`);

	// Run analysis
	const result = await analyzeDomain(entitiesDir);

	// Filter by entity if specified
	let filteredResult = result;
	if (options.entity) {
		const entity = result.entities.find((e) => e.name === options.entity);
		if (!entity) {
			console.error(`Error: Entity "${options.entity}" not found`);
			console.error(
				`Available entities: ${result.entities.map((e) => e.name).join(', ')}`
			);
			process.exit(1);
		}
		filteredResult = {
			...result,
			entities: [entity],
			issues: result.issues.filter(
				(i) => i.entity === options.entity || !i.entity
			),
		};
	}

	// Format output
	let output: string;

	switch (command) {
		case 'validate':
			output = formatValidateOutput(filteredResult, options.format);
			break;

		case 'analyze':
		case 'doc':
			output = formatAnalyzeOutput(filteredResult, options.format);
			break;

		case 'stats':
			output = formatStatsOutput(filteredResult, options.format);
			break;

		default:
			console.error(`Error: Unknown command: ${command}`);
			console.log(USAGE);
			process.exit(1);
	}

	// Write output
	if (options.output) {
		writeFileSync(options.output, output);
		console.log(`Output written to ${options.output}`);
	} else {
		console.log(output);
	}

	// Determine exit code
	const hasErrors = filteredResult.issues.some((i) => i.severity === 'error');
	const hasWarnings = filteredResult.issues.some((i) => i.severity === 'warning');

	if (hasErrors) {
		process.exit(1);
	}
	if (options.strict && hasWarnings) {
		process.exit(1);
	}
	process.exit(0);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			help: { type: 'boolean', short: 'h' },
			format: { type: 'string', short: 'f', default: 'console' },
			output: { type: 'string', short: 'o' },
			strict: { type: 'boolean', short: 's' },
			entity: { type: 'string', short: 'e' },
			verbose: { type: 'boolean', short: 'v' },
			// Directory overrides
			'entities-dir': { type: 'string' },
			// Manifest options
			force: { type: 'boolean' },
			accept: { type: 'string' },
			skip: { type: 'string' },
			'accept-all': { type: 'boolean' },
			'skip-all': { type: 'boolean' },
		},
		allowPositionals: true,
	});

	if (values.help || positionals.length === 0) {
		console.log(USAGE);
		process.exit(0);
	}

	const command = positionals[0];
	const arg = positionals[1];

	// Determine format, with special handling for 'doc' command
	let format = (values.format ?? 'console') as OutputFormat;
	if (command === 'doc') {
		format = 'markdown';
	}

	switch (command) {
		// Generation commands
		case 'entity':
			if (!arg) {
				console.error('[FAIL] Missing YAML file path');
				console.log(USAGE);
				process.exit(1);
			}
			if (!generateEntity(arg)) {
				process.exit(1);
			}
			break;

		case 'all':
			generateAll(values['entities-dir']);
			break;

		case 'broadcast':
			if (!generateBroadcast(arg)) {
				process.exit(1);
			}
			break;

		case 'scan':
			await runScanCommand(arg || '.', values.verbose ?? false);
			break;

		// Manifest commands
		case 'manifest': {
			const projectConfig = getProjectConfig();
			const entitiesDir = values['entities-dir']
				|| process.env.CODEGEN_ENTITIES_DIR
				|| projectConfig?.paths?.entities_dir
				|| arg
				|| 'entities';
			await runManifestCommand(entitiesDir, {
				force: values.force ?? false,
			});
			break;
		}

		case 'suggestions':
			await runSuggestionsCommand({
				accept: values.accept,
				skip: values.skip,
				acceptAll: values['accept-all'],
				skipAll: values['skip-all'],
			});
			break;

		// Analysis commands
		case 'validate':
		case 'analyze':
		case 'stats':
		case 'doc':
			if (!arg) {
				console.error('Error: Missing entities directory\n');
				console.log(USAGE);
				process.exit(1);
			}
			await runAnalysisCommand(command, arg, {
				format,
				output: values.output,
				strict: values.strict ?? false,
				entity: values.entity,
			});
			break;

		default:
			console.error(`[FAIL] Unknown command: ${command}`);
			console.log(USAGE);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
