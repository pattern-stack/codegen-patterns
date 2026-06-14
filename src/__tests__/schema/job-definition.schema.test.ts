/**
 * JobDefinitionSchema unit tests (RFC-0005, breakdown #5).
 *
 * Covers: fixture round-trip for the three RFC-0005 §3 cases (poll / reconcile /
 * realtime), defaults (triggers, cursorWithheld, detection filters), the arm
 * kind↔mode cross-field invariant, the 8 JobHandlerMeta fields, and `.strict()`
 * rejection of stray keys (incl. the renamed `differ` vs `dedupe` distinction).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	JobDefinitionSchema,
	safeValidateJobDefinition,
	ARM_KINDS,
	COLLISION_MODES,
	REPLAY_FROM,
} from '../../schema/job-definition.schema';

const FIXTURE_DIR = resolve(__dirname, '../../../test/fixtures/jobs');
const loadFixture = (name: string) =>
	parseYaml(readFileSync(resolve(FIXTURE_DIR, name), 'utf8'));

// ----------------------------------------------------------------------------
// Fixture round-trip — the three RFC-0005 §3 cases MUST parse.
// ----------------------------------------------------------------------------

describe('JobDefinitionSchema — RFC-0005 §3 fixtures', () => {
	it('parses the poll case (drive-poll): dual triggers, one cadence mirror', () => {
		const result = JobDefinitionSchema.safeParse(loadFixture('drive_poll.yaml'));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.type).toBe('drive_poll');
		expect(result.data.arms).toHaveLength(1);
		expect(result.data.arms[0].kind).toBe('poll');
		expect(result.data.triggers).toHaveLength(2);
		// first trigger is a schedule arm (job-owned cadence), second an event arm
		const [sched, evt] = result.data.triggers;
		if (!('schedule' in sched)) throw new Error('expected a schedule arm');
		expect(sched.schedule.every).toBe('15m');
		expect(sched.schedule.align).toBe(true);
		if (!('event' in evt)) throw new Error('expected an event arm');
		expect(evt.event).toBe('document_sync_due');
	});

	it('parses the reconcile case (reconcile-poll): composite arms + differ knob', () => {
		const result = JobDefinitionSchema.safeParse(loadFixture('reconcile_poll.yaml'));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.arms.map((a) => a.kind)).toEqual(['poll', 'reconcile']);
		expect(result.data.differ?.unignore).toEqual(['deletedAt']);
		const reconcile = result.data.arms[1];
		if (reconcile.kind !== 'reconcile') throw new Error('expected reconcile arm');
		expect(reconcile.window.hours).toBe(24);
		expect(reconcile.cursorWithheld).toBe(true);
	});

	it('parses the realtime case (inbound-sync): no cadence, mixed realtime+poll arms', () => {
		const result = JobDefinitionSchema.safeParse(loadFixture('inbound_sync.yaml'));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.arms.map((a) => a.kind)).toEqual(['realtime', 'realtime', 'poll']);
		// every trigger is an event arm (doorbell) — no schedule on a realtime job
		expect(result.data.triggers.every((t) => 'event' in t)).toBe(true);
		const first = result.data.arms[0];
		if (first.kind !== 'realtime') throw new Error('expected realtime arm');
		expect(first.staging.table).toBe('slack_message_staging');
		expect(first.staging.pushAccelerate).toBe(true);
	});
});

// ----------------------------------------------------------------------------
// Defaults
// ----------------------------------------------------------------------------

describe('JobDefinitionSchema — defaults', () => {
	const minimalPollArm = {
		kind: 'poll',
		domain: 'document',
		read: {
			mode: 'poll',
			poll: { cursor: { kind: 'timestamp', field: 'updated_at' } },
			mapping: [{ source: 'id', target: 'external_id' }],
		},
	};

	it('defaults triggers to an empty list', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'no_trigger_job',
			arms: [minimalPollArm],
		});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.triggers).toEqual([]);
	});

	it('defaults reconcile cursorWithheld to true', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'reconcile_job',
			arms: [
				{
					kind: 'reconcile',
					domain: 'message',
					window: { hours: 12 },
					read: {
						mode: 'poll',
						poll: { cursor: { kind: 'timestamp', field: 'ts' } },
						mapping: [{ source: 'ts', target: 'external_id' }],
					},
				},
			],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const arm = result.data.arms[0];
			if (arm.kind !== 'reconcile') throw new Error('expected reconcile arm');
			expect(arm.cursorWithheld).toBe(true);
		}
	});

	it('defaults detection filters to an empty array', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'filterless_job',
			arms: [minimalPollArm],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const arm = result.data.arms[0];
			if (arm.read.mode !== 'poll') throw new Error('expected poll mode');
			expect(arm.read.filters).toEqual([]);
		}
	});
});

// ----------------------------------------------------------------------------
// Cross-field invariant — arm kind ↔ read.mode (ADR-0018 D1↔D3)
// ----------------------------------------------------------------------------

describe('JobDefinitionSchema — arm kind ↔ read.mode', () => {
	it('rejects a realtime arm reading mode:poll', () => {
		const result = safeValidateJobDefinition({
			type: 'bad_realtime',
			arms: [
				{
					kind: 'realtime',
					domain: 'message',
					staging: { table: 'staging' },
					read: {
						mode: 'poll',
						poll: { cursor: { kind: 'timestamp', field: 'ts' } },
						mapping: [{ source: 'id', target: 'external_id' }],
					},
				},
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path.join('.') === 'arms.0.read.mode')).toBe(true);
	});

	it('rejects a poll arm reading mode:webhook', () => {
		const result = safeValidateJobDefinition({
			type: 'bad_poll',
			arms: [
				{
					kind: 'poll',
					domain: 'document',
					read: {
						mode: 'webhook',
						webhook: { eventIdField: 'event_id' },
						mapping: [{ source: 'id', target: 'external_id' }],
					},
				},
			],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a reconcile arm reading mode:webhook', () => {
		const result = safeValidateJobDefinition({
			type: 'bad_reconcile',
			arms: [
				{
					kind: 'reconcile',
					domain: 'message',
					window: { hours: 6 },
					read: {
						mode: 'webhook',
						webhook: { eventIdField: 'event_id' },
						mapping: [{ source: 'id', target: 'external_id' }],
					},
				},
			],
		});
		expect(result.success).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// Structural rejections
// ----------------------------------------------------------------------------

describe('JobDefinitionSchema — structural rejections', () => {
	const goodArm = {
		kind: 'poll',
		domain: 'document',
		read: {
			mode: 'poll',
			poll: { cursor: { kind: 'timestamp', field: 'updated_at' } },
			mapping: [{ source: 'id', target: 'external_id' }],
		},
	};

	it('requires at least one arm', () => {
		const result = JobDefinitionSchema.safeParse({ type: 'armless', arms: [] });
		expect(result.success).toBe(false);
	});

	it('rejects a non-snake_case job type', () => {
		const result = JobDefinitionSchema.safeParse({ type: 'DrivePoll', arms: [goodArm] });
		expect(result.success).toBe(false);
	});

	it('rejects an unknown arm kind', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'mystery',
			arms: [{ ...goodArm, kind: 'streaming' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects stray top-level keys (.strict)', () => {
		const result = JobDefinitionSchema.safeParse({ type: 'strayed', lane: 'integration', arms: [goodArm] });
		expect(result.success).toBe(false);
	});

	it('rejects the brief\'s `dedupe.unignore` shape — that knob is now `differ`', () => {
		// `dedupe` is the runtime DedupePolicy { key, windowMs }; `{ unignore }` is
		// the differ knob and belongs under `differ`.
		const result = JobDefinitionSchema.safeParse({
			type: 'wrong_dedupe',
			dedupe: { unignore: ['deletedAt'] },
			arms: [goodArm],
		});
		expect(result.success).toBe(false);
	});

	it('accepts the runtime DedupePolicy shape under `dedupe`', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'windowed_dedupe',
			dedupe: { key: '{{external_id}}', windowMs: 60000 },
			arms: [goodArm],
		});
		expect(result.success).toBe(true);
	});

	it('rejects a bad schedule-arm duration string', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'bad_cadence',
			triggers: [{ schedule: { every: 'every 5 minutes' } }],
			arms: [goodArm],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a non-snake_case event-arm event', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'bad_event',
			triggers: [{ event: 'DocumentPollDue' }],
			arms: [goodArm],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a trigger that is neither a schedule nor an event arm', () => {
		const empty = JobDefinitionSchema.safeParse({ type: 'empty_trigger', triggers: [{}], arms: [goodArm] });
		expect(empty.success).toBe(false);
	});

	it('rejects a trigger carrying BOTH schedule and event (disjoint arms)', () => {
		const both = JobDefinitionSchema.safeParse({
			type: 'both_arms',
			triggers: [{ schedule: { every: '1h' }, event: 'document_sync_due' }],
			arms: [goodArm],
		});
		expect(both.success).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// Arm structural rejections — pin the correct-but-easily-regressed invariants.
// The reconcile-window cases matter most: a missing/garbage window silently
// changes the reconciliation watermark (brief Risk: "a regressed watermark
// silently re-processes").
// ----------------------------------------------------------------------------

describe('JobDefinitionSchema — arm structural rejections', () => {
	const pollRead = {
		mode: 'poll',
		poll: { cursor: { kind: 'timestamp', field: 'ts' } },
		mapping: [{ source: 'id', target: 'external_id' }],
	};
	const webhookRead = {
		mode: 'webhook',
		webhook: { eventIdField: 'event_id' },
		mapping: [{ source: 'externalId', target: 'external_id' }],
	};

	it('rejects a reconcile arm with no window', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'no_window',
			arms: [{ kind: 'reconcile', domain: 'message', read: pollRead }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a reconcile window of zero / negative / non-finite hours', () => {
		for (const hours of [0, -1, Number.POSITIVE_INFINITY]) {
			const result = JobDefinitionSchema.safeParse({
				type: 'bad_window',
				arms: [{ kind: 'reconcile', domain: 'message', window: { hours }, read: pollRead }],
			});
			expect(result.success).toBe(false);
		}
	});

	it('rejects cursorWithheld:false on a reconcile arm (withheld by definition)', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'advancing_reconcile',
			arms: [
				{ kind: 'reconcile', domain: 'message', window: { hours: 6 }, cursorWithheld: false, read: pollRead },
			],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a realtime arm with no staging', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'no_staging',
			arms: [{ kind: 'realtime', domain: 'message', read: webhookRead }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects an empty detection mapping', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'empty_mapping',
			arms: [
				{
					kind: 'poll',
					domain: 'document',
					read: { mode: 'poll', poll: { cursor: { kind: 'timestamp', field: 'ts' } }, mapping: [] },
				},
			],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a wrong-kind field (window on a poll arm) via arm .strict()', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'strayed_arm',
			arms: [{ kind: 'poll', domain: 'document', window: { hours: 1 }, read: pollRead }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects an empty differ.unignore block', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'empty_differ',
			differ: { unignore: [] },
			arms: [{ kind: 'poll', domain: 'document', read: pollRead }],
		});
		expect(result.success).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// JobHandlerMeta surface — the 8 fields are all expressible
// ----------------------------------------------------------------------------

describe('JobDefinitionSchema — JobHandlerMeta surface (8 fields)', () => {
	it('accepts all eight handler-meta fields in their YAML form', () => {
		const result = JobDefinitionSchema.safeParse({
			type: 'full_meta',
			pool: 'integration',
			scope: { entity: 'account', from: '{{accountId}}' },
			retry: { attempts: 3, backoff: 'exponential', baseMs: 1000 },
			concurrency: { key: '{{accountId}}', collisionMode: 'queue' },
			dedupe: { key: '{{external_id}}', windowMs: 30000 },
			timeoutMs: 60000,
			replayFrom: 'last_checkpoint',
			triggers: [{ schedule: { every: '1h', align: true } }],
			arms: [
				{
					kind: 'poll',
					domain: 'account',
					read: {
						mode: 'poll',
						poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
						mapping: [{ source: 'id', target: 'external_id' }],
					},
				},
			],
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.pool).toBe('integration');
		expect(result.data.scope?.entity).toBe('account');
		expect(result.data.retry?.backoff).toBe('exponential');
		expect(result.data.concurrency?.collisionMode).toBe('queue');
		expect(result.data.dedupe?.windowMs).toBe(30000);
		expect(result.data.timeoutMs).toBe(60000);
		expect(result.data.replayFrom).toBe('last_checkpoint');
		const trig = result.data.triggers[0];
		if (!('schedule' in trig)) throw new Error('expected a schedule arm');
		expect(trig.schedule.every).toBe('1h');
	});

	it('exports the enum constants the emitter/validator consume', () => {
		expect(ARM_KINDS).toEqual(['poll', 'reconcile', 'realtime']);
		expect(COLLISION_MODES).toEqual(['queue', 'reject', 'replace']);
		expect(REPLAY_FROM).toEqual(['scratch', 'last_step', 'last_checkpoint']);
	});
});
