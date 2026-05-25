/**
 * Subsystem barrel generator tests.
 *
 * Cover:
 *   - empty installed set → empty barrel + DynamicModule[] type
 *   - single subsystem (events) → 1 import + 1 forRoot call
 *   - full minimum set (events+jobs+bridge+sync) → 4 imports + 4 calls
 *   - jobs `worker_mode: 'embedded'` adds JobWorkerModule
 *   - per-subsystem config plumbed through (multi_tenant → multiTenant)
 *   - subsystems in install list but with no composer are listed in `skipped`
 *   - subsystems root path override via `paths.subsystems` honored
 */

import { describe, test, expect } from 'bun:test';

import { buildSubsystemBarrel } from '../../cli/shared/subsystem-barrel-generator.js';
import type { InstalledSubsystem } from '../../cli/shared/subsystem-detect.js';

function inst(name: InstalledSubsystem['name']): InstalledSubsystem {
	return { name, path: `/fake/${name}`, backend: 'drizzle' };
}

describe('buildSubsystemBarrel', () => {
	const subsystemsRel = './shared/subsystems';

	test('empty installed set produces empty array (with DynamicModule type)', () => {
		const out = buildSubsystemBarrel([], {}, subsystemsRel);
		expect(out.content).toContain(
			'export const SUBSYSTEM_MODULES: DynamicModule[] = [];',
		);
		expect(out.emitted).toEqual([]);
		expect(out.skipped).toEqual([]);
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

	test('full minimum set composes events + jobs + bridge + sync (ordered)', () => {
		const out = buildSubsystemBarrel(
			[inst('sync'), inst('bridge'), inst('jobs'), inst('events')], // unsorted input
			{
				events: { backend: 'drizzle', multi_tenant: false },
				jobs: { backend: 'drizzle', multi_tenant: false, worker_mode: 'standalone' },
				bridge: { backend: 'drizzle', multi_tenant: false },
				sync: { backend: 'drizzle', multi_tenant: false },
			},
			subsystemsRel,
		);
		expect(out.emitted).toEqual(['events', 'jobs', 'bridge', 'sync']);
		// Module-call order matters at runtime (events provides IEventBus before
		// bridge subscribes; jobs orchestrator before sync invokes ExecuteSyncUseCase
		// via a job).
		const callIndices = ['EventsModule', 'JobsDomainModule', 'BridgeModule', 'SyncModule'].map(
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
			[inst('sync')],
			{ sync: { backend: 'drizzle', multi_tenant: true } },
			subsystemsRel,
		);
		expect(out.content).toContain(
			"SyncModule.forRoot({ backend: 'drizzle', multiTenant: true }),",
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
