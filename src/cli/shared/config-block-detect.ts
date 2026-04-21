/**
 * Pure detector for a subsystem's top-level config block inside a
 * `codegen.config.yaml` source string.
 *
 * Filed under #121 (F13). The CLI uses this to decide whether to invoke the
 * `codegen-config-<name>-block.ejs.t` Hygen template on `subsystem install`:
 *
 *   - 'missing'     → inject the default block (first-install behaviour).
 *   - 'present'     → skip the template (default) or overwrite it
 *                     (`--force-config`). Either way, never clobber silently.
 *   - 'parse-error' → refuse to proceed; bail with a clear error.
 *
 * No filesystem access. No YAML mutation. Callers pass in the raw YAML source.
 */
import { parse as parseYaml } from 'yaml';

export type ConfigBlockState = 'missing' | 'present' | 'parse-error';

export type SubsystemName = 'jobs' | 'events' | 'cache' | 'storage';

/**
 * Detect whether a subsystem's top-level config block is present in a
 * `codegen.config.yaml` source string.
 *
 * A block counts as 'present' when the top-level YAML map contains the
 * subsystem's name as a key, regardless of value shape — `jobs:` bare,
 * `jobs: null`, `jobs: {}`, and `jobs:\n  backend: drizzle` all qualify.
 *
 * Commented-out lines (`# jobs:`) and string values that merely *contain*
 * the subsystem name (e.g. a description field that mentions "jobs") do NOT
 * register as present — the check is on top-level keys only.
 *
 * A YAML parse failure returns 'parse-error' rather than throwing so the
 * caller can emit a clean user-facing message and bail.
 */
export function detectConfigBlock(
	yamlSource: string,
	subsystem: SubsystemName,
): ConfigBlockState {
	let parsed: unknown;
	try {
		parsed = parseYaml(yamlSource);
	} catch {
		return 'parse-error';
	}

	// Empty / whitespace-only / comments-only YAML parses to `null` or
	// `undefined` — treated as an empty map with no keys.
	if (parsed === null || parsed === undefined) {
		return 'missing';
	}

	// Non-object roots (top-level scalar or array) — no block possible.
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'missing';
	}

	const map = parsed as Record<string, unknown>;
	return Object.prototype.hasOwnProperty.call(map, subsystem)
		? 'present'
		: 'missing';
}
