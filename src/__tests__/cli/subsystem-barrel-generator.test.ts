/**
 * Subsystem barrel generator tests.
 *
 * Cover:
 *   - empty installed set → empty barrel + DynamicModule[] type
 *   - single subsystem (events) → 1 import + 1 forRoot call
 *   - full minimum set (events+jobs+bridge+integration) → 4 imports + 4 calls
 *   - jobs `worker_mode: 'embedded'` adds JobWorkerModule
 *   - per-subsystem config plumbed through (multi_tenant → multiTenant)
 *   - subsystems in install list but with no composer are listed in `skipped`
 *   - subsystems root path override via `paths.subsystems` honored
 */

import { describe, test, expect } from 'bun:test';

import { buildSubsystemBarrel } from '../../cli/shared/subsystem-barrel-generator.js';
import type { InstalledSubsystem } from '../../cli/shared/subsystem-detect.js';

function inst(
	name: InstalledSubsystem['name'],
	status: InstalledSubsystem['status'] = 'installed',
): InstalledSubsystem {
	return { name, path: `/fake/${name}`, backend: 'drizzle', status };
}

describe('buildSubsystemBarrel', () => {
	const subsystemsRel = './shared/subsystems';

	test('empty installed set produces empty array (with DynamicModule type + import)', () => {
		const out = buildSubsystemBarrel([], {}, subsystemsRel);
		// Regression: a prior two-branch emitter dropped the import line when
		// `allCalls` was empty, producing `export const SUBSYSTEM_MODULES:
		// DynamicModule[] = [];` with no preceding import → consumer `tsc`
		// failed with `TS2304: Cannot find name 'DynamicModule'`. The single
		// emit shape always prepends the import.
		expect(out.content).toContain(
			"import type { DynamicModule } from '@nestjs/common';",
		);
		expect(out.content).toContain(
			'export const SUBSYSTEM_MODULES: DynamicModule[] = [];',
		);
		// The import must precede the export.
		expect(out.content.indexOf("import type { DynamicModule }")).toBeLessThan(
			out.content.indexOf('export const SUBSYSTEM_MODULES'),
		);
		expect(out.emitted).toEqual([]);
		expect(out.skipped).toEqual([]);
	});

	test('installed-but-no-composer-only set still emits DynamicModule import (#smoke-fix)', () => {
		// Repro of the smoke regression: a project whose install set contains
		// only non-composer subsystems (observability + auth + auth-integrations
		// in the actual smoke; observability alone is sufficient to trigger the
		// pre-fix bug). `allCalls` is empty, so the prior code returned
		// `HEADER + 'export const SUBSYSTEM_MODULES: DynamicModule[] = [];'`
		// with no `DynamicModule` import. tsc TS2304.
		const out = buildSubsystemBarrel(
			[inst('observability')],
			{},
			subsystemsRel,
		);
		expect(out.emitted).toEqual([]);
		expect(out.skipped).toContain('observability');
		// Imports MUST include the DynamicModule type alias …
		expect(out.content).toContain(
			"import type { DynamicModule } from '@nestjs/common';",
		);
		// … and the export must be the empty-array form (no composer fired).
		expect(out.content).toContain(
			'export const SUBSYSTEM_MODULES: DynamicModule[] = [];',
		);
	});

	test('events alone → 1 import + 1 forRoot call', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events']);
		expect(out.content).toContain(
			"import { EventsModule } from './shared/subsystems/events/events.module';",
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false }),",
		);
	});

	test('full minimum set composes events + jobs + bridge + integration (ordered)', () => {
		const out = buildSubsystemBarrel(
			[inst('integration'), inst('bridge'), inst('jobs'), inst('events')], // unsorted input
			{
				events: { backend: 'drizzle', multi_tenant: false },
				jobs: { backend: 'drizzle', multi_tenant: false, worker_mode: 'standalone' },
				bridge: { backend: 'drizzle', multi_tenant: false },
				integration: { backend: 'drizzle', multi_tenant: false },
			},
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events', 'jobs', 'bridge', 'integration']);
		// Module-call order matters at runtime (events provides IEventBus before
		// bridge subscribes; jobs orchestrator before integration invokes ExecuteIntegrationUseCase
		// via a job).
		const callIndices = ['EventsModule', 'JobsDomainModule', 'BridgeModule', 'IntegrationModule'].map(
			(m) => out.content.indexOf(`${m}.forRoot`),
		);
		expect(callIndices.every((i) => i >= 0)).toBe(true);
		expect(callIndices).toEqual([...callIndices].sort((a, b) => a - b));
	});

	test("jobs `worker_mode: 'embedded'` adds JobWorkerModule.forRoot", () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{ jobs: { backend: 'drizzle', worker_mode: 'embedded' } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"import { JobWorkerModule } from './shared/subsystems/jobs/job-worker.module';",
		);
		expect(out.content).toContain("JobWorkerModule.forRoot({ mode: 'embedded' }),");
	});

	test("jobs `worker_mode: 'standalone'` (default) does NOT add JobWorkerModule", () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{ jobs: { backend: 'drizzle' } },
			subsystemsRel,
		);
		expect(out.content).not.toContain('JobWorkerModule');
	});

	test('jobs `backend: bullmq` inlines the extensions block (BULLMQ-1)', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{
				jobs: {
					backend: 'bullmq',
					extensions: {
						bullmq: {
							redis_url: 'redis://localhost:16379',
							bull_board: { enabled: true, mount_path: '/api/admin/queues' },
						},
					},
				},
			},
			subsystemsRel,
		);
		expect(out.content).toContain("backend: 'bullmq'");
		expect(out.content).toContain('extensions: { bullmq: {');
		expect(out.content).toContain("redis_url: 'redis://localhost:16379'");
		expect(out.content).toContain("mount_path: '/api/admin/queues'");
		expect(out.content).toContain('enabled: true');
	});

	test("jobs `backend: bullmq` + embedded forwards to JobWorkerModule (BULLMQ-1)", () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{
				jobs: {
					backend: 'bullmq',
					worker_mode: 'embedded',
					extensions: { bullmq: { redis_url: 'redis://localhost:16379' } },
				},
			},
			subsystemsRel,
		);
		expect(out.content).toContain("backend: 'bullmq'");
		expect(out.content).toContain('JobWorkerModule.forRoot(');
		expect(out.content).toContain('domainModuleExtensions: { bullmq:');
	});

	test('subsystem `multi_tenant: true` propagates to forRoot as `multiTenant: true`', () => {
		const out = buildSubsystemBarrel(
			[inst('integration')],
			{ integration: { backend: 'drizzle', multi_tenant: true } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"IntegrationModule.forRoot({ backend: 'drizzle', multiTenant: true }),",
		);
	});

	test('installed subsystem without a composer is listed in `skipped`', () => {
		// `observability` / `auth` aren't in COMPOSABLE_ORDER yet — they should
		// register as skipped, not silently dropped.
		const out = buildSubsystemBarrel(
			[inst('events'), inst('observability')],
			{ events: {} },
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events']);
		expect(out.skipped).toContain('observability');
	});

	test('#4: an `incomplete` subsystem is NOT emitted (no phantom forRoot import)', () => {
		// An events-only install vendors `bridge/` protocol+token+schema stubs
		// (the events drizzle backend imports them) but NOT `bridge.module.ts`.
		// Detection tags that bridge dir `incomplete`; the barrel must skip it so
		// the consumer's tsc never sees `import { BridgeModule } from
		// '.../bridge/bridge.module'` against a file that doesn't exist.
		const out = buildSubsystemBarrel(
			[inst('events'), inst('bridge', 'incomplete')],
			{ events: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events']);
		expect(out.content).not.toContain('BridgeModule');
		expect(out.content).not.toContain('bridge/bridge.module');
		// An incomplete entry is neither emitted nor reported as skipped (skipped
		// means "installed but no composer yet").
		expect(out.skipped).not.toContain('bridge');
	});

	test('missing config block defaults to drizzle backend + multi_tenant=false', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{},
			subsystemsRel,
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false }),",
		);
	});

	// ─── Gate 1: embedded worker pool clause (BRIDGE-8) ──────────────────────

	test("embedded worker + bridge installed defaults to `allPools: true` (drains reserved events_* lanes)", () => {
		const out = buildSubsystemBarrel(
			[inst('events'), inst('jobs'), inst('bridge')],
			{
				events: {},
				jobs: { backend: 'drizzle', worker_mode: 'embedded' },
				bridge: {},
			},
			subsystemsRel,
		);
		expect(out.content).toContain(
			"JobWorkerModule.forRoot({ mode: 'embedded', allPools: true }),",
		);
	});

	test("embedded worker WITHOUT bridge stays `{ mode: 'embedded' }` (no pool clause)", () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{ jobs: { backend: 'drizzle', worker_mode: 'embedded' } },
			subsystemsRel,
		);
		expect(out.content).toContain("JobWorkerModule.forRoot({ mode: 'embedded' }),");
		expect(out.content).not.toContain('allPools');
		expect(out.content).not.toContain('pools:');
	});

	test('explicit `jobs.worker_pools` wins over the bridge default → emits `pools: [...]`', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs'), inst('bridge')],
			{
				jobs: {
					backend: 'drizzle',
					worker_mode: 'embedded',
					worker_pools: ['interactive', 'batch', 'events_inbound'],
				},
				bridge: {},
			},
			subsystemsRel,
		);
		expect(out.content).toContain(
			"JobWorkerModule.forRoot({ mode: 'embedded', pools: ['interactive', 'batch', 'events_inbound'] }),",
		);
		expect(out.content).not.toContain('allPools');
	});

	test('explicit `jobs.all_pools: true` emits `allPools: true` (even without bridge)', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{ jobs: { backend: 'drizzle', worker_mode: 'embedded', all_pools: true } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"JobWorkerModule.forRoot({ mode: 'embedded', allPools: true }),",
		);
	});

	test('bullmq embedded + bridge appends the pool clause after backend/extensions', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs'), inst('bridge')],
			{
				jobs: {
					backend: 'bullmq',
					worker_mode: 'embedded',
					extensions: { bullmq: { redis_url: 'redis://localhost:16379' } },
				},
				bridge: {},
			},
			subsystemsRel,
		);
		expect(out.content).toContain("backend: 'bullmq'");
		expect(out.content).toContain('domainModuleExtensions: { bullmq:');
		expect(out.content).toContain('allPools: true }),');
	});

	test('standalone worker + bridge does NOT emit a worker (pool clause is embedded-only)', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs'), inst('bridge')],
			{ jobs: { backend: 'drizzle', worker_mode: 'standalone' }, bridge: {} },
			subsystemsRel,
		);
		expect(out.content).not.toContain('JobWorkerModule');
		expect(out.content).not.toContain('allPools');
	});

	// ─── Gate 2b: vendored mode passes NO registry (runtime uses its own) ────

	test('vendored bridge composer emits no `registry` option (falls back to bundled)', () => {
		const out = buildSubsystemBarrel(
			[inst('bridge')],
			{ bridge: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),",
		);
		expect(out.content).not.toContain('registry:');
		expect(out.content).not.toContain('bridge-registry');
	});

	// ─── LISTEN-NOTIFY-1: drizzle extension threading ────────────────────────

	test('jobs `extensions.drizzle.listen_notify` threads into JobsDomainModule + embedded worker', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{
				jobs: {
					backend: 'drizzle',
					worker_mode: 'embedded',
					extensions: { drizzle: { listen_notify: true, poll_interval_ms: 250 } },
				},
			},
			subsystemsRel,
		);
		// Domain module (orchestrator emits the enqueue notify):
		expect(out.content).toContain(
			'JobsDomainModule.forRoot({ backend: \'drizzle\', extensions: { drizzle: { listenNotify: true, pollIntervalMs: 250 } } }),',
		);
		// Embedded worker (holds the listener + honors pollInterval):
		expect(out.content).toContain(
			'domainModuleExtensions: { drizzle: { listenNotify: true, pollIntervalMs: 250 } }',
		);
	});

	test('jobs drizzle extensions thread `pollIntervalMs` alone (listen_notify omitted → off by default)', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{
				jobs: {
					backend: 'drizzle',
					worker_mode: 'embedded',
					extensions: { drizzle: { poll_interval_ms: 500 } },
				},
			},
			subsystemsRel,
		);
		expect(out.content).toContain('pollIntervalMs: 500');
		expect(out.content).not.toContain('listenNotify');
	});

	test('jobs WITHOUT drizzle extensions stays byte-identical (no domainModuleExtensions clause)', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{ jobs: { backend: 'drizzle', worker_mode: 'embedded' } },
			subsystemsRel,
		);
		expect(out.content).toContain("JobsDomainModule.forRoot({ backend: 'drizzle', multiTenant: false }),");
		expect(out.content).not.toContain('domainModuleExtensions');
		expect(out.content).not.toContain('listenNotify');
	});

	test('events `extensions.drizzle.listen_notify` threads into EventsModule.forRoot (vendored)', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', extensions: { drizzle: { listen_notify: true } } } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, listenNotify: true }),",
		);
	});

	test('events WITHOUT listen_notify stays off-by-default (no listenNotify key)', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle' } },
			subsystemsRel,
		);
		expect(out.content).not.toContain('listenNotify');
	});
});

