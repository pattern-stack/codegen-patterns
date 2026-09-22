/**
 * Where a project's junction YAMLs live — the ONE rule, shared by the CLI
 * (`junction new`, `entity new`'s junction pre-flight, the analyzer) and the
 * hygen prompts (`templates/_shared/junction-fan-out.mjs`), so a junction the
 * CLI validated is the junction a parent's template renders (JUNC-0, #678).
 *
 * There is no config key: `<cwd>/junctions`.
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins and other shipped modules.
 */

import path from 'node:path';

export function junctionsDirFor(cwd: string): string {
	return path.resolve(cwd, 'junctions');
}
