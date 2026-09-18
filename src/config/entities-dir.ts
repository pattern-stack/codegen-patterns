/**
 * Where a project's entity YAMLs live — the ONE rule, shared by the CLI
 * (`src/cli/shared/context.ts`) and the hygen prompts
 * (`templates/_shared/entity-naming.mjs`), so `codegen entity new --all` and a
 * prompt resolving a cross-entity reference can never read different
 * directories (charter I1, NAME-0).
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins and other shipped modules.
 *
 *   1. `codegen.config.yaml` is found walking upward from `cwd`.
 *   2. Candidates, in order: `paths.entities`, else `paths.entities_dir`
 *      (resolved against `cwd`), then `<cwd>/entities`.
 *   3. The first candidate that is an existing directory wins; none → null.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EntitiesDirPaths {
	entities?: unknown;
	entities_dir?: unknown;
}

/**
 * Walk upward from `start` looking for a `codegen.config.yaml`. Returns the
 * absolute path or null if none is found before reaching the filesystem root.
 */
export function findConfigUpward(start: string): string | null {
	let dir = path.resolve(start);
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, 'codegen.config.yaml');
		if (fs.existsSync(candidate)) return candidate;
		if (dir === root) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** The directories tried, in order (absolute). */
export function entitiesDirCandidates(cwd: string, paths?: EntitiesDirPaths | null): string[] {
	const configured = [paths?.entities, paths?.entities_dir].find(
		(v): v is string => typeof v === 'string' && v.length > 0,
	);
	const candidates: string[] = [];
	if (configured) candidates.push(path.resolve(cwd, configured));
	const fallback = path.resolve(cwd, 'entities');
	if (!candidates.includes(fallback)) candidates.push(fallback);
	return candidates;
}

/** The first candidate that exists as a directory, else null. */
export function resolveEntitiesDir(cwd: string, paths?: EntitiesDirPaths | null): string | null {
	for (const c of entitiesDirCandidates(cwd, paths)) {
		if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
	}
	return null;
}
