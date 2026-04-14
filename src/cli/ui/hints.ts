/**
 * Hint row — suggested next commands rendered under a summary pane.
 *
 * No-op in JSON mode (nouns emit hints in the JSON payload instead).
 */

import { theme } from './theme.js';
import { isJsonMode } from './json.js';

export interface Hint {
	command: string;
	description: string;
}

export function renderHints(hints: Hint[]): void {
	if (isJsonMode()) return;
	if (hints.length === 0) return;

	console.log('');
	console.log(theme.muted('  Next:'));
	const maxCmd = Math.max(...hints.map((h) => h.command.length));
	for (const h of hints) {
		const pad = ' '.repeat(maxCmd - h.command.length + 2);
		console.log(`    ${theme.system(h.command)}${pad}${theme.muted(h.description)}`);
	}
}
