/**
 * App-pattern discovery globs for the CLI process.
 *
 * `codegen.config.yaml patterns:` when set, else the ADR-031 default. The hygen
 * subprocess reads the same key in `templates/entity/new/prompt.js`; the CLI
 * process needs it too, because it now validates things that depend on app
 * patterns before hygen ever runs (CAP-2's roles pre-flight, `entity validate`).
 */

import { loadAppPatterns } from '../../patterns/registry.js';
import type { Context } from './context.js';

export const DEFAULT_PATTERN_GLOBS = ['src/patterns/*.pattern.ts'];

export function resolvePatternGlobs(ctx: Context): string[] {
	const fromConfig = (ctx.config as { patterns?: unknown } | null | undefined)?.patterns;
	if (Array.isArray(fromConfig) && fromConfig.length > 0) {
		return fromConfig.filter((g): g is string => typeof g === 'string');
	}
	return DEFAULT_PATTERN_GLOBS;
}

/**
 * Load the project's app patterns into THIS process's registry.
 *
 * The hygen subprocess loads them for itself; the CLI process must too before
 * anything that resolves a pattern by name — `validatePatternComposition`,
 * and CAP-2's roles validators (a role's target qualifies by declaring an
 * `Actor` capability, which a project may define). Every CLI path that runs
 * those validators calls this, so it has one implementation. Returns the
 * loader's per-file errors for the caller to print.
 */
export async function loadAppPatternsForCli(ctx: Context): Promise<string[]> {
	const { errors } = await loadAppPatterns(resolvePatternGlobs(ctx), ctx.cwd);
	return errors;
}
