/**
 * Detect which subsystems (events/jobs/cache/storage) are already installed
 * in the user's project.
 *
 * Detection keys on the subsystem's **module file** (`<name>.module.ts`, e.g.
 * `events.module.ts`; jobs uses `jobs-domain.module.ts`), NOT merely on the
 * subsystem directory or a `*.protocol.ts` stub. This matters because
 * installing one subsystem can vendor *protocol/token/schema stubs* of another
 * (e.g. an events install drops `bridge/bridge.protocol.ts` +
 * `bridge.tokens.ts` because the events drizzle backend imports them) WITHOUT
 * vendoring that subsystem's module. Such a directory is "incomplete": the
 * stubs exist but the `forRoot()`-bearing module does not.
 *
 * `detectInstalledSubsystems` returns only **fully-installed** subsystems
 * (module file present) — this is what the barrel generator, install
 * idempotency check, and `codegen update` act on. `detectSubsystemStates`
 * returns every *present* subsystem (installed + incomplete) for the reporting
 * surface (`subsystem list`).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.js';

export type SubsystemName =
	| 'events'
	| 'jobs'
	| 'cache'
	| 'storage'
	| 'integration'
	| 'bridge'
	| 'openapi-config'
	| 'observability'
	| 'auth'
	| 'auth-integrations';
export type SubsystemBackend =
	| 'drizzle'
	| 'memory'
	| 'local'
	| 'redis'
	| 'bullmq'
	| 'config-only'
	| 'combiner'
	| 'unknown';

/**
 * Install state of a subsystem directory:
 * - `installed` — the `<name>.module.ts` module file is present (the subsystem
 *   is wired and `forRoot()`-able).
 * - `incomplete` — the directory carries subsystem source (a `*.protocol.ts`
 *   or token/schema stub vendored as another subsystem's dependency) but the
 *   module file is absent. The barrel must NOT emit a `forRoot()` for it.
 */
export type SubsystemStatus = 'installed' | 'incomplete';

export interface InstalledSubsystem {
	name: SubsystemName;
	path: string;
	backend: SubsystemBackend;
	status: SubsystemStatus;
}

export interface SubsystemDescriptor {
	name: SubsystemName;
	description: string;
	backends: SubsystemBackend[];
	defaultBackend: SubsystemBackend;
}

export const SUBSYSTEMS: SubsystemDescriptor[] = [
	{
		name: 'events',
		description: 'Domain event bus (transactional outbox)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'jobs',
		description: 'Background job queue',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'cache',
		description: 'Key-value cache with TTL',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'storage',
		description: 'File/object storage',
		backends: ['local', 'memory'],
		defaultBackend: 'local',
	},
	{
		name: 'integration',
		description: 'External-system integration engine (IChangeSource<T> + orchestrator + audit log)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'bridge',
		description: 'Event-to-job bridge (durable async fanout via @JobHandler.triggers)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		// OPENAPI-4. "Config-only" pseudo-subsystem — the runtime helpers
		// (OpenApiRegistry, ErrorResponseDto) are already vendored by
		// `codegen project init`. Installing this subsystem just injects the
		// `openapi:` block into codegen.config.yaml.
		name: 'openapi-config',
		description: 'OpenAPI/Swagger config block (registry is vendored at init)',
		backends: ['config-only'],
		defaultBackend: 'config-only',
	},
	{
		// OBS-7 / ADR-025. Combiner subsystem — no schema, no worker, no
		// generated/ dir. `ObservabilityModule` composes sibling read ports
		// (events/jobs/bridge/integration) via @Optional() DI. The `combiner`
		// pseudo-backend is parallel to `openapi-config`'s `config-only`.
		name: 'observability',
		description:
			'Observability combiner — composes sibling read ports via @Optional() DI (ADR-025)',
		backends: ['combiner'],
		defaultBackend: 'combiner',
	},
	{
		// #287. Auth subsystem (PR #289) — AuthModule + ports + OAuth state
		// store + AuthController. Backends: drizzle (prod, persists OAuth
		// state in `auth_oauth_state`) or memory (dev/tests). Detection in
		// `detectInstalledSubsystems` is a special case: auth's protocols
		// live under `protocols/`, not at the subsystem root, so we look
		// for `auth.module.ts` instead of `*.protocol.ts`.
		name: 'auth',
		description:
			'OAuth integration auth (AuthModule + ports + state store)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		// #287. Auth-integrations starter (PR #290) — vendored from
		// `examples/auth-integrations/`, NOT from `runtime/subsystems/`.
		// Bundles a canonical `connection` entity yaml + the three
		// connection-store-port adapters + the `ConnectionsService`
		// facade. Single-backend (drizzle); the runtime adapters call
		// directly into the codegen-emitted `ConnectionService` from the
		// entity layer. Detection: presence of
		// `<vendorRoot>/connections/connections-auth.module.ts`.
		name: 'auth-integrations',
		description:
			'Vendored connection entity + adapters (consumes auth subsystem)',
		backends: ['drizzle'],
		defaultBackend: 'drizzle',
	},
];

