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
 *     human to register `ConnectionsAuthModule` AFTER `AuthModule.forRoot`.
 *
 * Files vendored *outside* of Hygen (handled by `runAuthIntegrationsScaffold`
 * in subsystem.ts):
 *   - `examples/auth-integrations/runtime/connections/**` →
 *     `<vendorRoot>/connections/**` (preserves `use-cases/` subdir).
 *   - `examples/auth-integrations/definitions/entities/connection.yaml` →
 *     `<definitionsPath>` (the consumer's entity-yaml dir).
 *
 * `authModuleRegistered` surfaces whether `AuthModule.forRoot` is already in
 * the consumer's `app.module.ts`. The CLI emits a warning when false —
 * `ConnectionsAuthModule` depends on `ENCRYPTION_KEY` from `AuthModule`.
 *
 * This module is filesystem-unaware except via injected probes — callers
 * pass `fileExists(p)` and `readFile(p)` rather than us reaching for
 * `node:fs` directly. That keeps the unit test suite pure
 * (see cli/auth-integrations-scaffold-locals.test.ts).
 */
import path from 'node:path';

import { entitiesDirCandidates } from '../../config/entities-dir.js';
import type { CodegenConfig } from './context.js';

/** Default when `paths.backend_src` is unset. Matches `project init`. */
const FALLBACK_BACKEND_SRC = 'src';

/**
 * Default modules directory — where codegen emits the `connection`
 * entity module under clean-lite-ps. The auth-integrations install
 * vendors next to the codegen output to keep the connections surface
 * unified (#303 fix #5). Override via `paths.modules_dir`.
 */
const DEFAULT_MODULES_DIR = 'modules';

export interface AuthIntegrationsScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Where `app-module-hook.ejs.t` appends the ConnectionsAuthModule TODO. */
	appModulePath: string;
	/**
	 * Where the connections starter is vendored — `<vendorRoot>/connections/`.
	 * Resolves from `paths.modules_dir` if set, else
	 * `<paths.backend_src>/modules`. Co-locates the vendored adapters,
	 * facade, oauth use-cases, and `ConnectionsAuthModule` with the
	 * codegen-emitted `connection` entity module so the whole
	 * connections surface lives under one folder (matches dealbrain-v2
	 * precedent; #303 fix #5).
	 */
	vendorRoot: string;
	/**
	 * Where the vendored `connection.yaml` lands: `connection.yaml` in the
	 * project's entities directory (`src/config/entities-dir.ts`).
	 */
	definitionsPath: string;
	/**
	 * True iff the consumer's `app.module.ts` already contains
	 * `AuthModule.forRoot`. Drives a warning print in the CLI — the
	 * `ConnectionsAuthModule` requires `ENCRYPTION_KEY` from `AuthModule`.
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
 * - `vendorRoot` resolves to `<cwd>/<paths.modules_dir>` if set, else
 *   `<cwd>/<paths.backend_src>/modules`. The auth-integrations starter
 *   is vendored under `<vendorRoot>/connections/` next to the
 *   codegen-emitted `connection` entity module (#303 fix #5).
 * - `definitionsPath` is `connection.yaml` in the entities directory the CLI
 *   reads (`paths.entities`, else `<cwd>/entities`),
 *   so `entity new` finds the vendored YAML (#634).
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

	// #303 fix #5: vendor target lives next to the codegen-emitted
	// connection entity module, NOT under shared/. Default mirrors the
	// clean-lite-ps emit path (`<backendSrc>/modules/`).
	const modulesConfigured = config?.paths?.modules_dir;
	const vendorRoot =
		typeof modulesConfigured === 'string' && modulesConfigured.length > 0
			? path.resolve(cwd, modulesConfigured)
			: path.resolve(cwd, backendSrc, DEFAULT_MODULES_DIR);

	// The CLI's entities-directory rule (#634): `paths.entities`, else
	// `<cwd>/entities`. Its first candidate, not the existence-checked resolver,
	// so this module stays filesystem-free. (Older `paths.definitions` is NOT a
	// real key — #303.)
	const definitionsPath = path.resolve(
		entitiesDirCandidates(cwd, config?.paths)[0]!,
		'connection.yaml',
	);

	const appModulePath = path.resolve(cwd, backendSrc, 'app.module.ts');

	let authModuleRegistered = false;
	const appModuleSource = input.readFile(appModulePath);
	if (appModuleSource && appModuleSource.includes('AuthModule.forRoot')) {
		authModuleRegistered = true;
	}

	return {
		appName: path.basename(cwd),
		appModulePath,
		vendorRoot,
		definitionsPath,
		authModuleRegistered,
	};
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes. Only
 * the locals consumed by the (single) Hygen template are forwarded; the
 * vendor-copy paths (`vendorRoot`, `definitionsPath`) are consumed directly
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
