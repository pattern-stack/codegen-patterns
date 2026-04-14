/**
 * NounModule abstraction — see ADR-015 and SPEC-CLI-01.
 *
 * Each CLI noun (entity, subsystem, project, manifest) exports a NounModule.
 * The root CLI registers each noun's command classes and builds a zero-verb
 * summary command on the fly via {@link buildNounSummaryCommand}.
 */

import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';
import type { Context } from './shared/context.js';
import { loadContext } from './shared/context.js';
import { renderPane, type PaneOutput } from './ui/pane.js';
import { renderHints, type Hint } from './ui/hints.js';
import { isJsonMode, printJson, setJsonMode } from './ui/json.js';

export type { PaneOutput } from './ui/pane.js';
export type { Hint } from './ui/hints.js';

export interface NounModule {
	name: string;
	commandClasses: Array<CommandClass>;
	summary(ctx: Context): Promise<PaneOutput>;
	hints(ctx: Context): Promise<Hint[]>;
}

/**
 * Build a Clipanion Command class whose path is `[[noun.name]]`. Loads the
 * shared Context, renders the noun's summary + hints (or emits JSON).
 */
export function buildNounSummaryCommand(noun: NounModule): CommandClass {
	class NounSummaryCommand extends Command {
		static paths = [[noun.name]];
		static usage = Command.Usage({
			description: `Show ${noun.name} summary and suggested next commands`,
		});

		json = Option.Boolean('--json', false);
		cwd = Option.String('--cwd', { required: false });
		configPath = Option.String('--config', { required: false });
		verbose = Option.Boolean('--verbose,-v', false);

		async execute(): Promise<number> {
			if (this.json) setJsonMode(true);
			const ctx = await loadContext({
				cwd: this.cwd,
				configPath: this.configPath,
				json: this.json,
				verbose: this.verbose,
			});
			const [pane, hints] = await Promise.all([noun.summary(ctx), noun.hints(ctx)]);

			if (isJsonMode()) {
				printJson({ noun: noun.name, summary: pane, hints });
				return 0;
			}
			renderPane(pane);
			renderHints(hints);
			return 0;
		}
	}

	// Preserve a descriptive class name for debugging + Clipanion introspection.
	Object.defineProperty(NounSummaryCommand, 'name', {
		value: `${noun.name[0].toUpperCase()}${noun.name.slice(1)}SummaryCommand`,
	});
	return NounSummaryCommand as CommandClass;
}
