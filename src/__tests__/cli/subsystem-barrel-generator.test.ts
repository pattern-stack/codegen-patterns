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
});
