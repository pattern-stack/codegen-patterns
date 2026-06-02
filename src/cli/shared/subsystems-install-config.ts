/**
 * Maintain the `subsystems.install` list in `codegen.config.yaml`.
 *
 * In `runtime: package` mode (ADR-037) the install list IS the source of truth
 * for "which subsystems are installed" — nothing is vendored on disk. So
 * `codegen subsystem install <name>` must record the name here. This helper
 * does a parse-aware read + a minimal, format-preserving text edit (it does NOT
 * re-serialize the whole file — that would clobber the user's comments and
 * key ordering, which the per-subsystem config-block templates rely on).
 *
 * Outcomes:
 *   - `added`         — the name was appended to an existing/created list.
 *   - `already`       — the name was already present (idempotent no-op).
 *   - `parse-error`   — the YAML didn't parse; caller must bail.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

export type InstallListOutcome = 'added' | 'already' | 'parse-error';

export interface EnsureInstalledResult {
	outcome: InstallListOutcome;
	/** The full install list AFTER the edit (empty on parse-error). */
	install: string[];
}

/**
 * Read the current `subsystems.install` list from a parsed config object.
 * Tolerant: returns `[]` when the block is absent or malformed.
 */
export function readInstallList(
	config: Record<string, unknown> | null | undefined,
): string[] {
	const raw = (config as { subsystems?: { install?: unknown } } | null | undefined)
		?.subsystems?.install;
	if (!Array.isArray(raw)) return [];
	return raw.filter((e): e is string => typeof e === 'string');
}

/**
 * Ensure `name` is present in `subsystems.install` in the YAML at `configPath`,
 * writing the file in place if an edit is needed. Format-preserving:
 *
 *   - install list exists → append `  - <name>` after the last list item.
 *   - `subsystems:` exists but no `install:` → append an `install:` block under it.
 *   - neither exists → append a fresh `subsystems:\n  install:\n    - <name>` block.
 *   - no file → create one with the block.
 *
 * Detection of the current list is parse-aware (handles comments / quoting);
 * the WRITE is a targeted text insertion using the YAML AST's source ranges so
 * surrounding content is untouched.
 */
export function ensureSubsystemInstalled(
	configPath: string,
	name: string,
): EnsureInstalledResult {
	if (!fs.existsSync(configPath)) {
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(
			configPath,
			`subsystems:\n  install:\n    - ${name}\n`,
			'utf-8',
		);
		return { outcome: 'added', install: [name] };
	}

	const source = fs.readFileSync(configPath, 'utf-8');
	let doc: ReturnType<typeof yaml.parseDocument>;
	try {
		doc = yaml.parseDocument(source);
		if (doc.errors.length > 0) {
			return { outcome: 'parse-error', install: [] };
		}
	} catch {
		return { outcome: 'parse-error', install: [] };
	}

	const current = readInstallList(
		doc.toJS() as Record<string, unknown> | null,
	);
	if (current.includes(name)) {
		return { outcome: 'already', install: current };
	}

	// Use the YAML AST to add the item, then re-stringify ONLY when we have to.
	// To stay format-preserving for the common "append to existing list" case we
	// edit the source text directly via the node's range; for the structural
	// cases (no subsystems: / no install:) we fall back to a doc edit + restring.
	const subsystemsNode = doc.get('subsystems', true) as
		| { get?: (k: string, keep: boolean) => unknown }
		| undefined;
	const installSeq =
		subsystemsNode && typeof subsystemsNode.get === 'function'
			? (subsystemsNode.get('install', true) as
					| { items?: unknown[]; range?: [number, number, number] }
					| undefined)
			: undefined;

	if (
		installSeq &&
		Array.isArray(installSeq.items) &&
		installSeq.items.length > 0
	) {
		// Append after the last list item, matching its indentation.
		const lastItem = installSeq.items[installSeq.items.length - 1] as {
			range?: [number, number, number];
		};
		const range = lastItem.range;
		if (range) {
			const insertAt = range[1];
			// Derive the list-item indentation from the line of the last item.
			const lineStart = source.lastIndexOf('\n', range[0]) + 1;
			const indent = source.slice(lineStart, range[0]).match(/^\s*/)?.[0] ?? '    ';
			const before = source.slice(0, insertAt);
			const after = source.slice(insertAt);
			const next = `${before}\n${indent}- ${name}${after}`;
			fs.writeFileSync(configPath, next, 'utf-8');
			return { outcome: 'added', install: [...current, name] };
		}
	}

	// Structural fallback — let the YAML lib create/extend the block, accepting
	// a re-serialize of just the subsystems mapping. setIn creates intermediate
	// nodes as needed.
	doc.setIn(['subsystems', 'install'], [...current, name]);
	fs.writeFileSync(configPath, String(doc), 'utf-8');
	return { outcome: 'added', install: [...current, name] };
}
