/**
 * Shared resolver for the events source directory.
 *
 * This is the directory codegen reads top-level `events/*.yaml` from when
 * merging the event registry during `entity new`. Distinct from the
 * subsystems root (where `events/generated/` is written).
 *
 * Resolution order:
 *   1. `paths.events_dir` in `codegen.config.yaml`
 *   2. `<cwd>/events` fallback
 */
import path from 'node:path';

import type { CodegenConfig, Context } from './context.js';

const FALLBACK = 'events';

export function resolveEventsDirFromConfig(
	cwd: string,
	config: CodegenConfig | null,
): string {
	const configured = config?.paths?.events_dir;
	if (typeof configured === 'string' && configured.length > 0) {
		return path.resolve(cwd, configured);
	}
	return path.resolve(cwd, FALLBACK);
}

export function resolveEventsDir(ctx: Context): string {
	return resolveEventsDirFromConfig(ctx.cwd, ctx.config);
}
