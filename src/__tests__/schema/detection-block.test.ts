/**
 * Tests for the entity-YAML `detection:` block (#226-6).
 *
 * Validates that `EntityDefinitionSchema` accepts an optional `detection`
 * field, parsed by the canonical `DetectionConfigSchema` re-exported from
 * `runtime/subsystems/sync`. No template/codegen emission yet — schema
 * validation only.
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { loadEntityFromYaml } from '../../utils/yaml-loader';
import { resolve } from 'path';

describe('detection block (#226-6)', () => {
	const base = {
		entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities' },
		fields: { name: { type: 'string', required: true } },
	};

	it('detection is optional', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.detection).toBeUndefined();
	});

	it('accepts a minimal poll-mode detection block', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'poll',
				poll: {
					cursor: { kind: 'systemModstamp', field: 'SystemModstamp' },
				},
				mapping: [{ source: 'Name', target: 'name' }],
			},
		});
		expect(result.success).toBe(true);
		expect(result.data!.detection!.mode).toBe('poll');
	});

	it('accepts poll mode with provenance: cdc and filters', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'poll',
				poll: {
					cursor: { kind: 'eventId', field: 'id' },
					provenance: 'cdc',
				},
				mapping: [
					{ source: 'Name', target: 'name' },
					{ source: 'Amount', target: 'amount', transform: 'decimal-string' },
				],
				filters: [
					{ field: 'StageName', op: 'neq', value: 'Closed Lost' },
					{ field: 'OwnerId', op: 'in', value: ['a', 'b'] },
				],
			},
		});
		expect(result.success).toBe(true);
		const detection = result.data!.detection!;
		expect(detection.mode).toBe('poll');
		if (detection.mode === 'poll') {
			expect(detection.poll.provenance).toBe('cdc');
			expect(detection.filters).toHaveLength(2);
		}
	});

	it('accepts a webhook-mode detection block', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'webhook',
				webhook: { eventIdField: 'event_id' },
				mapping: [{ source: 'name', target: 'name' }],
			},
		});
		expect(result.success).toBe(true);
		expect(result.data!.detection!.mode).toBe('webhook');
	});

	it('rejects an unknown detection mode', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'cdc',
				mapping: [{ source: 'Name', target: 'name' }],
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects a poll block missing the cursor strategy', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'poll',
				poll: {},
				mapping: [{ source: 'Name', target: 'name' }],
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects an unknown cursor kind', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'poll',
				poll: { cursor: { kind: 'bogus', field: 'x' } },
				mapping: [{ source: 'Name', target: 'name' }],
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects an empty mapping array', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'poll',
				poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
				mapping: [],
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects a filter with an unknown op', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'poll',
				poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
				mapping: [{ source: 'Name', target: 'name' }],
				filters: [{ field: 'x', op: 'like', value: 'y' }],
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects webhook mode without eventIdField', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: {
				mode: 'webhook',
				webhook: {},
				mapping: [{ source: 'name', target: 'name' }],
			},
		});
		expect(result.success).toBe(false);
	});

	it('parses the opportunity fixture YAML containing a detection block', () => {
		const yamlPath = resolve(__dirname, '../../../test/fixtures/opportunity.yaml');
		const result = loadEntityFromYaml(yamlPath);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const definition = result.definition;
		expect(definition.detection).toBeDefined();
		expect(definition.detection!.mode).toBe('poll');
		if (definition.detection!.mode === 'poll') {
			expect(definition.detection!.poll.cursor.kind).toBe('systemModstamp');
			expect(definition.detection!.mapping.length).toBeGreaterThan(0);
			expect(definition.detection!.filters.length).toBeGreaterThan(0);
		}
	});
});
