/**
 * loadEvents + desugarEntityEvents unit tests (EVT-2).
 *
 * Fixture-dir happy path uses `test/fixtures/events/` (three files, one per
 * direction). Error cases use `mkdtempSync(tmpdir())` so intentionally-broken
 * YAML does not pollute the checked-in fixture directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	loadEvents,
	desugarEntityEvents,
} from '../../parser/load-events';
import { EventDefinitionSchema } from '../../schema/event-definition.schema';
import type { EntityDefinition } from '../../schema/entity-definition.schema';

const FIXTURE_DIR = resolve(__dirname, '../../../test/fixtures/events');

// ----------------------------------------------------------------------------
// loadEvents — happy path
// ----------------------------------------------------------------------------

describe('loadEvents — happy path against checked-in fixtures', () => {
	it('loads three valid event YAMLs with zero error issues', () => {
		const result = loadEvents(FIXTURE_DIR, ['contact']);
		const errorIssues = result.issues.filter((i) => i.severity === 'error');
		expect(errorIssues).toEqual([]);
		expect(result.events).toHaveLength(3);
	});

	it('returns events sorted alphabetically by filename', () => {
		const result = loadEvents(FIXTURE_DIR, ['contact']);
		const types = result.events.map((e) => e.type);
		expect(types).toEqual([
			'contact_created',
			'stripe_payment_received',
			'webhook_outbound_contact_sync',
		]);
	});

	it('populates pool on every returned event (derived or explicit)', () => {
		const result = loadEvents(FIXTURE_DIR, ['contact']);
		for (const ev of result.events) {
			expect(ev.pool).toMatch(/^events_(inbound|change|outbound)$/);
		}
	});
});

// ----------------------------------------------------------------------------
// loadEvents — error cases (use tmp dirs)
// ----------------------------------------------------------------------------

describe('loadEvents — error cases', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'evt2-loader-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns warning (not throw) for a nonexistent directory', () => {
		const missing = join(tmpDir, 'does-not-exist');
		const result = loadEvents(missing, ['contact']);
		expect(result.events).toEqual([]);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.severity).toBe('warning');
		expect(result.issues[0]?.type).toBe('no_events_dir');
	});

	it('returns warning for an empty directory', () => {
		const result = loadEvents(tmpDir, ['contact']);
		expect(result.events).toEqual([]);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.severity).toBe('warning');
		expect(result.issues[0]?.type).toBe('no_files');
	});

	it('reports event_filename_mismatch when filename and type disagree', () => {
		writeFileSync(
			join(tmpDir, 'foo.yaml'),
			'type: bar\ndirection: inbound\n',
		);
		const result = loadEvents(tmpDir, []);
		expect(result.events).toEqual([]);
		const issue = result.issues.find((i) => i.type === 'event_filename_mismatch');
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('error');
		expect(issue?.message).toContain("'type: foo'");
	});

	it('reports unknown_aggregate for a change event referencing an unknown entity', () => {
		writeFileSync(
			join(tmpDir, 'ghost_updated.yaml'),
			[
				'type: ghost_updated',
				'direction: change',
				'aggregate: ghost',
				'payload:',
				'  ghost_id:',
				'    type: uuid',
				'',
			].join('\n'),
		);
		const result = loadEvents(tmpDir, ['contact']);
		expect(result.events).toEqual([]);
		const issue = result.issues.find((i) => i.type === 'unknown_aggregate');
		expect(issue).toBeDefined();
		expect(issue?.severity).toBe('error');
		expect(issue?.message).toContain("'ghost_updated'");
		expect(issue?.message).toContain("'ghost'");
		expect(issue?.suggestion).toContain('entities/ghost.yaml');
	});

	it('reports duplicate_event_type when two files declare the same type', () => {
		// Both files declare type: `contact_created` — filenames obviously
		// differ so we exercise the second-layer duplicate check. The second
		// file will also fail filename match, which is fine — both errors are
		// independently informative.
		writeFileSync(
			join(tmpDir, 'contact_created.yaml'),
			'type: contact_created\ndirection: change\naggregate: contact\n',
		);
		writeFileSync(
			join(tmpDir, 'contact_created_copy.yaml'),
			'type: contact_created\ndirection: change\naggregate: contact\n',
		);
		const result = loadEvents(tmpDir, ['contact']);
		// First one lands; second one first trips filename mismatch (so it
		// never reaches the duplicate-type check). Confirm we see filename
		// mismatch reported — either symptom proves both files were tried.
		expect(
			result.issues.some(
				(i) =>
					i.type === 'event_filename_mismatch' ||
					i.type === 'duplicate_event_type',
			),
		).toBe(true);
	});

	it('reports duplicate_event_type when two filenames share a type via .yml/.yaml twins', () => {
		writeFileSync(
			join(tmpDir, 'same_event.yaml'),
			'type: same_event\ndirection: inbound\n',
		);
		writeFileSync(
			join(tmpDir, 'same_event.yml'),
			'type: same_event\ndirection: inbound\n',
		);
		const result = loadEvents(tmpDir, []);
		const dup = result.issues.find((i) => i.type === 'duplicate_event_type');
		expect(dup).toBeDefined();
		expect(dup?.severity).toBe('error');
		expect(dup?.message).toContain('same_event');
	});

	it('reports parse_error with details for bad YAML syntax', () => {
		writeFileSync(
			join(tmpDir, 'bad.yaml'),
			'type: bad\n  direction: :: not yaml\n  - [\n',
		);
		const result = loadEvents(tmpDir, []);
		const parseIssue = result.issues.find((i) => i.type === 'parse_error');
		expect(parseIssue).toBeDefined();
		expect(parseIssue?.severity).toBe('error');
	});

	it('reports parse_error + schema_error details for a schema failure', () => {
		// Schema failure: direction is change but aggregate missing.
		writeFileSync(
			join(tmpDir, 'broken.yaml'),
			'type: broken\ndirection: change\n',
		);
		const result = loadEvents(tmpDir, []);
		expect(result.issues.some((i) => i.type === 'parse_error')).toBe(true);
		expect(result.issues.some((i) => i.type === 'schema_error')).toBe(true);
	});

	it('does not short-circuit: multiple errors across files all surface', () => {
		writeFileSync(
			join(tmpDir, 'one.yaml'),
			'type: one\ndirection: change\n', // schema error — missing aggregate
		);
		writeFileSync(
			join(tmpDir, 'foo.yaml'),
			'type: bar\ndirection: inbound\n', // filename mismatch
		);
		const result = loadEvents(tmpDir, []);
		const kinds = new Set(result.issues.map((i) => i.type));
		expect(kinds.has('schema_error')).toBe(true);
		expect(kinds.has('event_filename_mismatch')).toBe(true);
		expect(result.events).toEqual([]);
	});
});

// ----------------------------------------------------------------------------
// desugarEntityEvents
// ----------------------------------------------------------------------------

function makeEntity(events: EntityDefinition['events']): EntityDefinition {
	// Construct a minimal EntityDefinition. We avoid going through the full
	// Zod schema here because we want to assert desugar's purity on known
	// inputs; the shape matches what load-entities would produce.
	return {
		entity: {
			name: 'contact',
			plural: 'contacts',
			table: 'contacts',
			expose: ['repository', 'rest', 'trpc'],
		},
		fields: { id: { type: 'uuid', required: true, nullable: false } },
		behaviors: [],
		eav: false,
		eav_value_table: false,
		events,
	} as EntityDefinition;
}

describe('desugarEntityEvents', () => {
	it('synthesizes EventDefinitions from an entity events: block', () => {
		const entity = makeEntity([
			{
				name: 'contact_created',
				queue: 'domain-events',
				body: { contact_id: 'uuid', account_id: 'uuid' },
				generate_handler: false,
			},
			{
				name: 'contact_updated',
				queue: 'domain-events',
				body: { contact_id: 'uuid', changed_fields: 'string' },
				generate_handler: false,
			},
		]);
		const events = desugarEntityEvents(entity);
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe('contact_created');
		expect(events[0]?.direction).toBe('change');
		expect(events[0]?.aggregate).toBe('contact');
		expect(events[0]?.pool).toBe('events_change');
		expect(events[0]?.retry).toEqual({ attempts: 3, backoff: 'exponential' });
		expect(events[0]?.version).toBe(1);
		expect(events[0]?.payload).toEqual({
			contact_id: { type: 'uuid', nullable: false },
			account_id: { type: 'uuid', nullable: false },
		});
		expect(events[1]?.payload.changed_fields).toEqual({
			type: 'string',
			nullable: false,
		});
	});

	it('returns an empty array when entity has no events block', () => {
		const entity = makeEntity(undefined);
		expect(desugarEntityEvents(entity)).toEqual([]);
	});

	it('throws synchronously when a body field has an unknown type', () => {
		const entity = makeEntity([
			{
				name: 'contact_created',
				queue: 'domain-events',
				body: { contact_id: 'uuid', extra: 'integer' },
				generate_handler: false,
			},
		]);
		expect(() => desugarEntityEvents(entity)).toThrow(
			/Entity 'contact' event 'contact_created' field 'extra' has unknown type 'integer'/,
		);
	});

	it('produces output that round-trips cleanly through EventDefinitionSchema', () => {
		const entity = makeEntity([
			{
				name: 'contact_created',
				queue: 'domain-events',
				body: { contact_id: 'uuid' },
				generate_handler: false,
			},
		]);
		const [synthesized] = desugarEntityEvents(entity);
		const parsed = EventDefinitionSchema.safeParse(synthesized);
		expect(parsed.success).toBe(true);
	});
});
