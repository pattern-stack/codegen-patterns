/**
 * Shared resolver for the jobs definition source directory.
 *
 * This is the directory codegen reads `definitions/jobs/*.yaml` from when
 * loading job definitions (RFC-0005). Jobs are opt-in like providers — a
 * project without this directory is valid (the loader returns a non-fatal
 * warning and an empty list).
 *
 * Resolution order:
 *   1. `paths.jobs_dir` in `codegen.config.yaml`
 *   2. `<cwd>/definitions/jobs` fallback (matches the `definitions/providers`
 *      convention; distinct from the bare `events/` legacy path).
 */
import path from 'node:path';

import type { CodegenConfig, Context } from './context.js';

const FALLBACK = 'definitions/jobs';

export function resolveJobsDirFromConfig(
	cwd: string,
	config: CodegenConfig | null,
): string {
	const configured = config?.paths?.jobs_dir;
	if (typeof configured === 'string' && configured.length > 0) {
		return path.resolve(cwd, configured);
	}
	return path.resolve(cwd, FALLBACK);
}

export function resolveJobsDir(ctx: Context): string {
	return resolveJobsDirFromConfig(ctx.cwd, ctx.config);
}
