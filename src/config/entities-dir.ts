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
 *   2. The directory is the resolved `paths.entities` (its one default,
 *      `entities`, is declared in `PathsConfigSchema` — PATH-0), resolved
 *      against `cwd`. There is no second candidate.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EntitiesDirPaths {
	entities: string;
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

/** The entities directory (absolute), whether or not it exists. */
export function entitiesDirPath(cwd: string, paths: EntitiesDirPaths): string {
	return path.resolve(cwd, paths.entities);
}

/** The entities directory when it exists as a directory, else null. */
export function resolveEntitiesDir(cwd: string, paths: EntitiesDirPaths): string | null {
	const dir = entitiesDirPath(cwd, paths);
	return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}
