/**
 * Detect which subsystems (events/jobs/cache/storage) are already installed
 * in the user's project. A subsystem is "installed" when a `<name>.protocol.ts`
 * exists under a known install root.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.js';

export type SubsystemName =
	| 'events'
	| 'jobs'
	| 'cache'
	| 'storage'
	| 'sync'
	| 'bridge'
	| 'openapi-config'
	| 'observability'
	| 'auth'
	| 'auth-integrations';
export type SubsystemBackend =
	| 'drizzle'
	| 'memory'
	| 'local'
	| 'config-only'
	| 'combiner'
	| 'unknown';

export interface InstalledSubsystem {
	name: SubsystemName;
	path: string;
	backend: SubsystemBackend;
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
		name: 'sync',
		description: 'External-system sync engine (IChangeSource<T> + orchestrator + audit log)',
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
		// (events/jobs/bridge/sync) via @Optional() DI. The `combiner`
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
		// Bundles a canonical `integration` entity yaml + the three
		// integration-store-port adapters + the `IntegrationsService`
		// facade. Single-backend (drizzle); the runtime adapters call
		// directly into the codegen-emitted `IntegrationService` from the
		// entity layer. Detection: presence of
		// `<sharedRoot>/integrations/integrations-auth.module.ts`.
		name: 'auth-integrations',
		description:
			'Vendored integrations entity + adapters (consumes auth subsystem)',
		backends: ['drizzle'],
		defaultBackend: 'drizzle',
	},
];

const KNOWN_NAMES = SUBSYSTEMS.map((s) => s.name);

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

export async function detectInstalledSubsystems(ctx: Context): Promise<InstalledSubsystem[]> {
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
			// A subsystem is installed when the directory contains any *.protocol.ts
			// #287: auth's protocols live under `<dir>/protocols/`, not at the
			// subsystem root. Special-case it: presence of `auth.module.ts`
			// means installed.
			const files = fs.readdirSync(dir);
			let hasProtocol = files.some((f) => f.endsWith('.protocol.ts'));
			if (name === 'auth') {
				hasProtocol = files.includes('auth.module.ts');
			}
			if (!hasProtocol) continue;
			seen.add(name);
			found.push({
				name,
				path: dir,
				backend: inferBackend(dir, name),
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
					});
				}
			} catch {
				// Ignore read errors — detection is best-effort.
			}
		}
	}

	// #287 / #303 fix #5: detect `auth-integrations` by presence of the
	// vendored `integrations-auth.module.ts`. The vendor target moved
	// from `<sharedRoot>/integrations/` to `<vendorRoot>/integrations/`
	// (default `<paths.backend_src>/modules/integrations/`, override via
	// `paths.modules_dir`). Resolution mirrors
	// `auth-integrations-scaffold-locals.ts`. Falls back to the legacy
	// shared/integrations location for any pre-0.6.7 installs.
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
		const sharedConfigured = pathsAny?.shared;
		const sharedRoot =
			typeof sharedConfigured === 'string' && sharedConfigured.length > 0
				? path.resolve(ctx.cwd, sharedConfigured)
				: path.resolve(ctx.cwd, backendSrc, 'shared');

		const candidates = [
			path.join(vendorRoot, 'integrations', 'integrations-auth.module.ts'),
			path.join(sharedRoot, 'integrations', 'integrations-auth.module.ts'),
		];
		for (const moduleFile of candidates) {
			if (fs.existsSync(moduleFile)) {
				found.push({
					name: 'auth-integrations',
					path: path.dirname(moduleFile),
					backend: 'drizzle',
				});
				break;
			}
		}
	}

	return found;
}
