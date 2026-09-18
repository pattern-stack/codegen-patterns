/**
 * App-pattern discovery globs for the CLI process.
 *
 * `codegen.config.yaml patterns:` (schema default derived from `paths.backend_src`). The hygen
 * subprocess reads the same key in `templates/entity/new/prompt.js`; the CLI
 * process needs it too, because it now validates things that depend on app
 * patterns before hygen ever runs (CAP-2's roles pre-flight, `entity validate`).
 */

// Side effect: registers the library patterns. They must be in the registry
// BEFORE app patterns load — the loader refuses an app pattern that reuses a
// library name (ADR-041.1), and the roles validators resolve the library
// `Actor` / `Communication` capabilities by name.
import '../../patterns/library/index.js';
import path from 'node:path';

import type { AnalysisIssue } from '../../analyzer/types.js';
import { configOrDefaults } from '../../config/project-config.js';
import { loadAppPatterns, type AppPatternLoadError } from '../../patterns/registry.js';
import type { Context } from './context.js';
import type { RunRejection } from './run-rejections.js';

/**
 * The resolved `patterns:` list — the schema fills an absent key with
 * `<backend_src>/patterns/*.pattern.ts` (PATH-1, #645); an explicit `[]` is no
 * app patterns. No reader carries its own default.
 */
export function resolvePatternGlobs(ctx: Context): string[] {
	return configOrDefaults(ctx.config).patterns;
}

/**
 * Load the project's app patterns into THIS process's registry.
 *
 * The hygen subprocess loads them for itself; the CLI process must too before
 * anything that resolves a pattern by name — `validatePatternComposition`,
 * and CAP-2's roles validators (a role's target qualifies by declaring an
 * `Actor` capability, which a project may define). Every CLI path that runs
 * those validators calls this, so it has one implementation. Returns the
 * loader's per-file errors; what they mean is the caller's: a command that
 * writes from the pattern set rejects the run on any
 * ({@link patternLoadRejections} — `entity new`, JOBS-2; `orchestration gen`,
 * CLI-1), a validator reports each as an error ({@link patternLoadIssues}).
 */
export async function loadAppPatternsForCli(ctx: Context): Promise<AppPatternLoadError[]> {
	const { errors } = await loadAppPatterns(resolvePatternGlobs(ctx), ctx.cwd);
	return errors;
}

/**
 * Loader errors → run rejections. Every loader error leaves the pattern set
 * partial (an import failure, an invalid contribution, a duplicate or a
 * library-name reuse all register nothing), so a command that writes from the
 * set stops on any. `file` is absolute (the loader reports it relative to
 * `cwd`, or the glob when expansion failed).
 */
export function patternLoadRejections(errors: AppPatternLoadError[], cwd: string): RunRejection[] {
	return errors.map((err) => ({
		file: path.resolve(cwd, err.file),
		message: 'app pattern file could not be loaded',
		details: [err.message],
	}));
}

/**
 * Loader errors → error-severity analysis issues, for the validators
 * (`entity validate`, `project inspect --kind analyze|stats|doc`): a partial
 * registry misjudges every entity naming the lost pattern, so the run is not
 * valid — the issue is printed and carried in `--json` with the others, and
 * the command's error rule decides the exit code (CLI-1, #667).
 */
export function patternLoadIssues(errors: AppPatternLoadError[], cwd: string): AnalysisIssue[] {
	return errors.map((err) => ({
		severity: 'error' as const,
		type: 'app_pattern_load_failed',
		path: path.resolve(cwd, err.file),
		message: err.message,
	}));
}
