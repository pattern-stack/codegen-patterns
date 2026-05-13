#!/usr/bin/env node
/**
 * codegen — root CLI entry point.
 *
 * Registers every noun module with a single Clipanion Cli instance. Each
 * noun contributes its Command classes plus an auto-generated zero-verb
 * summary command (see {@link noun-module.ts}).
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
import entityNoun from './commands/entity.js';
import subsystemNoun from './commands/subsystem.js';
import projectNoun from './commands/project.js';
import devNoun from './commands/dev.js';
import relationshipNoun from './commands/relationship.js';
import junctionNoun from './commands/junction.js';
import eventsNoun from './commands/events.js';
import orchestrationNoun from './commands/orchestration.js';
import initShortcut from './shortcuts/init.js';

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
			{ command: 'codegen dev', description: 'Dev environment status + controls' },
		]);
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Registry — every noun module is statically imported. Static imports are
// resolved by the bundler (tsup) and at module-init by Node, so a failure
// here crashes the CLI loudly with the real error rather than silently
// dropping a noun (the failure mode that produced #272 / #269).
// ---------------------------------------------------------------------------

const nouns: NounModule[] = [
	entityNoun,
	subsystemNoun,
	projectNoun,
	devNoun,
	relationshipNoun,
	junctionNoun,
	eventsNoun,
	orchestrationNoun,
];

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	// Detect --json early so UI helpers short-circuit from the first call.
	const argv = process.argv.slice(2);
	if (argv.includes('--json')) setJsonMode(true);

	const cli = new Cli({
		binaryLabel: 'codegen',
		binaryName: 'codegen',
		binaryVersion: readVersion(),
	});

	cli.register(Builtins.HelpCommand);
	cli.register(Builtins.VersionCommand);
	cli.register(RootSummaryCommand);

	cli.register(initShortcut);

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
