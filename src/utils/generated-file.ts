/**
 * Generated files the app imports are not optional output (JOBS-0, #655).
 *
 * `<generated>/modules.ts`, `schema.ts`, `subsystems.ts`, `subsystems-schema.ts`
 * and `app-config.ts` (plus the registry / events stubs `subsystems.ts` imports)
 * are imported by `app.module.ts`, `main.ts`, `worker.ts` and the Drizzle
 * schema wiring. A failed regeneration leaves them missing or stale, so it
 * fails the command — non-zero, naming the file — instead of printing a
 * warning and exiting 0.
 *
 * JOBS-1 (#660) extends the contract to every `entity new` post-step: the
 * scope-entity-type union, event codegen, the bridge registry, orchestration
 * modules, the frontend tree, and the provider / adapter / assembly / job
 * handler emitters.
 *
 * The error type and the step wrapper live here (no CLI dependency) so the
 * TS emitters (`src/emitters/`) wrap their own writes; the CLI's reporter is
 * `src/cli/shared/generated-file.ts` › `reportRegenerationFailure`.
 */

/** A generated file could not be (re)written; `file` is its absolute path. */
export class GeneratedFileError extends Error {
	constructor(
		readonly file: string,
		cause: unknown,
	) {
		super(`could not regenerate ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, {
			cause,
		});
		this.name = 'GeneratedFileError';
	}
}

/**
 * Run one file's build-and-write step; any failure — a throw, or a rejection
 * when the step is async — is rethrown as a {@link GeneratedFileError} naming
 * `file`. A `GeneratedFileError` from a nested step passes through, so the
 * innermost file that failed is the one reported (JOBS-1, #660: a multi-file
 * step names its output root, each write inside it names its own file).
 */
export function generating<T>(file: string, step: () => T): T {
	const rethrow = (err: unknown): never => {
		throw err instanceof GeneratedFileError ? err : new GeneratedFileError(file, err);
	};
	try {
		const out = step();
		return (out instanceof Promise ? out.catch(rethrow) : out) as T;
	} catch (err: unknown) {
		return rethrow(err);
	}
}
