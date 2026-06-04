/**
 * Subsystem barrel generator — writes `<generated>/subsystems.ts`, the
 * AppModule-facing barrel of `forRoot()` dynamic-module calls for every
 * subsystem listed in `codegen.config.yaml`'s `subsystems.install` block.
 *
 * The consumer wires the barrel exactly once:
 *
 *   // app.module.ts
 *   import { SUBSYSTEM_MODULES } from './generated/subsystems';
 *   @Module({ imports: [DatabaseModule, ...SUBSYSTEM_MODULES, ...GENERATED_MODULES] })
 *
 * Every `entity new` / `subsystem install` invocation fully regenerates the
 * file from `codegen.config.yaml` + the detected install set. Deterministic.
 *
 * Today's coverage: events, jobs (+ job-worker embedded mode), bridge, integration.
 * Auth / auth-integrations / observability are out of scope; their AppModule
 * wiring still goes by hand (each has init-time options the generator can't
 * synthesize from config alone). Add a composer entry below when ready to
 * include them.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Context } from './context.js';
import { resolveGeneratedDir } from './barrel-generator.js';
import {
	detectInstalledSubsystems,
	configuredInstalledSubsystems,
	type InstalledSubsystem,
	type SubsystemName,
} from './subsystem-detect.js';
import { resolveSubsystemsRoot } from './subsystems-path.js';
import { resolveRuntimeMode, type RuntimeMode } from './runtime-import.js';
import {
	buildBridgeRegistryContent,
	PACKAGE_BRIDGE_TYPE_IMPORT,
} from './bridge-registry-generator.js';
import { buildEventCodegenContents } from './event-codegen-generator.js';

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

export interface SubsystemBarrelOptions {
	ctx: Context;
	/** Defaults to `<resolveGeneratedDir(ctx)>`. */
	generatedDir?: string;
	dryRun?: boolean;
}

export interface SubsystemBarrelResult {
	/** Absolute path to the written file (or where it would be written). */
	subsystemBarrel: string;
	/** Names actually emitted into the barrel. */
	emitted: SubsystemName[];
	/** Names in install list but skipped (e.g. composer not implemented). */
	skipped: SubsystemName[];
	content: string;
	written: boolean;
}

// ---------------------------------------------------------------------------
// Per-subsystem composers
// ---------------------------------------------------------------------------

interface ComposerInput {
	/**
	 * Resolved import specifier for a subsystem's `forRoot`-bearing module(s).
	 * Mode-aware (ADR-037):
	 *   - `vendored` → `<subsystemsRel>/<name>/<moduleFile>` (relative path into
	 *     the consumer's vendored tree).
	 *   - `package`  → the published `@pattern-stack/codegen` subpath that
	 *     re-exports the module (`/subsystems` for events; `/runtime/subsystems/
	 *     <name>/index` for jobs/bridge/integration, which the single barrel
	 *     doesn't re-export).
	 *
	 * `moduleBasename` is the vendored file's basename WITHOUT extension (e.g.
	 * `events.module`, `jobs-domain.module`); only consulted in vendored mode.
	 */
	moduleImport: (subsystem: SubsystemName, moduleBasename: string) => string;
	/** Per-subsystem config block from codegen.config.yaml (snake_case keys). */
	cfg: Record<string, unknown> | undefined;
	/** Resolved runtime mode (ADR-037). The `bridge` composer threads the
	 * consumer's generated registry only in `package` mode. */
	mode: RuntimeMode;
	/** Whether `bridge` is in the (actable) install set. The `jobs` composer
	 * uses this to default the embedded worker to `allPools: true` so the
	 * reserved `events_*` bridge lanes are drained (otherwise wrappers sit
	 * pending forever — the BRIDGE-8 footgun). */
	bridgeInstalled: boolean;
}

interface ComposerOutput {
	/** Lines like `import { EventsModule } from '<path>/events/events.module';` */
	imports: string[];
	/** Lines emitted into the `SUBSYSTEM_MODULES` array body, indented. */
	calls: string[];
}

type Composer = (input: ComposerInput) => ComposerOutput;

