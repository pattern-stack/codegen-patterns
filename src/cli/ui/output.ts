/**
 * Semantic output helpers. Commands call these rather than reaching into theme/icons.
 *
 * Errors are truncated at 500 chars in interactive output (matching pts behavior).
 * All helpers no-op in JSON mode.
 */

import { theme } from './theme.js';
import { icons } from './icons.js';
import { isJsonMode } from './json.js';

const MAX_ERROR_LEN = 500;

export function printSuccess(msg: string): void {
	if (isJsonMode()) return;
	console.log(`${theme.success(icons.success)} ${msg}`);
}

export function printError(msg: string): void {
	if (isJsonMode()) return;
	const truncated = msg.length > MAX_ERROR_LEN ? msg.slice(0, MAX_ERROR_LEN) + '…' : msg;
	console.error(`${theme.error(icons.error)} ${truncated}`);
}

export function printWarning(msg: string): void {
	if (isJsonMode()) return;
	console.warn(`${theme.warning(icons.warning)} ${msg}`);
}

export function printInfo(msg: string): void {
	if (isJsonMode()) return;
	console.log(`${theme.system(icons.info)} ${msg}`);
}

export function printMuted(msg: string): void {
	if (isJsonMode()) return;
	console.log(theme.muted(msg));
}