// ---------------------------------------------------------------------------
// ADR-037 — package-mode emission (imports off @pattern-stack/codegen, NOT the
// consumer's vendored relative path). Symptom #1 from the package-mode brief:
// the barrel must emit non-empty package-imported forRoots.
// ---------------------------------------------------------------------------

describe('buildSubsystemBarrel — package mode (ADR-037)', () => {
	const subsystemsRel = './shared/subsystems';

	test('full set imports module classes from package subpaths, not the vendored tree', () => {
		const out = buildSubsystemBarrel(
			[inst('events'), inst('jobs'), inst('bridge'), inst('integration')],
			{
				events: { backend: 'drizzle', multi_tenant: false },
				jobs: { backend: 'drizzle', worker_mode: 'standalone' },
				bridge: { backend: 'drizzle' },
				integration: { backend: 'drizzle' },
			},
			subsystemsRel,
			'package',
		);
		expect(out.emitted).toEqual(['events', 'jobs', 'bridge', 'integration']);

		// EventsModule comes off the single top-level barrel.
		expect(out.content).toContain(
			"import { EventsModule } from '@pattern-stack/codegen/subsystems';",
		);
		// Jobs / bridge / integration are NOT on the single barrel — they resolve
		// through the per-subsystem runtime index.
		expect(out.content).toContain(
			"import { JobsDomainModule } from '@pattern-stack/codegen/runtime/subsystems/jobs/index';",
		);
		expect(out.content).toContain(
			"import { BridgeModule } from '@pattern-stack/codegen/runtime/subsystems/bridge/index';",
		);
		expect(out.content).toContain(
			"import { IntegrationModule } from '@pattern-stack/codegen/runtime/subsystems/integration/index';",
		);
		// The forRoot calls are still emitted.
		expect(out.content).toContain('EventsModule.forRoot(');
		expect(out.content).toContain('JobsDomainModule.forRoot(');
		expect(out.content).toContain('BridgeModule.forRoot(');
		expect(out.content).toContain('IntegrationModule.forRoot(');
		// And it must NOT reference the vendored relative path in package mode.
		expect(out.content).not.toContain('./shared/subsystems/');
	});

	test("jobs `worker_mode: 'embedded'` imports JobWorkerModule from the package", () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{ jobs: { backend: 'drizzle', worker_mode: 'embedded' } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"import { JobWorkerModule } from '@pattern-stack/codegen/runtime/subsystems/jobs/index';",
		);
		expect(out.content).toContain("JobWorkerModule.forRoot({ mode: 'embedded' }),");
	});

	test('package-mode events listen_notify threads listenNotify alongside typedBus (LISTEN-NOTIFY-1)', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', extensions: { drizzle: { listen_notify: true } } } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, typedBus: TypedEventBus, listenNotify: true }),",
		);
	});

	test('package-mode jobs drizzle extensions thread into the embedded worker (LISTEN-NOTIFY-1)', () => {
		const out = buildSubsystemBarrel(
			[inst('jobs')],
			{
				jobs: {
					backend: 'drizzle',
					worker_mode: 'embedded',
					extensions: { drizzle: { listen_notify: true } },
				},
			},
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain('domainModuleExtensions: { drizzle: { listenNotify: true } }');
	});

	test('vendored mode (explicit) still emits the relative-path imports', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
			'vendored',
		);
		expect(out.content).toContain(
			"import { EventsModule } from './shared/subsystems/events/events.module';",
		);
		// The package specifier must not appear on any IMPORT line (the HEADER
		// banner legitimately contains "@pattern-stack/codegen").
		const importLines = out.content
			.split('\n')
			.filter((l) => l.startsWith('import '));
		expect(importLines.some((l) => l.includes('@pattern-stack/codegen'))).toBe(
			false,
		);
	});

	// ─── Gate 2b: package mode threads the consumer's generated registry ─────

	test('package-mode bridge composer imports ./bridge-registry and passes it to forRoot', () => {
		const out = buildSubsystemBarrel(
			[inst('bridge')],
			{ bridge: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"import { bridgeRegistry } from './bridge-registry';",
		);
		expect(out.content).toContain(
			"BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false, registry: bridgeRegistry }),",
		);
	});

	test('package-mode embedded worker + bridge: allPools AND registry both emitted', () => {
		const out = buildSubsystemBarrel(
			[inst('events'), inst('jobs'), inst('bridge')],
			{
				events: {},
				jobs: { backend: 'drizzle', worker_mode: 'embedded' },
				bridge: { backend: 'drizzle', multi_tenant: false },
			},
			subsystemsRel,
			'package',
		);
		// Gate 1 — the embedded worker drains every lane (reserved included).
		expect(out.content).toContain(
			"JobWorkerModule.forRoot({ mode: 'embedded', allPools: true }),",
		);
		// Gate 2b — the consumer registry is threaded in.
		expect(out.content).toContain(
			"import { bridgeRegistry } from './bridge-registry';",
		);
		expect(out.content).toContain('registry: bridgeRegistry }),');
	});

	test('package-mode `multi_tenant: true` survives the manual registry literal', () => {
		const out = buildSubsystemBarrel(
			[inst('bridge')],
			{ bridge: { backend: 'drizzle', multi_tenant: true } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"BridgeModule.forRoot({ backend: 'drizzle', multiTenant: true, registry: bridgeRegistry }),",
		);
	});

	// ─── Events seam: package mode threads the consumer's TypedEventBus ──────

	test('package-mode events composer imports ./events/bus and passes typedBus', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"import { TypedEventBus } from './events/bus';",
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, typedBus: TypedEventBus }),",
		);
	});

	test('vendored events composer emits no typedBus (uses the runtime bundled bus)', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
			'vendored',
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false }),",
		);
		expect(out.content).not.toContain('typedBus');
		expect(out.content).not.toContain('./events/bus');
	});
});
