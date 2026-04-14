/**
 * Pane primitives — border + content + optional footer.
 *
 * Nouns own the content layout; the pane module owns border, padding, and footer.
 * No-op in JSON mode.
 */

import { theme } from './theme.js';
import { isJsonMode } from './json.js';

export interface PaneOutput {
	title: string;
	body: string | string[];
	footer?: string;
}

function stripAnsi(s: string): string {
	// strip ANSI escape sequences for width calculations
	return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function renderPane(pane: PaneOutput): void {
	if (isJsonMode()) return;

	const cols = process.stdout.columns ?? 80;
	const width = Math.min(Math.max(40, cols), 80);
	const titleLen = stripAnsi(pane.title).length;
	const dashes = Math.max(0, width - titleLen - 5);
	const top = '┌─ ' + pane.title + ' ' + '─'.repeat(dashes) + '┐';
	const bot = '└' + '─'.repeat(Math.max(2, width - 2)) + '┘';

	console.log(theme.muted(top));
	const lines = Array.isArray(pane.body) ? pane.body : pane.body.split('\n');
	for (const line of lines) {
		console.log('  ' + line);
	}
	if (pane.footer) {
		console.log('');
		console.log(theme.muted('  ' + pane.footer));
	}
	console.log(theme.muted(bot));
}
