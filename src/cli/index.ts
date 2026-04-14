#!/usr/bin/env bun
/**
 * codegen — root CLI entry point.
 *
 * Registers every noun module with a single Clipanion Cli instance. Each
 * noun contributes its Command classes plus an auto-generated zero-verb
 * summary command (see {@link noun-module.ts}).
 *
 * The transition plan: this binary runs alongside the legacy `src/cli.ts`
 * until all nouns are migrated. `package.json` `bin.codegen` only flips to
 * this file once enough nouns are in place.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Builtins, Cli, Command } from 'clipanion';
import { buildNounSummaryCommand, type NounModule } from './noun-module.js';
import { setJsonMode } from './ui/json.js';
import { loadContext } from './shared/context.js';
import { renderPane } from './ui/pane.js';
import { renderHints } from './ui/hints.js';
import { theme } from './ui/theme.js';
import { icons } from './ui/icons.js';

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

function readVersion(): string {
	try {
		const pkgPath = join(import.meta.dirname, '..', '..', 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

// ---------------------------------------------------------------------------
// Root summary command: `codegen` with no args
// ---------------------------------------------------------------------------

class RootSummaryCommand extends Command {
	static paths = [Command.Default];
	static usage = Command.Usage({
		description: 'Show project status and available noun commands',
	});

	async execute(): Promise<number> {
		const ctx = await loadContext();

		if (!ctx.isInitialized) {
			renderPane({
				title: 'codegen',
				body: [
					'No codegen.config.yaml and no entities/ directory detected.',
					'',
					`  ${theme.muted('Run')} ${theme.system('codegen init')} ${theme.muted(
						'to scaffold a project'
					)}`,
					`  ${theme.muted('Or')} ${theme.system('codegen entity')} ${theme.muted(
						'to see entity-level hints'
					)}`,
				],
			});
			return 0;
		}

		renderPane({
			title: 'codegen',
			body: [
				`${theme.success(icons.check)} project initialized`,
				`  config:      ${ctx.configPath ?? '(none)'}`,
				`  entities:    ${ctx.entityCount}`,
				`  subsystems:  ${ctx.installedSubsystems.length}/4 installed`,
			],
		});
		renderHints([
			{ command: 'codegen entity', description: 'Entity summary + hints' },
			{ command: 'codegen subsystem', description: 'Subsystem summary + hints' },
		]);
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Registry — populated by each phase as nouns are implemented.
// ---------------------------------------------------------------------------

const nouns: NounModule[] = [];

// Phase 2 will push entityNoun here; Phase 3 will push subsystemNoun.
// Dynamic imports avoid pulling in noun code until it exists.
async function loadNouns(): Promise<void> {
	try {
		const mod = await import('./commands/entity.js');
		if (mod?.default) nouns.push(mod.default as NounModule);
	} catch {
		// entity noun not implemented yet
	}
	try {
		const mod = await import('./commands/subsystem.js');
		if (mod?.default) nouns.push(mod.default as NounModule);
	} catch {
		// subsystem noun not implemented yet
	}
	try {
		const mod = await import('./commands/project.js');
		if (mod?.default) nouns.push(mod.default as NounModule);
	} catch {
		// project noun not implemented yet
	}
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	// Detect --json early so UI helpers short-circuit from the first call.
	const argv = process.argv.slice(2);
	if (argv.includes('--json')) setJsonMode(true);

	await loadNouns();

	const cli = new Cli({
		binaryLabel: 'codegen',
		binaryName: 'codegen',
		binaryVersion: readVersion(),
	});

	cli.register(Builtins.HelpCommand);
	cli.register(Builtins.VersionCommand);
	cli.register(RootSummaryCommand);

	for (const noun of nouns) {
		for (const CommandClass of noun.commandClasses) {
			cli.register(CommandClass);
		}
		cli.register(buildNounSummaryCommand(noun));
	}

	await cli.runExit(argv);
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`${theme.error(icons.error)} ${msg}`);
	process.exit(1);
});
