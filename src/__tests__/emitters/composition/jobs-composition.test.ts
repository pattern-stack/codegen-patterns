/**
 * Jobs and the bridge in the pattern-stack composition (J-1): the `jobs` system, the `jobDeps` module that provides each
 * job factory's composition parts (typed by the factory), the events system's bus draining through the bridge, and the
 * refusals. `test-smoke-pattern-stack` compiles and runs the same text; this pins what each file declares.
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import ts from 'typescript';

import { loadProjectApiContext } from '../../../derived/api/project';
import { deriveProjectSettings } from '../../../derived/settings';
import { planComposition, type CompositionJobsInput } from '../../../emitters/composition/emit-composition';
import { extractJobsFromSourceFile } from '../../../cli/shared/job-registry-generator';
import { rowFor } from '../../../utils/keyed-row';

const FIXTURES = path.resolve(import.meta.dir, '../../../../test/smoke/fixtures-pattern-stack');
const JUNCTIONS = path.resolve(import.meta.dir, '../../../../test/smoke/fixtures-pattern-stack-junctions');
const ROOT = '/app/src';

const EVENTS = {
	backend: 'drizzle' as const,
	multiTenant: false,
	listenNotify: false,
	backendImport: '@shared/subsystems/events/event-bus.drizzle-backend',
	coreImport: '@shared/subsystems/events/core',
	generatedEventsDir: `${ROOT}/shared/subsystems/events/generated`,
};

const BRIDGE = { coreImport: '@shared/subsystems/bridge/core', registryFile: `${ROOT}/shared/subsystems/bridge/generated/registry.ts` };

function jobsInput(over: Partial<CompositionJobsInput> = {}): CompositionJobsInput {
	return {
		coreImport: '@shared/subsystems/jobs/core',
		factories: [
			{
				exportName: 'invoiceFollowUp',
				file: `${ROOT}/jobs/smoke.job.ts`,
				deps: [
					{ name: 'billing', part: 'billing' },
					{ name: 'crm', part: 'crm' },
				],
			},
		],
		bridge: BRIDGE,
		registry: { path: `${ROOT}/generated/jobs.ts`, content: '// the job registry, from the same scan' },
		...over,
	};
}

function plan(jobs: CompositionJobsInput | null, events: typeof EVENTS | { backend: 'memory' } & Omit<typeof EVENTS, 'backend'> = EVENTS) {
	const files = planComposition({
		relations: loadProjectApiContext(ROOT, null, {
			entitiesDir: FIXTURES,
			junctionsDir: JUNCTIONS,
			relationshipsDir: '/nonexistent/relationships',
		}).relations,
		modulesDir: `${ROOT}/modules`,
		generatedDir: `${ROOT}/generated`,
		drizzleTypeImport: '@shared/types/drizzle',
		commandsImport: '@shared/commands',
		openApiImport: '@shared/openapi',
		banner: '// @generated',
		events,
		settings: {
			settings: deriveProjectSettings({ providers: [], installedSubsystems: ['jobs'], wiring: 'pattern-stack' }),
			runtimeImport: '@shared/settings',
		},
		jobs,
		dryRun: true,
	});
	return {
		paths: files.map((f) => f.path),
		get: (suffix: string) => {
			const f = files.find((x) => x.path.endsWith(suffix));
			if (!f) throw new Error(`no file ending ${suffix}: ${files.map((x) => x.path).join(', ')}`);
			return f.content;
		},
	};
}

describe('the jobs system (J-1)', () => {
	it('builds the engine over the job registry, the pools and knobs, and JOBS_WORKER; lists it after settings', () => {
		const { get } = plan(jobsInput());
		const system = get('/generated/jobs-system.ts');
		expect(system).toContain("import { createJobsEngine, type JobsEngine } from '@shared/subsystems/jobs/core';");
		expect(system).toContain("import { jobLimiters, jobsInProcessOptions } from './app-config';");
		expect(system).toContain("import { jobDefinitions } from './jobs';");
		expect(system).toContain("uses: ['database', 'settings'],");
		expect(system).toContain("worker: settings.jobs.worker === 'true',");
		expect(system).toContain('start: (jobs) => jobs.start(),');
		expect(get('/generated/wiring.ts')).toContain('  jobs: JobsApi;');
		expect(get('/generated/composition.ts')).toContain('export const SYSTEMS = [settingsSystem, jobsSystem, eventsSystem] as const;');
		// The settings carry the worker flag (pattern-stack only).
		expect(get('/generated/settings.ts')).toContain('JOBS_WORKER');
	});

	it('writes the job registry beside job-deps.ts, so every command that writes the composition writes both (review #985)', () => {
		const { get } = plan(jobsInput());
		expect(get('/generated/jobs.ts')).toBe('// the job registry, from the same scan');
		expect(get('/generated/job-deps.ts')).toContain('deps.jobs.provide(invoiceFollowUp');
	});

	it('no jobs system without the subsystem', () => {
		const { paths, get } = plan(null);
		expect(paths.some((p) => p.endsWith('jobs-system.ts') || p.endsWith('job-deps.ts'))).toBe(false);
		expect(get('/generated/wiring.ts')).not.toContain('JobsApi');
	});
});

describe('the jobDeps module (J-1)', () => {
	it("provides each factory exactly its parts, typed by the factory; dependsOn only the modules named; composed last", () => {
		const { get } = plan(jobsInput());
		const deps = get('/generated/job-deps.ts');
		expect(deps).toContain("import { invoiceFollowUp } from '../jobs/smoke.job';");
		expect(deps).toContain("dependsOn: ['billing', 'crm'],");
		expect(deps).toContain("uses: ['jobs'],");
		expect(deps).toContain('    deps.jobs.provide(invoiceFollowUp, { billing: deps.billing, crm: deps.crm });');
		// Created last, stopped first: its stop stops the engine before any module stops.
		expect(deps).toContain('stop: ({ jobs }) => jobs.stop(),');
		expect(get('/generated/wiring.ts')).toContain('  jobDeps: JobDepsModule;');
		expect(get('/generated/composition.ts')).toMatch(/export const MODULES = \[.*, jobDepsModule\] as const;/);
	});

	it('a part that is a system is used, not depended on', () => {
		const { get } = plan(jobsInput({ factories: [{ exportName: 'f', file: `${ROOT}/jobs/f.job.ts`, deps: [{ name: 'bus', part: 'events' }] }] }));
		const deps = get('/generated/job-deps.ts');
		expect(deps).toContain('dependsOn: [],');
		expect(deps).toContain("uses: ['jobs', 'events'],");
	});

	it('no module when no factory names a part (plain jobs, or a factory with no deps)', () => {
		const { paths } = plan(jobsInput({ factories: [{ exportName: 'f', file: `${ROOT}/jobs/f.job.ts`, deps: [] }] }));
		expect(paths.some((p) => p.endsWith('job-deps.ts'))).toBe(false);
	});

	it('refuses a dependency that names no part (a class token), and a part the composition lacks, naming the job', () => {
		expect(() => plan(jobsInput({ factories: [{ exportName: 'f', file: `${ROOT}/jobs/f.job.ts`, deps: [{ name: 'svc' }] }] }))).toThrow(
			/job factory 'f' \(\.\.\/jobs\/f\.job\.ts\): its dependency 'svc' must name a composition part/,
		);
		expect(() =>
			plan(jobsInput({ factories: [{ exportName: 'f', file: `${ROOT}/jobs/f.job.ts`, deps: [{ name: 'x', part: 'nowhere' }] }] })),
		).toThrow(/its dependency 'x' names 'nowhere', which this composition has no module or system of: billing, crm, .*, jobs, events$/);
	});
});

describe('the bridge on the events system (J-1)', () => {
	it("the drizzle bus drains through the bridge's drainer, checked at compose, over the jobs starter", () => {
		const events = plan(jobsInput()).get('/generated/events-system.ts');
		expect(events).toContain("import { BridgeOutboxDrainer, DrizzleBridgeDeliveries } from '@shared/subsystems/bridge/core';");
		expect(events).toContain("import { bridgeRegistry } from '../shared/subsystems/bridge/generated/registry';");
		expect(events).toContain("uses: ['database', 'jobs'],");
		expect(events).toContain('    const deliveries = new DrizzleBridgeDeliveries(database.db, options.multiTenant ?? false);');
		expect(events).toContain('    const drainer = new BridgeOutboxDrainer(jobs.starter, deliveries, bridgeRegistry);');
		expect(events).toContain('    drainer.assertTriggersRegistered();');
		expect(events).toContain('    const bus = new DrizzleEventBus(database.db, options, drainer);');
	});

	it('jobs without the bridge leave the events system as it is with no jobs: no drain, no jobs use', () => {
		const withJobsNoBridge = plan(jobsInput({ bridge: null })).get('/generated/events-system.ts');
		const withoutJobs = plan(null).get('/generated/events-system.ts');
		expect(withJobsNoBridge).toBe(withoutJobs);
		expect(withoutJobs).toContain("uses: ['database'],");
		expect(withoutJobs).toContain('    const bus = new DrizzleEventBus(database.db, options);');
	});

	it('the memory bus takes no drain', () => {
		const events = plan(jobsInput(), { ...EVENTS, backend: 'memory' }).get('/generated/events-system.ts');
		expect(events).not.toContain('BridgeOutboxDrainer');
		expect(events).toContain('    const bus = new MemoryEventBus(options);');
	});
});

describe('the job registry scan reads a factory\'s dependencies (J-1)', () => {
	it('each dependency, and the part an injected string names; a class token has none', () => {
		const src = `
import { defineJob, injected, jobFactory } from '@pattern-stack/jobs';
export const plain = defineJob({ key: 'p' } as never);
export const withDeps = jobFactory({ deps: { billing: injected<B>('billing'), clock: Clock }, create: () => plain });
`;
		const jobs = extractJobsFromSourceFile(ts.createSourceFile('a.job.ts', src, ts.ScriptTarget.Latest, true), '/a.job.ts');
		expect(jobs).toEqual([
			{ name: 'plain', file: '/a.job.ts' },
			{ name: 'withDeps', file: '/a.job.ts', deps: [{ name: 'billing', token: 'billing' }, { name: 'clock' }] },
		]);
	});
});

describe('a dependency the scan cannot read is refused by name, never dropped (J-1 review)', () => {
	it('a shorthand, a spread, or deps that are not an object literal', () => {
		const src = `
export const a = jobFactory({ deps: { integrations }, create: () => x });
export const b = jobFactory({ deps: { ...shared }, create: () => x });
export const c = jobFactory({ deps: sharedDeps, create: () => x });
`;
		const jobs = extractJobsFromSourceFile(ts.createSourceFile('a.job.ts', src, ts.ScriptTarget.Latest, true), '/a.job.ts');
		expect(jobs.map((j) => j.deps)).toEqual([
			[{ name: 'integrations', unreadable: 'a shorthand property' }],
			[{ name: '...shared', unreadable: 'not a `name: injected(…)` property' }],
			[{ name: 'sharedDeps', unreadable: '`deps` is not an object literal' }],
		]);
		// Review #985: the forms that used to read as "no dependencies", and a key the jobDeps module couldn't write.
		const more = `
export const d = jobFactory({ deps, create: () => x });
export const e = jobFactory(spec);
export const f = jobFactory({ deps: { 'my-dep': injected<C>('crm'), ok: injected<C>('crm') }, create: () => x });
`;
		const read = extractJobsFromSourceFile(ts.createSourceFile('b.job.ts', more, ts.ScriptTarget.Latest, true), '/b.job.ts');
		expect(read.map((j) => j.deps)).toEqual([
			[{ name: 'deps', unreadable: '`deps` is a shorthand, not `deps: { … }`' }],
			[{ name: 'spec', unreadable: 'the factory spec is not an object literal' }],
			[{ name: 'my-dep', unreadable: 'a key that is not an identifier' }, { name: 'ok', token: 'crm' }],
		]);
		expect(() =>
			plan(jobsInput({ factories: [{ exportName: 'a', file: `${ROOT}/jobs/a.job.ts`, deps: [{ name: 'integrations', unreadable: 'a shorthand property' }] }] })),
		).toThrow(/job factory 'a' .*: its dependency 'integrations' is a shorthand property, which codegen cannot read/);
	});
});

describe('rowFor (a choice made from a config value is a table)', () => {
	it('reads the row, and refuses a value with no row by naming the rows', () => {
		const table = { nest: 1, 'pattern-stack': 2 } as const;
		expect(rowFor('target.wiring', table, 'pattern-stack')).toBe(2);
		expect(() => rowFor('target.wiring', table, 'hono')).toThrow("target.wiring 'hono' has no row; the rows are: nest, pattern-stack");
	});
});

describe('which events backend the bridge can drain is the event bus row (review #985)', () => {
	it('drizzle drains its outbox, memory does not, and an unknown backend is refused by the rows', async () => {
		const { eventBusDrainsOutbox, outboxEventBackends } = await import('../../../emitters/composition/emit-composition');
		expect(eventBusDrainsOutbox('drizzle')).toBe(true);
		expect(eventBusDrainsOutbox('memory')).toBe(false);
		expect(outboxEventBackends()).toEqual(['drizzle']);
		expect(() => eventBusDrainsOutbox('kafka')).toThrow(/events backend 'kafka' has no row/);
	});
});

describe("the jobs system's worker flag is the declared JOBS_WORKER setting (review #985)", () => {
	it('renders the row the settings declare, and refuses jobs without it, naming the setting', () => {
		expect(plan(jobsInput()).get('/generated/jobs-system.ts')).toContain("worker: settings.jobs.worker === 'true',");
		const withoutSettings = () =>
			planComposition({
				relations: { entities: [], definitions: new Map(), junctions: [], tenancyColumn: 'tenant_id' },
				modulesDir: `${ROOT}/modules`,
				generatedDir: `${ROOT}/generated`,
				drizzleTypeImport: '@shared/types/drizzle',
				commandsImport: '@shared/commands',
				openApiImport: '@shared/openapi',
				banner: '// @generated',
				jobs: jobsInput({ factories: [] }),
				dryRun: true,
			} as never);
		expect(withoutSettings).toThrow(/worker flag \(JOBS_WORKER\) from the settings system, but this composition has no settings system/);
	});
});
