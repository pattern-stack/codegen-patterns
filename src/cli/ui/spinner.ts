/**
 * withStatus — Ora wrapper mirroring pts with_status().
 *
 * No-ops in JSON mode or when stdout is not a TTY; commands always call it
 * without branching on environment.
 */

import ora from 'ora';
import { isJsonMode } from './json.js';

export async function withStatus<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const isTty = Boolean(process.stdout.isTTY);
	if (isJsonMode() || !isTty) {
		return fn();
	}

	const spinner = ora({ text: label, color: 'magenta' }).start();
	try {
		const result = await fn();
		spinner.succeed();
		return result;
	} catch (err) {
		spinner.fail();
		throw err;
	}
}