const KNOWN_NAMES = SUBSYSTEMS.map((s) => s.name);

/**
 * The module file that signals a subsystem is fully installed (carries the
 * `forRoot()` dynamic module). Most subsystems use `<name>.module.ts`; `jobs`
 * is the exception — its composition module is `jobs-domain.module.ts`
 * (`job-worker.module.ts` is the optional embedded-worker module). Subsystems
 * detected by other means (`openapi-config` via config key, `auth-integrations`
 * via vendored module elsewhere) are absent from this map.
 */
const SUBSYSTEM_MODULE_FILE: Partial<Record<SubsystemName, string>> = {
	events: 'events.module.ts',
	jobs: 'jobs-domain.module.ts',
	cache: 'cache.module.ts',
	storage: 'storage.module.ts',
	integration: 'integration.module.ts',
	bridge: 'bridge.module.ts',
	observability: 'observability.module.ts',
	auth: 'auth.module.ts',
};

/** Module file whose presence marks `name` fully installed, or null. */
export function subsystemModuleFile(name: SubsystemName): string | null {
	return SUBSYSTEM_MODULE_FILE[name] ?? null;
}

function candidateRoots(cwd: string, configured?: string): string[] {
	const roots = [
		...(configured ? [path.resolve(cwd, configured)] : []),
		path.resolve(cwd, 'src/shared/subsystems'),
		path.resolve(cwd, 'src/subsystems'),
		path.resolve(cwd, 'shared/subsystems'),
	];
	// Deduplicate while preserving order
	return Array.from(new Set(roots));
}

function inferBackend(dir: string, name: SubsystemName): SubsystemBackend {
	// OBS-7: observability is a combiner subsystem (ADR-025) — no
	// drizzle/memory split, no backend files beyond the service itself.
	// Short-circuit so we never mis-report it as 'unknown'.
	if (name === 'observability') return 'combiner';
	// #287: auth + auth-integrations don't follow the *-bus.drizzle-backend.ts
	// shape. Auth's drizzle backend lives at
	// `backends/state-store.drizzle-backend.ts`; the memory variant is
	// always installed alongside (for tests) so we always report 'drizzle'
	// for the listing. auth-integrations is single-backend (drizzle only).
	if (name === 'auth') return 'drizzle';
	if (name === 'auth-integrations') return 'drizzle';
	const hasDrizzle = fs.existsSync(path.join(dir, `${name.replace(/s$/, '')}-bus.drizzle-backend.ts`))
		|| fs.readdirSync(dir).some((f) => f.endsWith('.drizzle-backend.ts'));
	const hasMemory = fs.readdirSync(dir).some((f) => f.endsWith('.memory-backend.ts'));
	const hasLocal = fs.readdirSync(dir).some((f) => f.includes('local'));
	if (hasDrizzle && hasMemory) return 'drizzle'; // both present → drizzle is the active one
	if (hasDrizzle) return 'drizzle';
	if (hasLocal) return 'local';
	if (hasMemory) return 'memory';
	return 'unknown';
}

/**
 * Core scan: returns every *present* subsystem under the candidate roots,
 * tagged `installed` or `incomplete`. A directory is "present" when it carries
 * subsystem source (any `*.protocol.ts`, or — for `auth`, whose protocols live
 * under `protocols/` — its module file). It is `installed` when the module file
 * (`subsystemModuleFile(name)`) exists, else `incomplete`.
 *
 * `openapi-config` (config-only) and `auth-integrations` (vendored elsewhere)
 * are detected separately and always reported `installed` when found.
 */
