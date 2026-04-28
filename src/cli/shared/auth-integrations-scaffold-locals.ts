/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/auth-integrations/`.
 *
 * #287: `subsystem install auth-integrations` is a *vendor-the-starter* flow.
 * Unlike every other subsystem, the source isn't `runtime/subsystems/<name>/`
 * — it's `examples/auth-integrations/`. The CLI does the file copies
 * directly (full-file copies, not template injects) and only invokes Hygen
 * for the single TODO comment block appended to `app.module.ts`.
 *
 * The Hygen template this folder steers:
 *   - `app-module-hook.ejs.t` — appends a TODO comment block directing the
 *     human to register `IntegrationsAuthModule` AFTER `AuthModule.forRoot`.
 *
 * Files vendored *outside* of Hygen (handled by `runAuthIntegrationsScaffold`
 * in subsystem.ts):
 *   - `examples/auth-integrations/runtime/integrations/**` →
 *     `<sharedRoot>/integrations/**` (preserves `use-cases/` subdir).
 *   - `examples/auth-integrations/definitions/entities/integration.yaml` →
 *     `<definitionsPath>` (the consumer's entity-yaml dir).
 *
 * `authModuleRegistered` surfaces whether `AuthModule.forRoot` is already in
 * the consumer's `app.module.ts`. The CLI emits a warning when false —
 * `IntegrationsAuthModule` depends on `ENCRYPTION_KEY` from `AuthModule`.
 *
 * This module is filesystem-unaware except via injected probes — callers
 * pass `fileExists(p)` and `readFile(p)` rather than us reaching for
 * `node:fs` directly. That keeps the unit test suite pure
 * (see cli/auth-integrations-scaffold-locals.test.ts).
 */
import path from 'node:path';

import type { CodegenConfig } from './context.js';

/** Default when `paths.backend_src` is unset. Matches `project init`. */
const FALLBACK_BACKEND_SRC = 'src';

/**
 * Default vendor-into directory for the integrations adapters when
 * `paths.shared` is unset. Resolves under `<paths.backend_src>/shared`.
 */
const SHARED_DIR_NAME = 'shared';

/**
 * Default entity-yaml directory for the vendored `integration.yaml`.
 * Spec'd as `definitions/entities/` in #287 (the convention the
 * `examples/auth-integrations` starter ships with). Overridable via
 * `paths.entities` (or legacy `paths.entities_dir`) in
 * `codegen.config.yaml` if the consumer keeps their yaml elsewhere.
 */
const DEFAULT_DEFINITIONS_DIR = 'definitions/entities';

export interface AuthIntegrationsScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Where `app-module-hook.ejs.t` appends the IntegrationsAuthModule TODO. */
	appModulePath: string;
	/**
	 * Where the integrations adapters land — `<sharedRoot>/integrations/...`.
	 * Resolves from `paths.shared` if set, else `<paths.backend_src>/shared`.
	 */
	sharedRoot: string;
	/**
	 * Where the vendored `integration.yaml` lands. Resolves from
	 * `paths.definitions` if set, else `<cwd>/definitions/entities/integration.yaml`.
	 */
	definitionsPath: string;
	/**
	 * True iff the consumer's `app.module.ts` already contains
	 * `AuthModule.forRoot`. Drives a warning print in the CLI — the
	 * `IntegrationsAuthModule` requires `ENCRYPTION_KEY` from `AuthModule`.
	 */
	authModuleRegistered: boolean;
}

export interface AuthIntegrationsScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
	/** Injected fs probe. Implementations: `(p) => fs.existsSync(p)`. */
	fileExists: (absolutePath: string) => boolean;
	/** Injected file reader; returns null when missing. */
	readFile: (absolutePath: string) => string | null;
}

/**
 * Resolve all Hygen locals for `subsystem install auth-integrations` from
 * config + cwd.
 *
 * - `appModulePath` resolves to `<cwd>/<paths.backend_src>/app.module.ts`,
 *   falling back to `<cwd>/src/app.module.ts`.
 * - `sharedRoot` resolves to `<cwd>/<paths.shared>` if set, else
 *   `<cwd>/<paths.backend_src>/shared`. The integrations adapters land
 *   under `<sharedRoot>/integrations/`.
 * - `definitionsPath` resolves to `<cwd>/<paths.entities>/integration.yaml`
 *   (or legacy `<cwd>/<paths.entities_dir>/integration.yaml`) if set,
 *   else `<cwd>/definitions/entities/integration.yaml`. (The
 *   `examples/auth-integrations/definitions/entities/integration.yaml`
 *   convention.)
 * - `authModuleRegistered` is detected by reading `app.module.ts` and
 *   substring-checking for `AuthModule.forRoot`. False positives (a
 *   commented-out import) are acceptable: the warning is a hint, not a
 *   gate.
 */
export function resolveAuthIntegrationsScaffoldLocals(
	input: AuthIntegrationsScaffoldLocalsInput,
): AuthIntegrationsScaffoldLocals {
	const { cwd, config } = input;

	const backendSrc =
		typeof config?.paths?.backend_src === 'string' &&
		config.paths.backend_src.length > 0
			? config.paths.backend_src
			: FALLBACK_BACKEND_SRC;

	const sharedConfigured = (config?.paths as Record<string, unknown> | undefined)
		?.shared;
	const sharedRoot =
		typeof sharedConfigured === 'string' && sharedConfigured.length > 0
			? path.resolve(cwd, sharedConfigured)
			: path.resolve(cwd, backendSrc, SHARED_DIR_NAME);

	// Honor the consumer's configured entity-yaml directory. Order matches
	// `Context.entitiesDir` resolution: `paths.entities` first, then legacy
	// `paths.entities_dir`. (Older `paths.definitions` is NOT a real key and
	// was a hotfix-fixed bug — #303.)
	const pathsRaw = config?.paths as Record<string, unknown> | undefined;
	const entitiesConfigured =
		typeof pathsRaw?.entities === 'string' && pathsRaw.entities.length > 0
			? pathsRaw.entities
			: typeof pathsRaw?.entities_dir === 'string' &&
				  pathsRaw.entities_dir.length > 0
				? pathsRaw.entities_dir
				: null;
	const definitionsPath =
		entitiesConfigured !== null
			? path.resolve(cwd, entitiesConfigured, 'integration.yaml')
			: path.resolve(cwd, DEFAULT_DEFINITIONS_DIR, 'integration.yaml');

	const appModulePath = path.resolve(cwd, backendSrc, 'app.module.ts');

	let authModuleRegistered = false;
	const appModuleSource = input.readFile(appModulePath);
	if (appModuleSource && appModuleSource.includes('AuthModule.forRoot')) {
		authModuleRegistered = true;
	}

	return {
		appName: path.basename(cwd),
		appModulePath,
		sharedRoot,
		definitionsPath,
		authModuleRegistered,
	};
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes. Only
 * the locals consumed by the (single) Hygen template are forwarded; the
 * vendor-copy paths (`sharedRoot`, `definitionsPath`) are consumed directly
 * by `runAuthIntegrationsScaffold` in subsystem.ts.
 */
export function localsToHygenArgs(
	locals: AuthIntegrationsScaffoldLocals,
): string[] {
	return [
		'--appName', locals.appName,
		'--appModulePath', locals.appModulePath,
	];
}
