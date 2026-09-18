/**
 * App-pattern discovery globs for the CLI process.
 *
 * `codegen.config.yaml patterns:` when set, else the ADR-031 default. The hygen
 * subprocess reads the same key in `templates/entity/new/prompt.js`; the CLI
 * process needs it too, because it now validates things that depend on app
 * patterns before hygen ever runs (CAP-2's roles pre-flight, `entity validate`).
 */

// Side effect: registers the library patterns. They must be in the registry
// BEFORE app patterns load — the loader refuses an app pattern that reuses a
// library name (ADR-041.1), and the roles validators resolve the library
// `Actor` / `Communication` capabilities by name.
import '../../patterns/library/index.js';
import { loadAppPatterns } from '../../patterns/registry.js';
import type { Context } from './context.js';

export const DEFAULT_PATTERN_GLOBS = ['src/patterns/*.pattern.ts'];

export function resolvePatternGlobs(ctx: Context): string[] {
	// Same rule as `templates/entity/new/prompt.js`: an empty list is the default.
	const fromConfig = ctx.config?.patterns ?? [];
	return fromConfig.length > 0 ? fromConfig : DEFAULT_PATTERN_GLOBS;
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
