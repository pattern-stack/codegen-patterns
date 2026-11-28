/**
 * Jobs emitter unit tests (RFC-0005, breakdown #7a).
 *
 * Covers the pure emitter functions: the declarative bridge triggers, the
 * job-private scheduled events (per schedule arm, with the __sched naming), and
 * the seam-split handler base/subclass string content. The emitted-tree tsc
 * compile is the smoke gate's job (#7b/#9) — here we assert structure.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { JobDefinitionSchema, type JobDefinition } from '../../schema/job-definition.schema';
import {
	buildJobBridgeTriggers,
	buildJobScheduledEvents,
	generateJobHandlerBase,
	generateJobHandlerSubclass,
} from '../../cli/shared/job-emission-generator';

const FIXTURE_DIR = resolve(__dirname, '../../../test/fixtures/jobs');
const loadJob = (name: string): JobDefinition =>
	JobDefinitionSchema.parse(parseYaml(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')));

const drivePoll = loadJob('drive_poll.yaml');
const reconcilePoll = loadJob('reconcile_poll.yaml');
const inboundSync = loadJob('inbound_sync.yaml');

// ----------------------------------------------------------------------------
// Bridge triggers (declarative — fork 1)
// ----------------------------------------------------------------------------

describe('buildJobBridgeTriggers', () => {
	it('maps a schedule arm to the generated event and an event arm to its event', () => {
		const triggers = buildJobBridgeTriggers(drivePoll, 'definitions/jobs/drive_poll.yaml');
		expect(triggers).toHaveLength(2);
		// schedule arm → the generated job-private scheduled event
		expect(triggers[0]).toMatchObject({
			jobKey: 'drive_poll',
			triggerId: 'drive_poll#0',
			event: 'drive_poll__sched',
			mapSource: '() => ({})',
		});
		// event arm → the existing doorbell event verbatim
		expect(triggers[1]).toMatchObject({ triggerId: 'drive_poll#1', event: 'document_sync_due' });
	});

	it('a job with no collision or dedupe gives its triggers no dedupe key (starts never collide)', () => {
		for (const t of buildJobBridgeTriggers(drivePoll, 'x.yaml')) expect(t.dedupeKeySource).toBeUndefined();
	});

	it('a job that declares collision or dedupe gives every trigger one dedupe key per job (overrun protection)', () => {
		const queued = JobDefinitionSchema.parse({ ...parseYaml(readFileSync(resolve(FIXTURE_DIR, 'drive_poll.yaml'), 'utf8')), collision: 'queue' });
		for (const t of buildJobBridgeTriggers(queued, 'x.yaml')) expect(t.dedupeKeySource).toBe('() => "drive_poll"');
	});

	it('emits a self-contained map string (no round-tripped author arrow)', () => {
		for (const t of buildJobBridgeTriggers(inboundSync, 'x.yaml')) {
			expect(t.mapSource).toBe('() => ({})');
			expect(t.whenSource).toBeUndefined();
		}
	});

	it('carries the YAML path for error citations', () => {
		const triggers = buildJobBridgeTriggers(reconcilePoll, 'definitions/jobs/reconcile_poll.yaml');
		expect(triggers[0].sourceFile).toBe('definitions/jobs/reconcile_poll.yaml');
	});
});

// ----------------------------------------------------------------------------
// Scheduled events (one per schedule arm — fork 2)
// ----------------------------------------------------------------------------

describe('buildJobScheduledEvents', () => {
	it('generates one job-private inbound domain event per schedule arm', () => {
		const events = buildJobScheduledEvents(drivePoll);
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev.type).toBe('drive_poll__sched');
		expect(ev.tier).toBe('domain');
		expect(ev.direction).toBe('inbound');
		expect(ev.pool).toBe('events_inbound');
		expect(ev.schedule?.every).toBe('15m');
		expect(ev.schedule?.align).toBe(true);
		// inbound needs no aggregate (a tick has no entity aggregate)
		expect(ev.aggregate).toBeUndefined();
	});

	it('emits NO scheduled event for an all-event-arm job', () => {
		expect(buildJobScheduledEvents(inboundSync)).toEqual([]);
	});

	it('uses __sched (no index) for a single schedule arm', () => {
		expect(buildJobScheduledEvents(reconcilePoll)[0].type).toBe('reconcile_poll__sched');
	});

	it('indexes the event type when a job has multiple schedule arms', () => {
		const multi = JobDefinitionSchema.parse({
			type: 'multi_sched',
			triggers: [
				{ schedule: { every: '15m' } },
				{ schedule: { every: '1h' } },
			],
			arms: [
				{
					kind: 'poll',
					domain: 'document',
					read: { mode: 'poll', poll: { cursor: { kind: 'timestamp', field: 'ts' } }, mapping: [{ source: 'id', target: 'external_id' }] },
				},
			],
		});
		const events = buildJobScheduledEvents(multi);
		expect(events.map((e) => e.type)).toEqual(['multi_sched__sched__0', 'multi_sched__sched__1']);
		// the bridge triggers reference the SAME generated names
		const triggers = buildJobBridgeTriggers(multi, 'x.yaml');
		expect(triggers.map((t) => t.event)).toEqual(['multi_sched__sched__0', 'multi_sched__sched__1']);
	});
});

// ----------------------------------------------------------------------------
// Handler base (@generated)
// ----------------------------------------------------------------------------

describe('generateJobHandlerBase', () => {
	const base = generateJobHandlerBase({ job: reconcilePoll });

	it('is marked @generated and names the emit-once subclass file', () => {
		expect(base).toContain('// @generated by @pattern-stack/codegen');
		expect(base).toContain('reconcile_poll.job.ts — emit-once: `export const reconcilePollJob = defineReconcilePollJob({ … })`');
	});

	it('emits define<Name>Job(arms): a defineJob keyed by the YAML type, its pool as each step\'s limiter, no triggers', () => {
		expect(base).toContain("import { defineJob, step } from '@pattern-stack/jobs';");
		expect(base).toContain('export function defineReconcilePollJob(arms: ReconcilePollArms) {');
		expect(base).toContain('key: "reconcile_poll",');
		expect(base).toContain('input: reconcilePollInput,');
		expect(base).toContain('step({ limiter: "integration"');
		expect(base).not.toContain('triggers:');
		for (const gone of ['JobHandler', 'JobHandlerMeta', 'JobHandlerBase']) expect(base).not.toContain(gone);
	});

	it('always emits limits: a bridge or schedule start names no budget (the defaults, or the YAML limits)', () => {
		expect(base).toContain('limits: { maxItems: 1000, maxUsd: 10, maxCalls: 1000, maxDurationMs: 3600000 },');
		const tight = JobDefinitionSchema.parse({
			...parseYaml(readFileSync(resolve(FIXTURE_DIR, 'reconcile_poll.yaml'), 'utf8')),
			limits: { maxDurationMs: 60_000 },
		});
		expect(generateJobHandlerBase({ job: tight })).toContain(
			'limits: { maxItems: 1000, maxUsd: 10, maxCalls: 1000, maxDurationMs: 60000 },',
		);
	});

	it('emits a per-arm detection const and an abstract base with one seam per arm', () => {
		expect(base).toContain('export const reconcilePollArmDetection = {');
		expect(base).toContain('channel:');
		expect(base).toContain('message:');
		// one arm body per arm, and one step per arm in declaration order
		expect(base).toContain('export interface ReconcilePollArms {');
		expect(base).toContain('channel: (ctx: ReconcilePollInputContext) => Promise<ReconcilePollArmResult>;');
		expect(base).toContain('message: (ctx: ReconcilePollInputContext) => Promise<ReconcilePollArmResult>;');
		const channel = base.indexOf('.add("channel", step({ limiter: "integration", run: (ctx) => arms.channel(ctx) }))');
		const message = base.indexOf('.add("message", step({ limiter: "integration", run: (ctx) => arms.message(ctx) }))');
		expect(channel).toBeGreaterThan(0);
		expect(message).toBeGreaterThan(channel);
	});

	it('imports runtime via the package barrel by default (ADR-037)', () => {
		expect(base).toContain("from '@pattern-stack/codegen/subsystems'");
	});
});

// ----------------------------------------------------------------------------
// Handler subclass (emit-once)
// ----------------------------------------------------------------------------

describe('generateJobHandlerSubclass', () => {
	const sub = generateJobHandlerSubclass({ job: drivePoll });

	it('is the emit-once author header (NOT @generated)', () => {
		expect(sub).toContain('// Emit-once — author-owned.');
		expect(sub).not.toContain('@generated by @pattern-stack/codegen');
	});

	it('exports the job as a factory of its dependencies: the generated define<Name>Job over the arm bodies', () => {
		expect(sub).toContain("import { jobFactory } from '@pattern-stack/jobs';");
		expect(sub).toContain('export const drivePollJob = jobFactory({');
		expect(sub).toContain('deps: {},');
		expect(sub).toContain('return defineDrivePollJob({');
		expect(sub).not.toContain('JobHandler');
	});

	it('imports the base + meta + detection from the generated module', () => {
		expect(sub).toContain("from './drive_poll.job.generated'");
		expect(sub).toContain('drivePollArmDetection');
	});

	it('stubs each arm body', () => {
		expect(sub).toContain('document: async (_ctx) => {');
		expect(sub).toContain('not implemented');
	});
});
