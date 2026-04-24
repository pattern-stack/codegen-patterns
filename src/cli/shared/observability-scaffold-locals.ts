/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/observability/`.
 *
 * OBS-7: `subsystem install observability` invokes a LEAN / combiner-shaped
 * scaffold (ADR-025). Unlike events / jobs / sync / bridge, observability:
 *   - has NO schema (combiner is a read-path aggregator; no new tables)
 *   - has NO worker (no background execution)
 *   - has NO generated/ dir (no codegen artifacts — the module composes
 *     sibling read ports via @Optional() DI at boot)
 *
 * The two templates this steers:
 *   - `codegen-config-observability-block.ejs.t` — appends the
 *     `observability:` block with `reporters.bridgeMetrics` placeholder
 *     keys (OBS-6 consumes them; phase-1 `ObservabilityModule.forRoot()`
 *     ignores the block).
 *   - `main-hook.ejs.t` — appends a COMMENT BLOCK to the consumer's
 *     `app.module.ts` directing the human to wire
 *     `ObservabilityModule.forRoot()` AFTER Events/Jobs/Bridge/Sync.
 *     Deliberately NOT a regex-injection: module order matters for a
 *     combiner, and a wrong-place inject is worse than a clear TODO.
 *
 * This module is filesystem-unaware except via injected probes — callers
 * pass `fileExists(p)` rather than us reaching for `node:fs` directly. That
 * keeps the unit test suite pure (see cli/observability-scaffold-locals.test.ts).
 */
import path from 'node:path';

import type { CodegenConfig } from './context.js';

/** Default when `paths.backend_src` is unset. Matches `project init`. */
const FALLBACK_BACKEND_SRC = 'src';

export interface ObservabilityScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/**
	 * Absolute path to the consumer's `app.module.ts`. `main-hook.ejs.t`
	 * appends a TODO comment block here.
	 */
	appModulePath: string;
	/** Where `codegen-config-observability-block.ejs.t` appends the `observability:` block. */
	configPath: string;
	/**
	 * Reserved for OBS-6 — surfaces whether
	 * `observability.reporters.bridgeMetrics.enabled` is already `true` in
	 * the user's config. Phase-1 templates don't consume it; kept so the
	 * locals shape stays stable once OBS-6 lands.
	 */
	bridgeMetricsEnabled: boolean;
}

export interface ObservabilityScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
	/** Injected fs probe. Implementations: `(p) => fs.existsSync(p)`. */
	fileExists: (absolutePath: string) => boolean;
}

/**
 * Resolve all Hygen locals for `subsystem install observability` from
 * config + cwd.
 *
 * - `appModulePath` resolves to `<cwd>/<paths.backend_src>/app.module.ts`
 *   when `paths.backend_src` is set (e.g. `packages/api/src`), falling
 *   back to `<cwd>/src/app.module.ts`. Hygen's `inject: append: true`
 *   tolerates a missing target (appends to an empty file), so we don't
 *   gate on `fileExists` here.
 * - `observability.reporters.bridgeMetrics.enabled` defaults to `false`
 *   when absent. Only the literal `true` flips the flag — defends
 *   against YAML truthy surprises like `'yes'` / `1`.
 */
export function resolveObservabilityScaffoldLocals(
	input: ObservabilityScaffoldLocalsInput,
): ObservabilityScaffoldLocals {
	const { cwd, config } = input;
	void input.fileExists;

	const backendSrc =
		typeof config?.paths?.backend_src === 'string' &&
		config.paths.backend_src.length > 0
			? config.paths.backend_src
			: FALLBACK_BACKEND_SRC;

	const appModulePath = path.resolve(cwd, backendSrc, 'app.module.ts');
	const configPath = path.resolve(cwd, 'codegen.config.yaml');

	const obsBlock = (config?.observability ?? {}) as Record<string, unknown>;
	const reporters = (obsBlock.reporters ?? {}) as Record<string, unknown>;
	const bridgeMetrics = (reporters.bridgeMetrics ?? {}) as Record<
		string,
		unknown
	>;

	return {
		appName: path.basename(cwd),
		appModulePath,
		configPath,
		bridgeMetricsEnabled: bridgeMetrics.enabled === true,
	};
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes.
 * Booleans become `'true'` / `'false'`; paths are forwarded as absolute so
 * Hygen's `to:` front-matter resolves relative to them, not Hygen's `cwd`.
 */
export function localsToHygenArgs(
	locals: ObservabilityScaffoldLocals,
): string[] {
	return [
		'--appName', locals.appName,
		'--appModulePath', locals.appModulePath,
		'--configPath', locals.configPath,
		'--bridgeMetricsEnabled', locals.bridgeMetricsEnabled ? 'true' : 'false',
	];
}
