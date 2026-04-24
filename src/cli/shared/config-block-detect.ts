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
import { parse as parseYaml, parseDocument } from 'yaml';

export type ConfigBlockState = 'missing' | 'present' | 'parse-error';

export type SubsystemName =
	| 'jobs'
	| 'events'
	| 'cache'
	| 'storage'
	| 'sync'
	| 'bridge'
	| 'openapi'
	| 'observability';

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

/**
 * Remove a subsystem's top-level block from a `codegen.config.yaml` source,
 * returning the rewritten YAML text. Used by the `--force-config` path so
 * the downstream Hygen inject (with `skip_if: "<name>:"`) can re-append a
 * fresh default block without fighting `skip_if`.
 *
 * Uses `yaml@2`'s Document API, which preserves comments and anchors on
 * siblings of the removed key. The returned string is guaranteed to parse
 * cleanly; callers may rely on a downstream `detectConfigBlock` returning
 * 'missing' afterwards.
 *
 * Throws if the source fails to parse. Callers should gate this behind
 * `detectConfigBlock(...) !== 'parse-error'`.
 */
export function stripConfigBlock(
	yamlSource: string,
	subsystem: SubsystemName,
): string {
	const doc = parseDocument(yamlSource);
	if (doc.errors.length > 0) {
		throw new Error(
			`Cannot strip ${subsystem} block: YAML parse errors — ${doc.errors
				.map((e) => e.message)
				.join('; ')}`,
		);
	}
	doc.delete(subsystem);
	return doc.toString();
}