function quoteOpts(opts: Record<string, unknown>): string {
	const entries = Object.entries(opts).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return '';
	return (
		'{ ' +
		entries
			.map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`)
			.join(', ') +
		' }'
	);
}

/**
 * Serialise a plain config object to a TS object literal (single-quoted
 * strings). Used to inline the BullMQ extension block into the generated
 * barrel. Only handles the value shapes that appear under
 * `jobs.extensions.bullmq` (strings, numbers, booleans, nested objects).
 */
function jsonToTs(value: unknown): string {
	if (value === null || value === undefined) return 'undefined';
	if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return `[${value.map(jsonToTs).join(', ')}]`;
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			([, v]) => v !== undefined
		);
		return `{ ${entries.map(([k, v]) => `${k}: ${jsonToTs(v)}`).join(', ')} }`;
	}
	return 'undefined';
}

/**
 * LISTEN-NOTIFY-1 — extract the drizzle extension knobs (`listen_notify`,
 * `poll_interval_ms`) from `jobs.extensions.drizzle` and map them to the
 * camelCase runtime shape. Returns `undefined` when neither knob is set (so the
 * generated call stays minimal and off-by-default). Only the drizzle/default
 * backend reads these.
 */
function drizzleJobsExtensions(
	backend: string,
	cfg: Record<string, unknown> | undefined,
): { listenNotify?: boolean; pollIntervalMs?: number } | undefined {
	if (backend !== 'drizzle') return undefined;
	const drizzle = (cfg?.extensions as { drizzle?: Record<string, unknown> } | undefined)
		?.drizzle;
	if (!drizzle) return undefined;
	const out: { listenNotify?: boolean; pollIntervalMs?: number } = {};
	if (typeof drizzle.listen_notify === 'boolean') out.listenNotify = drizzle.listen_notify;
	if (typeof drizzle.poll_interval_ms === 'number')
		out.pollIntervalMs = drizzle.poll_interval_ms;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Serialise the drizzle extension knobs to a `domainModuleExtensions: { drizzle:
 * {...} }` fragment (camelCase keys, matching the runtime shape), or `''` when
 * none apply. Threaded into BOTH `JobsDomainModule.forRoot` (so the orchestrator
 * emits the enqueue notify) and `JobWorkerModule.forRoot` (so the spawned worker
 * holds the listener + honors `pollIntervalMs`).
 */
function drizzleExtensionsClause(
	ext: { listenNotify?: boolean; pollIntervalMs?: number } | undefined,
	key: 'extensions' | 'domainModuleExtensions',
): string {
	if (!ext) return '';
	return `${key}: { drizzle: ${jsonToTs(ext)} }`;
}

/**
 * BULLMQ-1 — build the `JobsDomainModule.forRoot(...)` options literal,
 * inlining the typed `extensions.bullmq` block when the BullMQ backend is
 * selected. Drizzle/memory fall back to the plain `{ backend, multiTenant }`
 * shape via `quoteOpts`. LISTEN-NOTIFY-1 threads the drizzle extension knobs
 * (`listen_notify`/`poll_interval_ms`) on the drizzle path.
 */
function quoteBullmqDomainOpts(input: {
	backend: string;
	multiTenant: boolean;
	bullExt: Record<string, unknown> | undefined;
	drizzleExt?: { listenNotify?: boolean; pollIntervalMs?: number } | undefined;
}): string {
	const { backend, multiTenant, bullExt, drizzleExt } = input;
	if (backend === 'bullmq' && bullExt) {
		const parts = [`backend: 'bullmq'`];
		if (multiTenant) parts.push(`multiTenant: true`);
		parts.push(`extensions: { bullmq: ${jsonToTs(bullExt)} }`);
		return `{ ${parts.join(', ')} }`;
	}
	const extClause = drizzleExtensionsClause(drizzleExt, 'extensions');
	if (!extClause) {
		return quoteOpts({ backend, multiTenant });
	}
	// Drizzle backend with extension knobs → assemble piecewise so we can append
	// the `extensions: { drizzle: {...} }` block alongside backend/multiTenant.
	const parts = [`backend: '${backend}'`];
	if (multiTenant) parts.push(`multiTenant: true`);
	parts.push(extClause);
	return `{ ${parts.join(', ')} }`;
}

/**
 * JOB-7 / BRIDGE-8 — resolve the embedded worker's pool clause as a TS object
 * fragment (e.g. `pools: ['interactive', 'batch']` or `allPools: true`), or
 * `''` when none applies. Precedence (mirrors `JobWorkerOrchestrator`'s own
 * `pools > allPools > default`):
 *
 *   1. explicit `jobs.worker_pools: [...]` ⇒ `pools: [...]`
 *   2. explicit `jobs.all_pools: true`     ⇒ `allPools: true`
 *   3. `bridge` installed (no explicit knob) ⇒ `allPools: true` — the embedded
 *      worker runs every lane in-process, so it MUST drain the reserved
 *      `events_*` bridge pools or `BridgeModule`'s onModuleInit guard throws
 *      `BridgeReservedPoolsNotPolledError` at boot. `allPools` is exactly the
 *      knob that guard short-circuits on.
 *   4. otherwise ⇒ `''` (worker drains the non-reserved default — unchanged).
 */
function workerPoolsClause(
	cfg: Record<string, unknown> | undefined,
	bridgeInstalled: boolean,
): string {
	const explicit = cfg?.worker_pools;
	if (Array.isArray(explicit) && explicit.length > 0) {
		const list = explicit
			.filter((p): p is string => typeof p === 'string')
			.map((p) => `'${p}'`)
			.join(', ');
		if (list.length > 0) return `pools: [${list}]`;
	}
	if (cfg?.all_pools === true) return 'allPools: true';
	if (bridgeInstalled) return 'allPools: true';
	return '';
}

const COMPOSERS: Partial<Record<SubsystemName, Composer>> = {
	events: ({ moduleImport, cfg, mode }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		// LISTEN-NOTIFY-1: opt-in `events.extensions.drizzle.listen_notify` →
		// `EventsModule.forRoot({ listenNotify })`. Drizzle backend only; omitted
		// (off-by-default) when the key is absent. Emit the fragment only when set
		// so the no-extension barrel byte-shape is unchanged.
		const listenNotify =
			backend === 'drizzle' &&
			(cfg?.extensions as { drizzle?: { listen_notify?: unknown } } | undefined)?.drizzle
				?.listen_notify === true;
		const listenNotifyClause = listenNotify ? `, listenNotify: true` : '';
		const imports = [
			`import { EventsModule } from '${moduleImport('events', 'events.module')}';`,
		];
		// Package mode (ADR-037): the consumer's `events/*.yaml` are scanned into
		// `src/generated/events/bus.ts` (a `TypedEventBus` typed to THEIR event
		// union, reading THEIR registry). Thread it through `forRoot({ typedBus })`
		// or the bundled empty-union bus wins and typed publishes resolve against
		// `never`. Vendored mode omits it — the runtime's own `./generated/bus` IS
		// the consumer's generated file there.
		if (mode === 'package') {
			imports.push(`import { TypedEventBus } from './events/bus';`);
			return {
				imports,
				calls: [
					`\tEventsModule.forRoot({ backend: '${backend}', multiTenant: ${multiTenant}, typedBus: TypedEventBus${listenNotifyClause} }),`,
				],
			};
		}
		if (listenNotify) {
			return {
				imports,
				calls: [
					`\tEventsModule.forRoot({ backend: '${backend}', multiTenant: ${multiTenant}, listenNotify: true }),`,
				],
			};
		}
		return {
			imports,
			calls: [
				`\tEventsModule.forRoot(${quoteOpts({ backend, multiTenant })}),`,
			],
		};
	},

	jobs: ({ moduleImport, cfg, bridgeInstalled }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		const workerMode = ((cfg?.worker_mode as string | undefined) ?? 'standalone').trim();
		const imports = [
			`import { JobsDomainModule } from '${moduleImport('jobs', 'jobs-domain.module')}';`,
		];
		// BULLMQ-1: when `backend: bullmq`, thread the typed extension block so
		// the orchestrator resolves the Redis connection + Bull Board config.
		// The barrel emits the extensions inline (snake_case keys, matching the
		// runtime `BullMqExtensionsConfig` shape).
		const bullExt =
			backend === 'bullmq'
				? (cfg?.extensions as { bullmq?: Record<string, unknown> } | undefined)?.bullmq
				: undefined;
		// LISTEN-NOTIFY-1: drizzle extension knobs (`listen_notify`,
		// `poll_interval_ms`) → camelCase runtime shape; `undefined` when unset.
		const drizzleExt = drizzleJobsExtensions(backend, cfg);
		const domainOpts = quoteBullmqDomainOpts({ backend, multiTenant, bullExt, drizzleExt });
		const calls = [`\tJobsDomainModule.forRoot(${domainOpts}),`];
		// JOB-7: `worker_mode: 'embedded'` runs the worker in-process alongside the
		// HTTP app. `'standalone'` (default) means the user runs `bun worker.ts`
		// separately and we don't include JobWorkerModule in AppModule.
		if (workerMode === 'embedded') {
			imports.push(
				`import { JobWorkerModule } from '${moduleImport('jobs', 'job-worker.module')}';`
			);
			// Assemble the worker options literal piecewise. `mode` is always
			// first; BULLMQ-1 forwards the backend + extensions; BRIDGE-8 appends
			// the pool clause (`pools` / `allPools`) so the embedded worker drains
			// the reserved `events_*` bridge lanes when bridge is installed.
			const parts = [`mode: 'embedded'`];
			if (backend === 'bullmq') {
				parts.push(`backend: 'bullmq'`);
				if (bullExt) {
					parts.push(`domainModuleExtensions: { bullmq: ${jsonToTs(bullExt)} }`);
				}
			} else {
				// LISTEN-NOTIFY-1: the embedded worker needs the drizzle knobs too —
				// `JobWorkerModule` reads `domainModuleExtensions.drizzle` to thread
				// `listenNotify` (the listener) + `pollIntervalMs` into each spawned
				// `JobWorker`. (It also forwards them to the inner `JobsDomainModule`,
				// but that one already got them via the standalone domain call above;
				// re-passing is harmless and keeps the embedded worker self-contained.)
				const workerExtClause = drizzleExtensionsClause(
					drizzleExt,
					'domainModuleExtensions',
				);
				if (workerExtClause) parts.push(workerExtClause);
			}
			const poolsClause = workerPoolsClause(cfg, bridgeInstalled);
			if (poolsClause) parts.push(poolsClause);
			calls.push(`\tJobWorkerModule.forRoot({ ${parts.join(', ')} }),`);
		}
		return { imports, calls };
	},

	bridge: ({ moduleImport, cfg, mode }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		const imports = [
			`import { BridgeModule } from '${moduleImport('bridge', 'bridge.module')}';`,
		];
		// Package mode (ADR-037): the consumer's `@JobHandler.triggers` are
		// scanned into `<generated>/bridge-registry.ts` (co-located with this
		// barrel), since the bundled `./generated/registry` inside the package is
		// a frozen empty placeholder. Thread it through `forRoot({ registry })`
		// or the triggers never bind. Vendored mode omits it — the runtime's own
		// `./generated/registry` IS the consumer's generated file there.
		if (mode === 'package') {
			imports.push(`import { bridgeRegistry } from './bridge-registry';`);
			return {
				imports,
				calls: [
					`\tBridgeModule.forRoot({ backend: '${backend}', multiTenant: ${multiTenant}, registry: bridgeRegistry }),`,
				],
			};
		}
		return {
			imports,
			calls: [
				`\tBridgeModule.forRoot(${quoteOpts({ backend, multiTenant })}),`,
			],
		};
	},

	integration: ({ moduleImport, cfg }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		return {
			imports: [
				`import { IntegrationModule } from '${moduleImport('integration', 'integration.module')}';`,
			],
			calls: [
				`\tIntegrationModule.forRoot(${quoteOpts({ backend, multiTenant })}),`,
			],
		};
	},
};

const PACKAGE = '@pattern-stack/codegen';

/**
 * Build the `moduleImport` resolver for a runtime mode (ADR-037).
 *
 * Vendored mode reproduces the legacy relative-path emission exactly:
 * `<subsystemsRel>/<name>/<moduleBasename>`.
 *
 * Package mode resolves each subsystem's `forRoot`-bearing module to a
 * published `@pattern-stack/codegen` subpath. The single `/subsystems` barrel
 * re-exports ONLY `EventsModule`; the others (`JobsDomainModule`,
 * `JobWorkerModule`, `BridgeModule`, `IntegrationModule`) are reached via the
 * per-subsystem `./runtime/subsystems/<name>/index` barrel, which the package's
 * `exports['./runtime/*']` entry maps to `dist/runtime/subsystems/<name>/index`.
 */
function makeModuleImport(
	mode: RuntimeMode,
	subsystemsRel: string,
): (subsystem: SubsystemName, moduleBasename: string) => string {
	if (mode === 'vendored') {
		return (subsystem, moduleBasename) =>
			`${subsystemsRel}/${subsystem}/${moduleBasename}`;
	}
	// Package mode. `EventsModule` is on the single top-level barrel; everything
	// else resolves through the per-subsystem runtime index.
	return (subsystem) =>
		subsystem === 'events'
			? `${PACKAGE}/subsystems`
			: `${PACKAGE}/runtime/subsystems/${subsystem}/index`;
}

const COMPOSABLE_ORDER: SubsystemName[] = ['events', 'jobs', 'bridge', 'integration'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const HEADER = `// AUTO-GENERATED by @pattern-stack/codegen. DO NOT EDIT.
// Subsystem composition barrel — reflects \`subsystems.install\` in
// codegen.config.yaml and the per-subsystem option blocks
// (\`events:\`, \`jobs:\`, \`bridge:\`, \`integration:\`).
//
// Wire into AppModule once:
//
//   import { SUBSYSTEM_MODULES } from './generated/subsystems';
//   @Module({ imports: [DatabaseModule, ...SUBSYSTEM_MODULES, ...GENERATED_MODULES] })
//
// Regenerated by every \`codegen entity new\` / \`codegen subsystem install\`.

`;

/**
 * Build the subsystem barrel content from a detected install set + config.
 * Pure — no fs side effects, no DI. Useful for unit tests.
 */
export function buildSubsystemBarrel(
	installed: InstalledSubsystem[],
	config: Record<string, unknown> | null | undefined,
	subsystemsRel: string,
	/**
	 * Runtime mode (ADR-037). `vendored` (default) keeps the legacy
	 * relative-path imports off `subsystemsRel`; `package` emits imports off the
	 * published `@pattern-stack/codegen` subpaths. Defaulted so the many
	 * existing pure-builder test callers stay on the legacy shape.
	 */
	mode: RuntimeMode = 'vendored'
): { content: string; emitted: SubsystemName[]; skipped: SubsystemName[] } {
	const moduleImport = makeModuleImport(mode, subsystemsRel);
	// #4: only fully-installed subsystems (module file present) may emit a
	// `forRoot()` import. An `incomplete` entry — e.g. the `bridge/` protocol
	// stubs an events install vendors because the events drizzle backend imports
	// them — has no `<name>.module.ts`, so importing `BridgeModule` from it would
	// break the consumer's `tsc`. `detectInstalledSubsystems` already filters
	// these out; this guard also protects direct (test) callers of the pure
	// builder.
	const actable = installed.filter((i) => i.status !== 'incomplete');
	const installedNames = new Set(actable.map((i) => i.name));
	const bridgeInstalled = installedNames.has('bridge');
	const emitted: SubsystemName[] = [];
	const skipped: SubsystemName[] = [];

	const allImports: string[] = [`import type { DynamicModule } from '@nestjs/common';`];
	const allCalls: string[] = [];

	for (const name of COMPOSABLE_ORDER) {
		if (!installedNames.has(name)) continue;
		const composer = COMPOSERS[name];
		if (!composer) {
			skipped.push(name);
			continue;
		}
		const cfg = (config?.[name] as Record<string, unknown> | undefined) ?? undefined;
		const out = composer({ moduleImport, cfg, mode, bridgeInstalled });
		allImports.push(...out.imports);
		allCalls.push(...out.calls);
		emitted.push(name);
	}

	// Names in install order that have no composer yet — log for visibility.
	for (const inst of actable) {
		if (!COMPOSABLE_ORDER.includes(inst.name) && !COMPOSERS[inst.name]) {
			skipped.push(inst.name);
		}
	}

	// Single emit shape — imports always include the `DynamicModule` type
	// (allImports is seeded with it on init), even when no composer fired.
	// A previous two-branch shape elided the imports in the empty-`allCalls`
	// case and produced `export const SUBSYSTEM_MODULES: DynamicModule[] = [];`
	// with no preceding import → `TS2304: Cannot find name 'DynamicModule'`
	// for projects whose installed set contains only non-composer subsystems
	// (e.g. observability + auth + auth-integrations).
	const exportLine =
		allCalls.length === 0
			? `export const SUBSYSTEM_MODULES: DynamicModule[] = [];\n`
			: `export const SUBSYSTEM_MODULES: DynamicModule[] = [\n${allCalls.join('\n')}\n];\n`;
	const body = allImports.join('\n') + '\n\n' + exportLine;
	return { content: HEADER + body, emitted, skipped };
}

/**
 * Detect installed subsystems + load config, then write
 * `<generated>/subsystems.ts`. Returns the result + a written flag.
 */
export async function regenerateSubsystemBarrel(
	opts: SubsystemBarrelOptions
): Promise<SubsystemBarrelResult> {
	const { ctx, dryRun = false } = opts;
	const generatedDir = opts.generatedDir ?? resolveGeneratedDir(ctx);

	// ADR-037: "installed" is mode-dependent. Package mode reads
	// `subsystems.install` from config (nothing is vendored on disk); vendored
	// mode scans for the vendored `<name>.module.ts` files exactly as before.
	const mode = resolveRuntimeMode(ctx.config);
	const installed =
		mode === 'package'
			? configuredInstalledSubsystems(
					ctx.config as Record<string, unknown> | null | undefined,
				)
			: await detectInstalledSubsystems(ctx);

	// Subsystems root → barrel can import via a relative path that works
	// wherever the generated barrel ends up. `resolveSubsystemsRoot` returns
	// an absolute path; honors `paths.subsystems` override or falls back to
	// `<paths.backend_src>/shared/subsystems`.
	const subsystemsAbs = resolveSubsystemsRoot(ctx);
	const barrelAbs = path.resolve(generatedDir, 'subsystems.ts');
	let subsystemsRel = path
		.relative(path.dirname(barrelAbs), subsystemsAbs)
		.split(path.sep)
		.join('/');
	if (!subsystemsRel.startsWith('.')) subsystemsRel = './' + subsystemsRel;

	const { content, emitted, skipped } = buildSubsystemBarrel(
		installed,
		ctx.config as Record<string, unknown> | null | undefined,
		subsystemsRel,
		mode
	);

	let written = false;
	if (!dryRun) {
		fs.mkdirSync(path.dirname(barrelAbs), { recursive: true });
		fs.writeFileSync(barrelAbs, content);
		written = true;

		// Package mode: the bridge composer imports `./bridge-registry`. The real
		// registry is emitted by `entity new --all` (which scans handlers); but
		// `subsystem install bridge` regenerates this barrel WITHOUT running that
		// scan, which would dangle the import until the next `entity new`. Drop an
		// empty-registry stub iff the file is absent — never clobber a
		// previously-generated registry (idempotent: byte-identical to the
		// generator's own empty-case output, so no churn).
		if (mode === 'package' && emitted.includes('bridge')) {
			const registryPath = path.resolve(generatedDir, 'bridge-registry.ts');
			if (!fs.existsSync(registryPath)) {
				fs.writeFileSync(
					registryPath,
					buildBridgeRegistryContent([], PACKAGE_BRIDGE_TYPE_IMPORT),
				);
			}
		}

		// Same guard for the events composer: package mode imports
		// `./events/bus`. The real 5-file set is emitted by `entity new --all`
		// (which scans events/*.yaml); `subsystem install events` regenerates the
		// barrel without that scan, so drop an empty-set stub iff the dir is
		// absent — never clobber a previously-generated set (byte-identical to the
		// generator's own empty-case output, so no churn).
		if (mode === 'package' && emitted.includes('events')) {
			const eventsDir = path.resolve(generatedDir, 'events');
			if (!fs.existsSync(path.resolve(eventsDir, 'bus.ts'))) {
				fs.mkdirSync(eventsDir, { recursive: true });
				for (const { name, content } of buildEventCodegenContents([], 'package')) {
					fs.writeFileSync(path.resolve(eventsDir, name), content);
				}
			}
		}
	}

	return {
		subsystemBarrel: barrelAbs,
		emitted,
		skipped,
		content,
		written,
	};
}
