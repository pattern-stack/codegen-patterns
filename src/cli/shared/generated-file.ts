/**
 * The CLI side of "generated files the app imports are not optional output"
 * (JOBS-0, #655; JOBS-1, #660): a command whose regeneration failed reports the
 * {@link GeneratedFileError} (`src/utils/generated-file.ts`) and exits 1.
 */

import { printError } from '../ui/output.js';
import { isJsonMode, printJson } from '../ui/json.js';
import { GeneratedFileError } from '../../utils/generated-file.js';

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
