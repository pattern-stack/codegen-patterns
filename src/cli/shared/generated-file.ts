/**
 * Generated files the app imports are not optional output (JOBS-0, #655).
 *
 * `<generated>/modules.ts`, `schema.ts`, `subsystems.ts`, `subsystems-schema.ts`
 * and `app-config.ts` (plus the registry / events stubs `subsystems.ts` imports)
 * are imported by `app.module.ts`, `main.ts`, `worker.ts` and the Drizzle
 * schema wiring. A failed regeneration leaves them missing or stale, so it
 * fails the command — non-zero, naming the file — instead of printing a
 * warning and exiting 0.
 */

import { printError } from '../ui/output.js';
import { isJsonMode, printJson } from '../ui/json.js';

/** A generated file could not be (re)written; `file` is its absolute path. */
export class GeneratedFileError extends Error {
	constructor(
		readonly file: string,
		cause: unknown,
	) {
		super(`could not regenerate ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, {
			cause,
		});
		this.name = 'GeneratedFileError';
	}
}

/**
 * Run one file's build-and-write step; any failure is rethrown as a
 * {@link GeneratedFileError} naming `file`.
 */
export function generating<T>(file: string, step: () => T): T {
	try {
		return step();
	} catch (err: unknown) {
		throw err instanceof GeneratedFileError ? err : new GeneratedFileError(file, err);
	}
}

/**
 * Report a failed regeneration for `command` and return its exit code (`1`):
 * `printError` in text mode, `{ command, status: 'error', file, error }` in
 * JSON mode.
 */
export function reportRegenerationFailure(command: string, err: unknown): 1 {
	const error = err instanceof Error ? err.message : String(err);
	if (isJsonMode()) {
		printJson({
			command,
			status: 'error',
			file: err instanceof GeneratedFileError ? err.file : null,
			error,
		});
	} else {
		printError(error);
	}
	return 1;
}
