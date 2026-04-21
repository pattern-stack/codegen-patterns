/**
 * Shared resolver for the subsystems install root.
 *
 * One source of truth for both `subsystem install` (where the runtime files
 * land) and `entity new` (where codegen artifacts like
 * `events/generated/` and `jobs/generated/scope-entity-type.ts` land).
 *
 * Resolution order:
 *   1. explicit `paths.subsystems` in `codegen.config.yaml` (absolute override)
 *   2. `<paths.backend_src>/shared/subsystems` (derived default — matches
 *      where `project init` vendors the protocol files)
 *   3. `src/shared/subsystems` (final fallback when neither is configured —
 *      matches the `project init` default of `backend_src: 'src'`)
 *
 * The two halves (runtime files from `subsystem install`, generated files
 * from `entity new`) MUST resolve to the same tree: imports like
 * `import … from '../events.tokens'` inside a generated `bus.ts` rely on
 * sitting directly under `<root>/events/generated/`.
 */
import path from 'node:path';

import type { CodegenConfig, Context } from './context.js';

/** Default when no config at all is present. Matches `project init`. */
const FALLBACK_BACKEND_SRC = 'src';

/**
 * Compute the subsystems install root from a raw config + cwd. Pure so it
 * can be reused by scaffold-locals resolvers that don't have a full Context.
 *
 * Returns an absolute path.
 */
export function resolveSubsystemsRootFromConfig(
	cwd: string,
	config: CodegenConfig | null,
): string {
	const configured = config?.paths?.subsystems;
	if (typeof configured === 'string' && configured.length > 0) {
		return path.resolve(cwd, configured);
	}
	const backendSrc = config?.paths?.backend_src;
	const base =
		typeof backendSrc === 'string' && backendSrc.length > 0
			? backendSrc
			: FALLBACK_BACKEND_SRC;
	return path.resolve(cwd, base, 'shared', 'subsystems');
}

/**
 * Context-based wrapper used by the CLI commands. Accepts an optional
 * `overrideTarget` (CLI `--target` flag) that takes precedence over both
 * config keys.
 */
export function resolveSubsystemsRoot(
	ctx: Context,
	overrideTarget?: string,
): string {
	if (overrideTarget) return path.resolve(ctx.cwd, overrideTarget);
	return resolveSubsystemsRootFromConfig(ctx.cwd, ctx.config);
}
