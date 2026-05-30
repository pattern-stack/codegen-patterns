/**
 * Tests for the entity-YAML `detection:` block (ADR-033.1).
 *
 * `detection:` is a Record<provider, DetectionConfig>. The inner config
 * shape is owned by `runtime/subsystems/integration/detection-config.schema.ts`
 * (covered by its own tests). This file covers:
 *   - the record wrapper accepts single- and multi-provider maps,
 *   - the within-file superRefine cross-checks `detection:` keys against
 *     `integration.providers` keys per ADR-033.1 §6.
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { loadEntityFromYaml } from '../../utils/yaml-loader';
import { resolve } from 'path';

const base = {
	entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities' },
	fields: { name: { type: 'string', required: true } },
};

const hubspotDetection = {
	mode: 'poll' as const,
	poll: { cursor: { kind: 'timestamp' as const, field: 'hs_lastmodifieddate' } },
	mapping: [{ source: 'dealname', target: 'name' }],
	filters: [{ field: 'pipeline', op: 'neq' as const, value: 'archived' }],
};

const salesforceDetection = {
	mode: 'poll' as const,
	poll: { cursor: { kind: 'systemModstamp' as const, field: 'SystemModstamp' } },
	mapping: [{ source: 'Name', target: 'name' }],
	filters: [{ field: 'IsDeleted', op: 'eq' as const, value: false }],
};

const providers = {
	'hubspot-crm': { remote_entity: 'deal', direction: 'inbound' as const },
	'salesforce-crm': { remote_entity: 'Opportunity', direction: 'inbound' as const },
};

describe('detection block (ADR-033.1)', () => {
	it('detection is optional', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.detection).toBeUndefined();
	});

	it('accepts a single-provider one-key map', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			integration: { providers: { 'hubspot-crm': providers['hubspot-crm'] } },
			detection: { 'hubspot-crm': hubspotDetection },
		});
		expect(result.success).toBe(true);
		expect(Object.keys(result.data!.detection!)).toEqual(['hubspot-crm']);
		expect(result.data!.detection!['hubspot-crm']!.mode).toBe('poll');
	});

	it('accepts a multi-provider map with independent configs', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			integration: { providers },
			detection: {
				'hubspot-crm': hubspotDetection,
				'salesforce-crm': salesforceDetection,
			},
		});
		expect(result.success).toBe(true);
		const detection = result.data!.detection!;
		expect(Object.keys(detection).sort()).toEqual(['hubspot-crm', 'salesforce-crm']);
		const hub = detection['hubspot-crm']!;
		const sf = detection['salesforce-crm']!;
		if (hub.mode === 'poll') expect(hub.poll.cursor.kind).toBe('timestamp');
		if (sf.mode === 'poll') expect(sf.poll.cursor.kind).toBe('systemModstamp');
	});

	it('rejects a detection key that is not declared in integration.providers', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			integration: { providers: { 'hubspot-crm': providers['hubspot-crm'] } },
			detection: { 'hubspot-cmr': hubspotDetection },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issue = result.error.issues.find((i) => i.path.join('.') === 'detection.hubspot-cmr');
		expect(issue).toBeDefined();
		expect(issue!.path).toEqual(['detection', 'hubspot-cmr']);
		expect(issue!.message).toBe(
			"Provider 'hubspot-cmr' used in detection: but not declared in integration.providers. Known providers: hubspot-crm",
		);
	});

	it('rejects detection when integration.providers is missing entirely', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			detection: { 'hubspot-crm': hubspotDetection },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issue = result.error.issues.find((i) => i.path.join('.') === 'detection.hubspot-crm');
		expect(issue).toBeDefined();
		expect(issue!.message).toBe(
			"Provider 'hubspot-crm' used in detection: but not declared in integration.providers. Known providers: ",
		);
	});

	it('parses the opportunity fixture YAML with a multi-provider detection block', () => {
		const yamlPath = resolve(__dirname, '../../../test/fixtures/opportunity.yaml');
		const result = loadEntityFromYaml(yamlPath);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const definition = result.definition;
		expect(definition.detection).toBeDefined();
		expect(Object.keys(definition.detection!).sort()).toEqual(['hubspot-crm', 'salesforce-crm']);
		const sf = definition.detection!['salesforce-crm']!;
		if (sf.mode === 'poll') {
			expect(sf.poll.cursor.kind).toBe('systemModstamp');
			expect(sf.mapping.length).toBeGreaterThan(0);
			expect(sf.filters.length).toBeGreaterThan(0);
		}
	});
});
