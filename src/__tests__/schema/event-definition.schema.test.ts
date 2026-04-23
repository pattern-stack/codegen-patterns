/**
 * EventDefinitionSchema unit tests (EVT-2).
 *
 * Covers: happy paths (one per direction), refinement failures
 * (direction/aggregate/source/destination/pool cross-field), defaults
 * (retry, version, pool derivation), and fixture round-trip via parseYaml.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	EventDefinitionSchema,
	RESERVED_EVENT_POOLS,
} from '../../schema/event-definition.schema';

const FIXTURE_DIR = resolve(__dirname, '../../../test/fixtures/events');

// ----------------------------------------------------------------------------
// Happy paths
// ----------------------------------------------------------------------------

describe('EventDefinitionSchema — happy paths', () => {
	it('parses a valid inbound event and derives pool to events_inbound', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'stripe_payment_received',
			direction: 'inbound',
			source: 'stripe',
			payload: {
				event_id: { type: 'string' },
				amount_cents: { type: 'number' },
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pool).toBe('events_inbound');
			expect(result.data.retry).toEqual({ attempts: 3, backoff: 'exponential' });
			expect(result.data.version).toBe(1);
		}
	});

	it('parses a valid change event and derives pool to events_change', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			payload: { contact_id: { type: 'uuid' } },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pool).toBe('events_change');
		}
	});

	it('parses a valid outbound event and derives pool to events_outbound', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'webhook_outbound_contact_sync',
			direction: 'outbound',
			destination: 'crm',
			payload: { contact_id: { type: 'uuid' } },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pool).toBe('events_outbound');
		}
	});

	it('parses a minimal event (no payload, no description) with defaults', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'ping',
			direction: 'inbound',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.payload).toEqual({});
			expect(result.data.retry).toEqual({ attempts: 3, backoff: 'exponential' });
			expect(result.data.version).toBe(1);
			expect(result.data.pool).toBe('events_inbound');
		}
	});

	it('accepts an explicit consistent pool override (change + events_change)', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			pool: 'events_change',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pool).toBe('events_change');
		}
	});
});

// ----------------------------------------------------------------------------
// Fixture round-trip
// ----------------------------------------------------------------------------

describe('EventDefinitionSchema — fixture YAML round-trip', () => {
	const cases: Array<{ file: string; expectedPool: (typeof RESERVED_EVENT_POOLS)[number] }> = [
		{ file: 'stripe_payment_received.yaml', expectedPool: 'events_inbound' },
		{ file: 'contact_created.yaml', expectedPool: 'events_change' },
		{ file: 'webhook_outbound_contact_sync.yaml', expectedPool: 'events_outbound' },
	];

	for (const { file, expectedPool } of cases) {
		it(`parses fixture ${file} and derives pool ${expectedPool}`, () => {
			const content = readFileSync(resolve(FIXTURE_DIR, file), 'utf-8');
			const parsed = parseYaml(content);
			const result = EventDefinitionSchema.safeParse(parsed);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pool).toBe(expectedPool);
			}
		});
	}
});

// ----------------------------------------------------------------------------
// Refinement failures
// ----------------------------------------------------------------------------

describe('EventDefinitionSchema — refinement failures', () => {
	it.each([
		['StripePaymentReceived'],
		['1foo'],
		['foo-bar'],
	])('rejects non-snake_case type %s', (type) => {
		const result = EventDefinitionSchema.safeParse({
			type,
			direction: 'inbound',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
		}
	});

	it("rejects direction: change without aggregate", () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.join('.') === 'aggregate');
			expect(issue).toBeDefined();
			expect(issue?.message).toContain("'aggregate' is required");
		}
	});

	it('rejects direction: change with source declared (strict direction gating)', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			source: 'crm',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.join('.') === 'source');
			expect(issue).toBeDefined();
			expect(issue?.message).toContain("'source' is only valid when direction is 'inbound'");
		}
	});

	it('rejects direction: inbound with destination declared (strict direction gating)', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'stripe_payment_received',
			direction: 'inbound',
			destination: 'crm',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.join('.') === 'destination');
			expect(issue).toBeDefined();
			expect(issue?.message).toContain("'destination' is only valid when direction is 'outbound'");
		}
	});

	it('rejects inconsistent pool override with derivation hint in message', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			pool: 'events_inbound',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path.join('.') === 'pool');
			expect(issue).toBeDefined();
			expect(issue?.message).toContain("inconsistent with direction 'change'");
			expect(issue?.message).toContain("expected 'events_change'");
		}
	});

	it('rejects unknown direction values', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'sideways',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) => i.path.join('.') === 'direction'),
			).toBe(true);
		}
	});

	it.each([['integer'], ['datetime']])(
		'rejects unknown payload field type %s',
		(badType) => {
			const result = EventDefinitionSchema.safeParse({
				type: 'contact_created',
				direction: 'change',
				aggregate: 'contact',
				payload: { foo: { type: badType } },
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(
					result.error.issues.some((i) => i.path.includes('payload')),
				).toBe(true);
			}
		},
	);

	it('rejects unknown top-level keys via .strict()', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			priority: 'high',
		});
		expect(result.success).toBe(false);
	});

	it('rejects non-snake_case payload key (contactId)', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			payload: { contactId: { type: 'uuid' } },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) => i.path.some((p) => p === 'contactId')),
			).toBe(true);
		}
	});

	it('rejects retry.attempts < 0', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			retry: { attempts: -1, backoff: 'linear' },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) => i.path.join('.') === 'retry.attempts'),
			).toBe(true);
		}
	});

	it('rejects retry.backoff not in enum', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			retry: { attempts: 1, backoff: 'foo' },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) => i.path.join('.') === 'retry.backoff'),
			).toBe(true);
		}
	});
});

// ----------------------------------------------------------------------------
// Defaults + transform
// ----------------------------------------------------------------------------

describe('EventDefinitionSchema — defaults and transform', () => {
	it('applies retry default when omitted', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'ping',
			direction: 'inbound',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.retry).toEqual({ attempts: 3, backoff: 'exponential' });
		}
	});

	it('applies version default when omitted', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'ping',
			direction: 'inbound',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.version).toBe(1);
		}
	});

	it('derives pool from direction when omitted', () => {
		for (const [direction, pool] of [
			['inbound', 'events_inbound'],
			['change', 'events_change'],
			['outbound', 'events_outbound'],
		] as const) {
			const input: Record<string, unknown> = { type: 'foo', direction };
			if (direction === 'change') input.aggregate = 'contact';
			const result = EventDefinitionSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pool).toBe(pool);
			}
		}
	});

	it('defaults payload to empty object when omitted', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'ping',
			direction: 'inbound',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.payload).toEqual({});
		}
	});

	it('defaults payload field nullable to false when omitted', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'contact_created',
			direction: 'change',
			aggregate: 'contact',
			payload: { contact_id: { type: 'uuid' } },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.payload.contact_id?.nullable).toBe(false);
		}
	});
});

describe('EventDefinitionSchema — array payload fields', () => {
	it('accepts type: array with scalar items', () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'crm_sync_started',
			direction: 'change',
			aggregate: 'integration',
			payload: {
				entity_types: { type: 'array', items: 'string' },
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.payload.entity_types?.type).toBe('array');
			expect(result.data.payload.entity_types?.items).toBe('string');
		}
	});

	it("rejects type: 'array' without items", () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'crm_sync_started',
			direction: 'change',
			aggregate: 'integration',
			payload: { entity_types: { type: 'array' } },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.includes('items'))).toBe(
				true,
			);
		}
	});

	it("rejects items: on a non-array type", () => {
		const result = EventDefinitionSchema.safeParse({
			type: 'crm_sync_started',
			direction: 'change',
			aggregate: 'integration',
			payload: { entity_types: { type: 'string', items: 'string' } },
		});
		expect(result.success).toBe(false);
	});

	it("rejects nested arrays (items must be scalar, not 'array' or 'json')", () => {
		const resultArray = EventDefinitionSchema.safeParse({
			type: 'crm_sync_started',
			direction: 'change',
			aggregate: 'integration',
			payload: { entity_types: { type: 'array', items: 'array' } },
		});
		expect(resultArray.success).toBe(false);
		const resultJson = EventDefinitionSchema.safeParse({
			type: 'crm_sync_started',
			direction: 'change',
			aggregate: 'integration',
			payload: { entity_types: { type: 'array', items: 'json' } },
		});
		expect(resultJson.success).toBe(false);
	});
});