async function detectSubsystemStatesImpl(
	ctx: Context,
): Promise<InstalledSubsystem[]> {
	const configured = ctx.config?.paths?.subsystems as string | undefined;
	const roots = candidateRoots(ctx.cwd, configured);

	const found: InstalledSubsystem[] = [];
	const seen = new Set<SubsystemName>();

	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		for (const name of KNOWN_NAMES) {
			if (seen.has(name)) continue;
			// OPENAPI-4: `openapi-config` is config-only — no runtime dir,
			// no *.protocol.ts. Detection happens via the `openapi:` block
			// in codegen.config.yaml (see below).
			if (name === 'openapi-config') continue;
			// #287: auth-integrations does NOT live under <root>/<name>/ —
			// its files vendor into <root>/../integrations/ (sibling of
			// `subsystems/`). Detect it separately below.
			if (name === 'auth-integrations') continue;
			const dir = path.join(root, name);
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
			const files = fs.readdirSync(dir);
			const moduleFile = subsystemModuleFile(name);
			const hasModule = moduleFile ? files.includes(moduleFile) : false;
			// "Present" gate. #287: auth's protocols live under
			// `<dir>/protocols/`, not at the subsystem root — its module file
			// is the only at-root marker, so presence == hasModule.
			// #4/#2: every other subsystem is present if it has a *.protocol.ts
			// (covers stub-only dirs vendored as another subsystem's dep) OR
			// the module file.
			const present =
				name === 'auth'
					? hasModule
					: files.some((f) => f.endsWith('.protocol.ts')) || hasModule;
			if (!present) continue;
			seen.add(name);
			found.push({
				name,
				path: dir,
				backend: inferBackend(dir, name),
				status: hasModule ? 'installed' : 'incomplete',
			});
		}
	}

	// OPENAPI-4: detect `openapi-config` by presence of the `openapi:` key
	// in codegen.config.yaml. Runtime files were vendored at `project init`.
	if (!seen.has('openapi-config')) {
		const configPath = path.resolve(
			ctx.cwd,
			ctx.config ? 'codegen.config.yaml' : 'codegen.config.yaml',
		);
		if (fs.existsSync(configPath)) {
			try {
				const source = fs.readFileSync(configPath, 'utf-8');
				// Lightweight top-level-key check; full parse-aware detection
				// lives in `config-block-detect.ts` but we don't need its
				// error surface here — a false negative just means the CLI
				// offers to install it again, which is idempotent.
				if (/^openapi\s*:/m.test(source)) {
					found.push({
						name: 'openapi-config',
						path: configPath,
						backend: 'config-only',
						status: 'installed',
					});
				}
			} catch {
				// Ignore read errors — detection is best-effort.
			}
		}
	}

	// #287 / #303 fix #5: detect `auth-integrations` by presence of the
	// vendored `connections-auth.module.ts`. The vendor target is
	// `<vendorRoot>/connections/` (default `<paths.backend_src>/modules/connections/`,
	// override via `paths.modules_dir`). Resolution mirrors
	// `auth-integrations-scaffold-locals.ts`.
	if (!seen.has('auth-integrations')) {
		const backendSrc =
			(ctx.config?.paths?.backend_src as string | undefined) ?? 'src';
		const pathsAny = ctx.config?.paths as
			| Record<string, unknown>
			| undefined;
		const modulesConfigured = pathsAny?.modules_dir;
		const vendorRoot =
			typeof modulesConfigured === 'string' && modulesConfigured.length > 0
				? path.resolve(ctx.cwd, modulesConfigured)
				: path.resolve(ctx.cwd, backendSrc, 'modules');

		const candidates = [
			path.join(vendorRoot, 'connections', 'connections-auth.module.ts'),
		];
		for (const moduleFile of candidates) {
			if (fs.existsSync(moduleFile)) {
				found.push({
					name: 'auth-integrations',
					path: path.dirname(moduleFile),
					backend: 'drizzle',
					status: 'installed',
				});
				break;
			}
		}
	}

	return found;
}

/**
 * Every *present* subsystem (installed + incomplete) under the candidate
 * roots. Use for the reporting surface (`subsystem list`), where incomplete
 * stub directories must be surfaced distinctly from fully-installed ones.
 */
export async function detectSubsystemStates(
	ctx: Context,
): Promise<InstalledSubsystem[]> {
	return detectSubsystemStatesImpl(ctx);
}

/**
 * Fully-installed subsystems only (module file present). Use everywhere a
 * subsystem must actually be *actable* — barrel composition, install
 * idempotency, `codegen update` re-vendoring. An incomplete stub directory
 * (e.g. the `bridge/` protocol stubs an events install drops) is excluded so
 * the barrel never emits a `forRoot()` for a module that doesn't exist.
 */
export async function detectInstalledSubsystems(
	ctx: Context,
): Promise<InstalledSubsystem[]> {
	const states = await detectSubsystemStatesImpl(ctx);
	return states.filter((s) => s.status === 'installed');
}
