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
 * Today's coverage: events, jobs (+ job-worker embedded mode), bridge, sync.
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
	type InstalledSubsystem,
	type SubsystemName,
} from './subsystem-detect.js';
import { resolveSubsystemsRoot } from './subsystems-path.js';

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
	/** Relative path from project root to the subsystems root (e.g. `src/shared/subsystems`). */
	subsystemsRel: string;
	/** Per-subsystem config block from codegen.config.yaml (snake_case keys). */
	cfg: Record<string, unknown> | undefined;
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
 * BULLMQ-1 — build the `JobsDomainModule.forRoot(...)` options literal,
 * inlining the typed `extensions.bullmq` block when the BullMQ backend is
 * selected. Drizzle/memory fall back to the plain `{ backend, multiTenant }`
 * shape via `quoteOpts`.
 */
function quoteBullmqDomainOpts(input: {
	backend: string;
	multiTenant: boolean;
	bullExt: Record<string, unknown> | undefined;
}): string {
	const { backend, multiTenant, bullExt } = input;
	if (backend !== 'bullmq' || !bullExt) {
		return quoteOpts({ backend, multiTenant });
	}
	const parts = [`backend: 'bullmq'`];
	if (multiTenant) parts.push(`multiTenant: true`);
	parts.push(`extensions: { bullmq: ${jsonToTs(bullExt)} }`);
	return `{ ${parts.join(', ')} }`;
}

const COMPOSERS: Partial<Record<SubsystemName, Composer>> = {
	events: ({ subsystemsRel, cfg }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		return {
			imports: [
				`import { EventsModule } from '${subsystemsRel}/events/events.module';`,
			],
			calls: [
				`\tEventsModule.forRoot(${quoteOpts({ backend, multiTenant })}),`,
			],
		};
	},

	jobs: ({ subsystemsRel, cfg }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		const workerMode = ((cfg?.worker_mode as string | undefined) ?? 'standalone').trim();
		const imports = [
			`import { JobsDomainModule } from '${subsystemsRel}/jobs/jobs-domain.module';`,
		];
		// BULLMQ-1: when `backend: bullmq`, thread the typed extension block so
		// the orchestrator resolves the Redis connection + Bull Board config.
		// The barrel emits the extensions inline (snake_case keys, matching the
		// runtime `BullMqExtensionsConfig` shape).
		const bullExt =
			backend === 'bullmq'
				? (cfg?.extensions as { bullmq?: Record<string, unknown> } | undefined)?.bullmq
				: undefined;
		const domainOpts = quoteBullmqDomainOpts({ backend, multiTenant, bullExt });
		const calls = [`\tJobsDomainModule.forRoot(${domainOpts}),`];
		// JOB-7: `worker_mode: 'embedded'` runs the worker in-process alongside the
		// HTTP app. `'standalone'` (default) means the user runs `bun worker.ts`
		// separately and we don't include JobWorkerModule in AppModule.
		if (workerMode === 'embedded') {
			imports.push(
				`import { JobWorkerModule } from '${subsystemsRel}/jobs/job-worker.module';`
			);
			// BULLMQ-1: forward backend + bullmq extensions to the embedded worker
			// so it spawns BullMQ (not Drizzle) workers when configured.
			const workerOpts =
				backend === 'bullmq'
					? `{ mode: 'embedded', backend: 'bullmq'${
							bullExt ? `, domainModuleExtensions: { bullmq: ${jsonToTs(bullExt)} }` : ''
						} }`
					: `{ mode: 'embedded' }`;
			calls.push(`\tJobWorkerModule.forRoot(${workerOpts}),`);
		}
		return { imports, calls };
	},

	bridge: ({ subsystemsRel, cfg }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		return {
			imports: [
				`import { BridgeModule } from '${subsystemsRel}/bridge/bridge.module';`,
			],
			calls: [
				`\tBridgeModule.forRoot(${quoteOpts({ backend, multiTenant })}),`,
			],
		};
	},

	sync: ({ subsystemsRel, cfg }) => {
		const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
		const multiTenant = Boolean(cfg?.multi_tenant);
		return {
			imports: [
				`import { SyncModule } from '${subsystemsRel}/sync/sync.module';`,
			],
			calls: [
				`\tSyncModule.forRoot(${quoteOpts({ backend, multiTenant })}),`,
			],
		};
	},
};

const COMPOSABLE_ORDER: SubsystemName[] = ['events', 'jobs', 'bridge', 'sync'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const HEADER = `// AUTO-GENERATED by @pattern-stack/codegen. DO NOT EDIT.
// Subsystem composition barrel — reflects \`subsystems.install\` in
// codegen.config.yaml and the per-subsystem option blocks
// (\`events:\`, \`jobs:\`, \`bridge:\`, \`sync:\`).
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
	subsystemsRel: string
): { content: string; emitted: SubsystemName[]; skipped: SubsystemName[] } {
	const installedNames = new Set(installed.map((i) => i.name));
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
		const out = composer({ subsystemsRel, cfg });
		allImports.push(...out.imports);
		allCalls.push(...out.calls);
		emitted.push(name);
	}

	// Names in install order that have no composer yet — log for visibility.
	for (const inst of installed) {
		if (!COMPOSABLE_ORDER.includes(inst.name) && !COMPOSERS[inst.name]) {
			skipped.push(inst.name);
		}
	}

	if (allCalls.length === 0) {
		// No composable subsystems installed. Still emit the `DynamicModule`
		// import — the empty array is typed `DynamicModule[]`, so omitting the
		// import leaves a dangling type reference (TS2304). This branch is now
		// reachable for real (a project with no events/jobs/bridge/sync
		// installed), not just hypothetically — subsystem detection no longer
		// treats a baseline-vendored `*.protocol.ts` as an install.
		return {
			content:
				HEADER +
				`import type { DynamicModule } from '@nestjs/common';\n\n` +
				`export const SUBSYSTEM_MODULES: DynamicModule[] = [];\n`,
			emitted,
			skipped,
		};
	}

	const body =
		allImports.join('\n') +
		'\n\n' +
		`export const SUBSYSTEM_MODULES: DynamicModule[] = [\n${allCalls.join('\n')}\n];\n`;
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

	const installed = await detectInstalledSubsystems(ctx);

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
		subsystemsRel
	);

	let written = false;
	if (!dryRun) {
		fs.mkdirSync(path.dirname(barrelAbs), { recursive: true });
		fs.writeFileSync(barrelAbs, content);
		written = true;
	}

	return {
		subsystemBarrel: barrelAbs,
		emitted,
		skipped,
		content,
		written,
	};
}
