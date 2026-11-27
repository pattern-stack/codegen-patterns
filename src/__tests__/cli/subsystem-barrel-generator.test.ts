/**
 * Subsystem barrel generator tests.
 *
 * Cover:
 *   - empty installed set → empty barrel + DynamicModule[] type
 *   - single subsystem (events) → 1 import + 1 forRoot call
 *   - full minimum set (events+jobs+bridge+integration) → 4 imports + 4 calls
 *   - jobs → one JobsEngineModule.forRoot; `worker_mode` sets `worker` (JOBS-3)
 *   - per-subsystem config plumbed through (multi_tenant → multiTenant)
 *   - subsystems in install list but with no composer are listed in `skipped`
 *   - the subsystems root is `<backend_src>/shared/subsystems` (there is no
 *     `paths.subsystems` key, PATH-1 #645)
 */

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { buildSubsystemBarrel } from '../../cli/shared/subsystem-barrel-generator.js';
import type { InstalledSubsystem } from '../../cli/shared/subsystem-detect.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

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
		// only non-composer subsystems (auth / auth-integrations). `allCalls` is
		// empty, so the prior code returned `HEADER + 'export const
		// SUBSYSTEM_MODULES: DynamicModule[] = [];'` with no `DynamicModule`
		// import. tsc TS2304. (#473: observability now HAS a composer, so `auth`
		// is the composer-less example.)
		const out = buildSubsystemBarrel(
			[inst('auth')],
			{},
			subsystemsRel,
		);
		expect(out.emitted).toEqual([]);
		expect(out.skipped).toContain('auth');
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
		// ADR-039 — vendored events composer threads the consumer's generated
		// eventRegistry so EventSchedulerLifecycle can spawn the scheduler.
		expect(out.content).toContain(
			"import { eventRegistry } from './shared/subsystems/events/generated/registry';",
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, eventRegistry }),",
		);
	});

	test('full minimum set composes events + jobs + bridge + integration (ordered)', () => {
		const out = buildSubsystemBarrel(
			[inst('integration'), inst('bridge'), inst('jobs'), inst('events')], // unsorted input
			{
				events: { backend: 'drizzle', multi_tenant: false },
				jobs: { worker_mode: 'standalone' },
				bridge: { backend: 'drizzle', multi_tenant: false },
				integration: { backend: 'drizzle', multi_tenant: false },
			},
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events', 'jobs', 'bridge', 'integration']);
		// Module-call order matters at runtime (events provides IEventBus before
		// bridge subscribes; jobs orchestrator before integration invokes ExecuteIntegrationUseCase
		// via a job).
		const callIndices = ['EventsModule', 'JobsEngineModule', 'BridgeModule', 'IntegrationModule'].map(
			(m) => out.content.indexOf(`${m}.forRoot`),
		);
		expect(callIndices.every((i) => i >= 0)).toBe(true);
		expect(callIndices).toEqual([...callIndices].sort((a, b) => a - b));
	});

	test('jobs `worker_mode` absent composes what the jobs-config scaffold writes — embedded (JOBS-1, #659)', () => {
		// The scaffold's config block states `worker_mode: embedded`; the schema's
		// one default says the same for a block that omits it (or no block at all).
		const block = fs.readFileSync(
			path.join(REPO_ROOT, 'templates/subsystem/jobs-config/codegen-config-jobs-block.ejs.t'),
			'utf-8',
		);
		const scaffolded = /^\s*worker_mode:\s*(\w+)/m.exec(block)?.[1];
		expect(scaffolded).toBe('embedded');
		const stated = buildSubsystemBarrel([inst('jobs')], { jobs: { worker_mode: scaffolded } }, subsystemsRel);
		for (const cfg of [{ jobs: {} }, {}]) {
			expect(buildSubsystemBarrel([inst('jobs')], cfg, subsystemsRel).content).toBe(stated.content);
		}
		expect(stated.content).toContain('worker: true');
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

	test('integration `differ.unignore` threads into IntegrationModule.forRoot (DIFFER-UNIGNORE)', () => {
		const out = buildSubsystemBarrel(
			[inst('integration')],
			{ integration: { backend: 'drizzle', differ: { unignore: ['deletedAt'] } } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"IntegrationModule.forRoot({ backend: 'drizzle', multiTenant: false, differ: { unignore: ['deletedAt'] } }),",
		);
	});

	test('integration `differ.ignore` + `differ.unignore` both thread', () => {
		const out = buildSubsystemBarrel(
			[inst('integration')],
			{
				integration: {
					backend: 'drizzle',
					differ: { ignore: ['internalSeq'], unignore: ['deletedAt'] },
				},
			},
			subsystemsRel,
		);
		expect(out.content).toContain(
			"differ: { ignore: ['internalSeq'], unignore: ['deletedAt'] }",
		);
	});

	test('integration WITHOUT a differ block stays byte-identical (no differ clause)', () => {
		const out = buildSubsystemBarrel(
			[inst('integration')],
			{ integration: { backend: 'drizzle' } },
			subsystemsRel,
		);
		expect(out.content).toContain("IntegrationModule.forRoot({ backend: 'drizzle', multiTenant: false }),");
		expect(out.content).not.toContain('differ:');
	});

	test('integration empty `differ` block (no lists) emits no differ clause', () => {
		const out = buildSubsystemBarrel(
			[inst('integration')],
			{ integration: { backend: 'drizzle', differ: {} } },
			subsystemsRel,
		);
		expect(out.content).not.toContain('differ:');
	});

	test('installed subsystem without a composer is listed in `skipped`', () => {
		// `auth` has no composer — it should register as skipped, not silently
		// dropped. (#473: observability now HAS a composer; `auth` is the example.)
		const out = buildSubsystemBarrel(
			[inst('events'), inst('auth')],
			{ events: {} },
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events']);
		expect(out.skipped).toContain('auth');
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
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, eventRegistry }),",
		);
	});

	// ─── JOBS-3: one JobsEngineModule.forRoot on @pattern-stack/jobs ─────────

	const ENGINE_CALL = (worker: boolean) =>
		`JobsEngineModule.forRoot({ definitions: jobDefinitions, worker: ${worker}, limiters: jobLimiters, inProcess: jobsInProcessOptions }),`;

	test("jobs `worker_mode: 'embedded'` runs the executor in this process (`worker: true`)", () => {
		const out = buildSubsystemBarrel([inst('jobs')], { jobs: { worker_mode: 'embedded' } }, subsystemsRel);
		expect(out.content).toContain(
			"import { JobsEngineModule } from './shared/subsystems/jobs/jobs-engine.module';",
		);
		// The pools as limiters and the executor's knobs come from app-config; the jobs from the generated registry.
		expect(out.content).toContain("import { jobLimiters, jobsInProcessOptions } from './app-config';");
		expect(out.content).toContain("import { jobDefinitions } from './jobs';");
		expect(out.content).toContain(ENGINE_CALL(true));
		for (const gone of ['JobsDomainModule', 'JobWorkerModule', 'jobPools', 'allPools'])
			expect(out.content).not.toContain(gone);
	});

	test("jobs `worker_mode: 'standalone'` leaves the executor to src/worker.ts (`worker: false`)", () => {
		const out = buildSubsystemBarrel([inst('jobs')], { jobs: { worker_mode: 'standalone' } }, subsystemsRel);
		expect(out.content).toContain(ENGINE_CALL(false));
	});

	test('jobs + bridge: the bridge adds no pool clause to the jobs line (no reserved events_* pools)', () => {
		const out = buildSubsystemBarrel(
			[inst('events'), inst('jobs'), inst('bridge')],
			{ events: {}, jobs: {}, bridge: {} },
			subsystemsRel,
		);
		expect(out.content).toContain(ENGINE_CALL(true));
		expect(out.content).not.toContain('allPools');
	});

	test('a removed jobs key (ADR-022 `backend`) is refused, not ignored', () => {
		expect(() => buildSubsystemBarrel([inst('jobs')], { jobs: { backend: 'drizzle' } }, subsystemsRel)).toThrow();
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

	test('events `extensions.drizzle.listen_notify` threads into EventsModule.forRoot (vendored)', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', extensions: { drizzle: { listen_notify: true } } } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, eventRegistry, listenNotify: true }),",
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
				jobs: { worker_mode: 'standalone' },
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
			"import { JobsEngineModule } from '@pattern-stack/codegen/runtime/subsystems/jobs/index';",
		);
		expect(out.content).toContain(
			"import { BridgeModule } from '@pattern-stack/codegen/runtime/subsystems/bridge/index';",
		);
		expect(out.content).toContain(
			"import { IntegrationModule } from '@pattern-stack/codegen/runtime/subsystems/integration/index';",
		);
		// The forRoot calls are still emitted.
		expect(out.content).toContain('EventsModule.forRoot(');
		expect(out.content).toContain('JobsEngineModule.forRoot(');
		expect(out.content).toContain('BridgeModule.forRoot(');
		expect(out.content).toContain('IntegrationModule.forRoot(');
		// And it must NOT reference the vendored relative path in package mode.
		expect(out.content).not.toContain('./shared/subsystems/');
	});

	test('package-mode events listen_notify threads listenNotify alongside typedBus (LISTEN-NOTIFY-1)', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', extensions: { drizzle: { listen_notify: true } } } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, typedBus: TypedEventBus, eventRegistry, listenNotify: true }),",
		);
	});

	test('package mode imports JobsEngineModule from the package runtime index', () => {
		const out = buildSubsystemBarrel([inst('jobs')], { jobs: {} }, subsystemsRel, 'package');
		expect(out.content).toContain(
			"import { JobsEngineModule } from '@pattern-stack/codegen/runtime/subsystems/jobs/index';",
		);
		expect(out.content).toContain("import { jobDefinitions } from './jobs';");
	});

	test('package-mode integration differ.unignore threads into forRoot (DIFFER-UNIGNORE)', () => {
		const out = buildSubsystemBarrel(
			[inst('integration')],
			{ integration: { backend: 'drizzle', differ: { unignore: ['deletedAt'] } } },
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"import { IntegrationModule } from '@pattern-stack/codegen/runtime/subsystems/integration/index';",
		);
		expect(out.content).toContain("differ: { unignore: ['deletedAt'] }");
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
		// ADR-039 — package mode threads eventRegistry from ./events/registry.
		expect(out.content).toContain(
			"import { eventRegistry } from './events/registry';",
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, typedBus: TypedEventBus, eventRegistry }),",
		);
	});

	test('vendored events composer emits no typedBus (uses the runtime bundled bus) but DOES thread eventRegistry', () => {
		const out = buildSubsystemBarrel(
			[inst('events')],
			{ events: { backend: 'drizzle', multi_tenant: false } },
			subsystemsRel,
			'vendored',
		);
		expect(out.content).toContain(
			"EventsModule.forRoot({ backend: 'drizzle', multiTenant: false, eventRegistry }),",
		);
		expect(out.content).not.toContain('typedBus');
		expect(out.content).not.toContain('./events/bus');
		// ADR-039 — vendored mode still threads eventRegistry (from the vendored
		// generated dir), since EventSchedulerLifecycle has no bundled fallback.
		expect(out.content).toContain(
			"import { eventRegistry } from './shared/subsystems/events/generated/registry';",
		);
	});

	// ADR-039 regression guard — the 0.20.0 dogfood gap was that NEITHER mode
	// threaded eventRegistry, so EventSchedulerLifecycle never spawned and
	// scheduled events silently didn't tick. Assert both modes thread it.
	test('eventRegistry is threaded into forRoot in BOTH modes (scheduler-spawn regression guard)', () => {
		for (const mode of ['package', 'vendored'] as const) {
			const out = buildSubsystemBarrel(
				[inst('events')],
				{ events: { backend: 'drizzle', multi_tenant: false } },
				subsystemsRel,
				mode,
			);
			// The forRoot call must carry the eventRegistry option.
			expect(out.content).toMatch(/EventsModule\.forRoot\(\{[^}]*eventRegistry[^}]*\}\)/);
			// And the symbol must be imported (no dangling reference).
			expect(out.content).toMatch(/import \{ eventRegistry \} from '[^']+'/);
		}
	});

	// ─── #473: observability composer ────────────────────────────────────────

	test('observability composer emits ObservabilityModule.forRoot() (vendored)', () => {
		const out = buildSubsystemBarrel(
			[inst('observability')],
			{},
			subsystemsRel,
			'vendored',
		);
		expect(out.emitted).toEqual(['observability']);
		expect(out.content).toContain(
			"import { ObservabilityModule } from './shared/subsystems/observability/observability.module';",
		);
		// No reporter enabled → bare forRoot (matches the off-by-default scaffold).
		expect(out.content).toContain('ObservabilityModule.forRoot(),');
		// No backend/multiTenant — it's a combiner with no durable state.
		expect(out.content).not.toMatch(/ObservabilityModule\.forRoot\(\{[^}]*backend/);
	});

	test('observability composer emits ObservabilityModule.forRoot() (package)', () => {
		const out = buildSubsystemBarrel(
			[inst('observability')],
			{},
			subsystemsRel,
			'package',
		);
		expect(out.content).toContain(
			"import { ObservabilityModule } from '@pattern-stack/codegen/runtime/subsystems/observability/index';",
		);
		expect(out.content).toContain('ObservabilityModule.forRoot(),');
	});

	test('observability registers AFTER the read ports it composes (jobs/bridge/integration)', () => {
		const out = buildSubsystemBarrel(
			[
				inst('observability'),
				inst('integration'),
				inst('bridge'),
				inst('jobs'),
				inst('events'),
			], // deliberately unsorted input
			{
				events: {},
				jobs: { worker_mode: 'standalone' },
				bridge: {},
				integration: {},
			},
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events', 'jobs', 'bridge', 'integration', 'observability']);
		const idx = (frag: string) => out.content.indexOf(frag);
		// ObservabilityModule.forRoot must appear after every composed sibling's forRoot.
		const obs = idx('ObservabilityModule.forRoot');
		expect(obs).toBeGreaterThan(idx('JobsEngineModule.forRoot'));
		expect(obs).toBeGreaterThan(idx('BridgeModule.forRoot'));
		expect(obs).toBeGreaterThan(idx('IntegrationModule.forRoot'));
		expect(obs).toBeGreaterThan(idx('EventsModule.forRoot'));
	});

	test('observability threads reporters config only when a reporter is enabled', () => {
		// Off-by-default scaffold (enabled: false) → bare forRoot.
		const off = buildSubsystemBarrel(
			[inst('observability')],
			{ observability: { reporters: { bridgeMetrics: { enabled: false, intervalMs: 60000, windowHours: 24 } } } },
			subsystemsRel,
		);
		expect(off.content).toContain('ObservabilityModule.forRoot(),');
		expect(off.content).not.toContain('reporters');

		// Operator opts in (enabled: true) → reporters block threaded.
		const on = buildSubsystemBarrel(
			[inst('observability')],
			{ observability: { reporters: { bridgeMetrics: { enabled: true, intervalMs: 60000, windowHours: 1 } } } },
			subsystemsRel,
		);
		expect(on.content).toContain(
			'ObservabilityModule.forRoot({ reporters: { bridgeMetrics: { enabled: true, intervalMs: 60000, windowHours: 1 } } }),',
		);
	});
});
