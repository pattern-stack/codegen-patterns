/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/auth/`.
 *
 * #287: `subsystem install auth` runs after `copyRuntime` (which copies the
 * AuthModule, ports, backends, controller, and runtime helpers from
 * `runtime/subsystems/auth/` into the consumer tree). The Hygen scaffold
 * then steers three artifacts that don't fit `copyRuntime`'s shape:
 *
 *   - `auth-oauth-state.schema.ejs.t` — emits the `auth_oauth_state`
 *     drizzle schema. Same pattern as events / jobs / sync: the schema
 *     comes from a template (not `copyRuntime`) so the install path is the
 *     sole emitter — keeps the file's provenance unambiguous and lets us
 *     gate columns on per-subsystem flags in the future without re-shaping
 *     the runtime source.
 *   - `app-module-hook.ejs.t` — appends a TODO comment block to the
 *     consumer's `app.module.ts` directing the human to wire
 *     `AuthModule.forRoot({ ... })`. Same convention as observability —
 *     deliberately NOT a regex / AST injection: ts-morph machinery is
 *     reserved for `project upgrade-*` flows, and a TODO comment with the
 *     full ready-to-paste snippet is friendlier than a half-correct AST
 *     patch.
 *   - `env-config.ejs.t` — appends `TOKEN_ENCRYPTION_KEY=<freshly
 *     generated 32-byte b64>` plus the `AUTH_REDIRECT_URI_BASE` knob to
 *     `.env.config`. The encryption key is generated ONCE per install (no
 *     idempotent re-run) — re-running with `--force` does not regenerate
 *     it because `skip_if: "TOKEN_ENCRYPTION_KEY"` short-circuits the
 *     inject. This is correct: rotating the key is a separate, auditable
 *     operation and silently regenerating it on re-install would invalidate
 *     every encrypted token in the consumer's database.
 *
 * Auth has NO `multi_tenant` knob (single-tenant for now — token
 * encryption + state store are inherently per-app, not per-tenant) and NO
 * `generated/` dir (no codegen artifacts; the runtime ports + adapters are
 * directly importable).
 *
 * This module is filesystem-unaware — the resolver is pure (config + cwd).
 * The CLI's `runAuthScaffold` handles the `.env.config` touch externally
 * before invoking Hygen (subsystem.ts:1460-1463), so no fs probe is needed
 * here. Keeps the unit test suite pure (see cli/auth-scaffold-locals.test.ts).
 */
import crypto from 'node:crypto';
import path from 'node:path';

import type { CodegenConfig } from './context.js';
import { resolveSubsystemsRootFromConfig } from './subsystems-path.js';

/** Default when `paths.backend_src` is unset. Matches `project init`. */
const FALLBACK_BACKEND_SRC = 'src';

/** Default `redirectUriBase` when the consumer hasn't overridden via config. */
const DEFAULT_REDIRECT_URI_BASE = 'http://localhost:3000';

export interface AuthScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Where `codegen-config-auth-block.ejs.t` appends the `auth:` block. */
	configPath: string;
	/** Where `auth-oauth-state.schema.ejs.t` writes the schema. */
	schemaPath: string;
	/** Where `app-module-hook.ejs.t` appends the `AuthModule.forRoot` TODO. */
	appModulePath: string;
	/** Where `env-config.ejs.t` appends `TOKEN_ENCRYPTION_KEY=...`. */
	envConfigPath: string;
	/**
	 * Default `http://localhost:3000`; overridable via
	 * `auth.redirect_uri_base` in `codegen.config.yaml`. Embedded in the
	 * TODO snippet AND in the `.env.config` `AUTH_REDIRECT_URI_BASE` line.
	 */
	redirectUriBase: string;
	/**
	 * 32-byte AES-256-GCM key encoded base64 (44 ascii chars). Generated
	 * fresh at resolve-time — install runs once, and `skip_if` on the env
	 * template makes re-runs idempotent (re-runs do NOT regenerate the
	 * key). Rotating in production is a separate operation outside the
	 * install path.
	 */
	tokenEncryptionKey: string;
}

export interface AuthScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
}

/**
 * Resolve all Hygen locals for `subsystem install auth` from config + cwd.
 *
 * - `schemaPath` resolves through `resolveSubsystemsRootFromConfig` so it
 *   matches exactly where `copyRuntime` would have emitted the file
 *   (before `backendFileFilter` skipped it — see subsystem.ts).
 * - `appModulePath` resolves to `<cwd>/<paths.backend_src>/app.module.ts`,
 *   falling back to `<cwd>/src/app.module.ts`. Hygen's `inject: append:`
 *   tolerates a missing target (appends to an empty file), so we don't
 *   gate on `fileExists`.
 * - `redirectUriBase` defaults to `http://localhost:3000`; only a
 *   non-empty string in `auth.redirect_uri_base` overrides it (defends
 *   against null / undefined / non-string YAML surprises).
 * - `tokenEncryptionKey` is generated via `crypto.randomBytes(32)` at
 *   resolve time. The b64 encoding is 44 chars — matches what
 *   `EnvEncryptionKey` expects from `process.env.TOKEN_ENCRYPTION_KEY`.
 */
export function resolveAuthScaffoldLocals(
	input: AuthScaffoldLocalsInput,
): AuthScaffoldLocals {
	const { cwd, config } = input;

	const backendSrc =
		typeof config?.paths?.backend_src === 'string' &&
		config.paths.backend_src.length > 0
			? config.paths.backend_src
			: FALLBACK_BACKEND_SRC;

	const subsystemsRoot = resolveSubsystemsRootFromConfig(cwd, config);

	const authBlock = (config?.auth ?? {}) as Record<string, unknown>;
	const redirectRaw = authBlock.redirect_uri_base;
	const redirectUriBase =
		typeof redirectRaw === 'string' && redirectRaw.length > 0
			? redirectRaw
			: DEFAULT_REDIRECT_URI_BASE;

	const tokenEncryptionKey = crypto.randomBytes(32).toString('base64');

	return {
		appName: path.basename(cwd),
		configPath: path.resolve(cwd, 'codegen.config.yaml'),
		schemaPath: path.resolve(
			subsystemsRoot,
			'auth',
			'auth-oauth-state.schema.ts',
		),
		appModulePath: path.resolve(cwd, backendSrc, 'app.module.ts'),
		envConfigPath: path.resolve(cwd, '.env.config'),
		redirectUriBase,
		tokenEncryptionKey,
	};
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes.
 * Paths are forwarded as absolute so Hygen's `to:` front-matter resolves
 * relative to them, not to Hygen's `cwd`.
 */
export function localsToHygenArgs(locals: AuthScaffoldLocals): string[] {
	return [
		'--appName', locals.appName,
		'--configPath', locals.configPath,
		'--schemaPath', locals.schemaPath,
		'--appModulePath', locals.appModulePath,
		'--envConfigPath', locals.envConfigPath,
		'--redirectUriBase', locals.redirectUriBase,
		'--tokenEncryptionKey', locals.tokenEncryptionKey,
	];
}
