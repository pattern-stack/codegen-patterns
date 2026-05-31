/**
 * Schema v2 validation tests
 *
 * Tests for ADR-031 pattern, queries, integration, events blocks
 * and pipelines config schema.
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import {
	GenerateConfigSchema,
	PipelinesConfigSchema,
} from '../../schema/pipelines-config.schema';
import { loadEntityFromYaml } from '../../utils/yaml-loader';
import { loadEntities } from '../../parser/load-entities';
import { buildDomainGraph } from '../../analyzer/graph-builder';
import { checkConsistency } from '../../analyzer/consistency-checker';
import { resolveBehaviors } from '../../behaviors/index';
import { resolve } from 'path';

// ============================================================================
// Pattern surface (ADR-031 — supersedes family:)
// ============================================================================

describe('pattern / patterns / config', () => {
	const base = {
		entity: { name: 'test', plural: 'tests', table: 'tests' },
		fields: { id: { type: 'uuid', required: true } },
	};

	it('accepts a single `pattern:` string', () => {
		// Names are validated against the registry at codegen time (PATTERN-4),
		// not by the schema itself — so any string is shape-valid here.
		for (const pattern of ['Integrated', 'Activity', 'Knowledge', 'Metadata', 'CrmEntity']) {
			const result = EntityDefinitionSchema.safeParse({
				...base,
				entity: { ...base.entity, pattern },
			});
			expect(result.success).toBe(true);
		}
	});

	it('accepts a `patterns:` array for multi-pattern composition', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, patterns: ['CrmEntity', 'Event'] },
		});
		expect(result.success).toBe(true);
	});

	it('rejects declaring both `pattern:` and `patterns:`', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, pattern: 'Integrated', patterns: ['Event'] },
		});
		expect(result.success).toBe(false);
	});

	it('rejects the legacy `family:` key (deleted in PATTERN-3 per ADR-031)', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, family: 'integrated' },
		});
		expect(result.success).toBe(false);
	});

	it('accepts a `config:` block keyed by pattern name', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: {
				...base.entity,
				pattern: 'CrmEntity',
				config: { CrmEntity: { entityType: 'opportunity' } },
			},
		});
		expect(result.success).toBe(true);
	});

	it('pattern + patterns + config are optional', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.entity.pattern).toBeUndefined();
		expect(result.data!.entity.patterns).toBeUndefined();
		expect(result.data!.entity.config).toBeUndefined();
	});
});

// ============================================================================
// Queries Block
// ============================================================================

describe('queries block', () => {
	const base = {
		entity: { name: 'contact', plural: 'contacts', table: 'contacts' },
		fields: { email: { type: 'string', required: true } },
	};

	it('accepts a simple query', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			queries: [{ by: ['email'] }],
		});
		expect(result.success).toBe(true);
	});

	it('accepts all query options', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			queries: [
				{ by: ['user_id'] },
				{ by: ['email'], unique: true },
				{ by: ['user_id', 'account_id'] },
				{ by: ['opportunity_id'], select: ['email'], via: 'opportunity_contact_link' },
				{ by: ['account_id'], order: 'created_at desc', limit: true },
			],
		});
		expect(result.success).toBe(true);
	});

	it('rejects empty by array', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			queries: [{ by: [] }],
		});
		expect(result.success).toBe(false);
	});

	it('queries block is optional', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// Integration Block
// ============================================================================

describe('integration block', () => {
	const base = {
		entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities' },
		fields: { name: { type: 'string', required: true } },
	};

	it('accepts electric-only integration', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			integration: { electric: true },
		});
		expect(result.success).toBe(true);
	});

	it('accepts full provider config', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			integration: {
				electric: true,
				providers: {
					salesforce: {
						remote_entity: 'Opportunity',
						direction: 'bidirectional',
						cdc: true,
						field_mapping: { name: 'Name' },
						read_only_fields: ['is_closed'],
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it('rejects invalid direction', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			integration: {
				providers: {
					salesforce: { remote_entity: 'X', direction: 'invalid' },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it('accepts all three direction values', () => {
		for (const direction of ['inbound', 'outbound', 'bidirectional']) {
			const result = EntityDefinitionSchema.safeParse({
				...base,
				integration: {
					providers: {
						test: { remote_entity: 'X', direction },
					},
				},
			});
			expect(result.success).toBe(true);
		}
	});
});

// ============================================================================
// Events Block
// ============================================================================

describe('events block', () => {
	const base = {
		entity: { name: 'contact', plural: 'contacts', table: 'contacts' },
		fields: { email: { type: 'string', required: true } },
	};

	it('accepts valid events', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			events: [
				{
					name: 'contact_created',
					queue: 'domain-events',
					body: { contact_id: 'uuid', created_by: 'uuid' },
					generate_handler: true,
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it('rejects non-snake_case event name', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			events: [{ name: 'BadName', queue: 'q', body: {} }],
		});
		expect(result.success).toBe(false);
	});

	it('generate_handler defaults to false', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			events: [{ name: 'test_event', queue: 'q', body: { id: 'uuid' } }],
		});
		expect(result.success).toBe(true);
		expect(result.data!.events![0].generate_handler).toBe(false);
	});
});

// ============================================================================
// External ID Tracking Behavior
// ============================================================================

describe('external_id_tracking behavior', () => {
	it('is recognized by the behavior registry', () => {
		const resolved = resolveBehaviors(['external_id_tracking']);
		expect(resolved.hasExternalIdTracking).toBe(true);
	});

	it('adds external_id, provider, provider_metadata fields', () => {
		const resolved = resolveBehaviors(['external_id_tracking']);
		const fieldNames = resolved.fields.map((f) => f.name);
		expect(fieldNames).toContain('external_id');
		expect(fieldNames).toContain('provider');
		expect(fieldNames).toContain('provider_metadata');
	});
});

// ============================================================================
// Pipelines Config
// ============================================================================

describe('pipelines config', () => {
	it('accepts full config', () => {
		const result = PipelinesConfigSchema.safeParse({
			backend: { enabled: true, architecture: 'clean-lite-ps' },
			frontend: { enabled: true, preset: 'dealbrain' },
			shared: { enabled: false },
		});
		expect(result.success).toBe(true);
	});

	it('accepts empty config (all defaults)', () => {
		const result = PipelinesConfigSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it('rejects invalid architecture', () => {
		const result = PipelinesConfigSchema.safeParse({
			backend: { architecture: 'nonexistent' },
		});
		expect(result.success).toBe(false);
	});

	it('accepts all architecture targets', () => {
		for (const arch of ['clean', 'clean-lite', 'clean-lite-ps', 'vertical-slice']) {
			const result = PipelinesConfigSchema.safeParse({
				backend: { architecture: arch },
			});
			expect(result.success).toBe(true);
		}
	});
});

// ============================================================================
// Generate Config
// ============================================================================

describe('generate config', () => {
	it('applies defaults when block is empty', () => {
		const result = GenerateConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.architecture).toBe('clean');
			expect(result.data.frontend).toBe(false);
		}
	});

	it('accepts architecture: clean', () => {
		const result = GenerateConfigSchema.safeParse({ architecture: 'clean' });
		expect(result.success).toBe(true);
	});

	it('accepts architecture: clean-lite-ps', () => {
		const result = GenerateConfigSchema.safeParse({ architecture: 'clean-lite-ps' });
		expect(result.success).toBe(true);
	});

	it('rejects unknown architecture values', () => {
		const result = GenerateConfigSchema.safeParse({ architecture: 'vertical-slice' });
		expect(result.success).toBe(false);
	});

	it('accepts frontend: true', () => {
		const result = GenerateConfigSchema.safeParse({ frontend: true });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.frontend).toBe(true);
	});

	it('passes through unknown keys (legacy toggles)', () => {
		const result = GenerateConfigSchema.safeParse({
			architecture: 'clean',
			frontend: false,
			drizzleSchema: false,
			hooks: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect((result.data as Record<string, unknown>).drizzleSchema).toBe(false);
			expect((result.data as Record<string, unknown>).hooks).toBe(true);
		}
	});
});

// ============================================================================
// on_delete — belongs_to FK cascade action (ADR-021)
// ============================================================================

describe('on_delete field on belongs_to relationships', () => {
	const base = {
		entity: { name: 'message', plural: 'messages', table: 'messages' },
		fields: { body: { type: 'string', required: true } },
	};

	const withBelongsTo = (on_delete?: string, nullable?: boolean) => ({
		...base,
		relationships: {
			conversation: {
				type: 'belongs_to',
				target: 'conversation',
				foreign_key: 'conversation_id',
				...(nullable !== undefined ? { nullable } : {}),
				...(on_delete !== undefined ? { on_delete } : {}),
			},
		},
	});

	it('accepts on_delete: cascade', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('cascade'));
		expect(result.success).toBe(true);
	});

	it('accepts on_delete: restrict', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('restrict'));
		expect(result.success).toBe(true);
	});

	it('accepts on_delete: set_null with nullable: true', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('set_null', true));
		expect(result.success).toBe(true);
	});

	it('accepts on_delete: no_action', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('no_action'));
		expect(result.success).toBe(true);
	});

	it('rejects on_delete: set_null without nullable: true', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('set_null', false));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toContain('set_null');
		}
	});

	it('rejects on_delete: set_null when nullable is absent (defaults to false)', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('set_null'));
		expect(result.success).toBe(false);
	});

	it('rejects unknown on_delete value', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo('delete_all'));
		expect(result.success).toBe(false);
	});

	it('defaults on_delete to restrict when omitted', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo());
		expect(result.success).toBe(true);
		if (result.success) {
			const rel = result.data.relationships!['conversation'];
			expect(rel.on_delete).toBe('restrict');
		}
	});

	it('is optional — entity parses without on_delete key', () => {
		const result = EntityDefinitionSchema.safeParse(withBelongsTo());
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// scopeable flag (JOB-7)
// ============================================================================

describe('scopeable flag', () => {
	const base = {
		entity: { name: 'account', plural: 'accounts', table: 'accounts' },
		fields: { id: { type: 'uuid', required: true } },
	};

	it('accepts scopeable: true', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, scopeable: true },
		});
		expect(result.success).toBe(true);
		expect(result.data!.entity.scopeable).toBe(true);
	});

	it('accepts scopeable: false', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, scopeable: false },
		});
		expect(result.success).toBe(true);
		expect(result.data!.entity.scopeable).toBe(false);
	});

	it('scopeable is optional — omitting it is valid', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.entity.scopeable).toBeUndefined();
	});

	it('rejects non-boolean scopeable', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, scopeable: 'yes' },
		});
		expect(result.success).toBe(false);
	});
});

describe('context flag (#403) — inside entity: block (0.12.2)', () => {
	const base = {
		entity: { name: 'transcript', plural: 'transcripts', table: 'transcripts' },
		fields: { id: { type: 'uuid', required: true } },
	};

	it('accepts entity.context: <snake_case>', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, context: 'integration' },
		});
		expect(result.success).toBe(true);
		expect(result.data!.entity.context).toBe('integration');
	});

	it('context is optional — omitting it is valid (flat output preserved)', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.entity.context).toBeUndefined();
	});

	it('rejects non-snake_case context (uppercase / hyphen / leading digit)', () => {
		for (const bad of ['Integration', 'my-context', '1context', '_x']) {
			const result = EntityDefinitionSchema.safeParse({
				...base,
				entity: { ...base.entity, context: bad },
			});
			expect(result.success).toBe(false);
		}
	});

	it('rejects non-string context', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, context: 123 },
		});
		expect(result.success).toBe(false);
	});

	it('rejects root-level context: — clean break, no root placement', () => {
		const result = EntityDefinitionSchema.safeParse({ ...base, context: 'integration' });
		expect(result.success).toBe(false);
	});
});

describe('surface flag (RFC-0001) — inside entity: block (0.12.2)', () => {
	const base = {
		entity: { name: 'transcript', plural: 'transcripts', table: 'transcripts' },
		fields: { id: { type: 'uuid', required: true } },
	};

	it('accepts entity.surface: <string>', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			entity: { ...base.entity, surface: 'transcript' },
		});
		expect(result.success).toBe(true);
		expect(result.data!.entity.surface).toBe('transcript');
	});

	it('surface is optional — omitting it is valid', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.entity.surface).toBeUndefined();
	});

	it('rejects root-level surface: — clean break, no root placement', () => {
		const result = EntityDefinitionSchema.safeParse({ ...base, surface: 'transcript' });
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Strict mode — unknown keys still rejected
// ============================================================================

describe('strict mode preserved', () => {
	it('rejects unknown top-level key on entity definition', () => {
		const result = EntityDefinitionSchema.safeParse({
			entity: { name: 'x', plural: 'xs', table: 'xs' },
			fields: { a: { type: 'string' } },
			bogus: true,
		});
		expect(result.success).toBe(false);
	});

	it('rejects unknown key in entity config', () => {
		const result = EntityDefinitionSchema.safeParse({
			entity: { name: 'x', plural: 'xs', table: 'xs', random_key: 'foo' },
			fields: { a: { type: 'string' } },
		});
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Integration: contact-v2.yaml fixture
// ============================================================================

describe('contact-v2.yaml integration', () => {
	it('parses through YAML loader', () => {
		const result = loadEntityFromYaml(resolve('test/fixtures/contact-v2.yaml'));
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.definition.entity.pattern).toBe('Integrated');
			expect(result.definition.queries).toHaveLength(6);
			expect(result.definition.integration?.electric).toBe(true);
			expect(result.definition.events).toHaveLength(3);
		}
	});

	it('maps through parser with correct types', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const contact = result.entities.find((e) => e.name === 'contact')!;

		expect(contact.pattern).toBe('Integrated');
		expect(contact.behaviors).toContain('external_id_tracking');
		expect(contact.queries).toHaveLength(6);
		expect(contact.integration?.electric).toBe(true);
		expect(contact.integration?.providers?.salesforce?.remoteEntity).toBe('Contact');
		expect(contact.events).toHaveLength(3);
		expect(contact.events![0].generateHandler).toBe(true);
	});

	it('passes consistency checks', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const graph = buildDomainGraph(result.entities);
		const issues = checkConsistency(graph);

		const v2Issues = issues.filter((i) =>
			['unknown_query_field', 'unknown_sync_field_mapping', 'external_id_tracking_collision'].includes(i.type),
		);
		expect(v2Issues).toHaveLength(0);
	});
});

// ============================================================================
// Consistency checker: invalid references
// ============================================================================

describe('cross-block validation', () => {
	it('catches query referencing unknown field', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const contact = result.entities.find((e) => e.name === 'contact')!;

		// Inject a bad query
		contact.queries = [...(contact.queries ?? []), { by: ['nonexistent_field'] }];

		const graph = buildDomainGraph([contact]);
		const issues = checkConsistency(graph);
		const queryIssues = issues.filter((i) => i.type === 'unknown_query_field');
		expect(queryIssues.length).toBeGreaterThan(0);
		expect(queryIssues[0].message).toContain('nonexistent_field');
	});

	it('skips by-field validation for via queries', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const contact = result.entities.find((e) => e.name === 'contact')!;

		// Via query with cross-entity field should not error
		contact.queries = [{ by: ['opportunity_id'], via: 'opportunity_contact_link' }];

		const graph = buildDomainGraph([contact]);
		const issues = checkConsistency(graph);
		const queryIssues = issues.filter((i) => i.type === 'unknown_query_field');
		expect(queryIssues).toHaveLength(0);
	});

	// dogfood #9: belongs_to FK fields (not separately declared under `fields:`)
	// must still count as available fields for query validation.
	it('accepts query on belongs_to FK field even when not declared in fields', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const contact = result.entities.find((e) => e.name === 'contact')!;

		// Simulate the buggy scenario: author relies on the belongs_to relationship
		// to imply the `account_id` column, without also declaring it under `fields:`.
		contact.fields.delete('account_id');
		contact.queries = [{ by: ['account_id'] }];

		const graph = buildDomainGraph([contact]);
		const issues = checkConsistency(graph);
		const queryIssues = issues.filter((i) => i.type === 'unknown_query_field');
		expect(queryIssues).toHaveLength(0);
	});

	it('still rejects query on truly nonexistent field when belongs_to is present', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const contact = result.entities.find((e) => e.name === 'contact')!;

		contact.fields.delete('account_id');
		contact.queries = [{ by: ['nonexistent'] }];

		const graph = buildDomainGraph([contact]);
		const issues = checkConsistency(graph);
		const queryIssues = issues.filter((i) => i.type === 'unknown_query_field');
		expect(queryIssues.length).toBeGreaterThan(0);
		expect(queryIssues[0].message).toContain('nonexistent');
	});

	it('accepts composite query mixing declared field and belongs_to FK', () => {
		const result = loadEntities(resolve('test/fixtures'));
		const contact = result.entities.find((e) => e.name === 'contact')!;

		// Drop the declared account_id so only the belongs_to relationship provides it.
		contact.fields.delete('account_id');
		// user_id remains declared; account_id comes from the `account` belongs_to.
		contact.queries = [{ by: ['user_id', 'account_id'] }];

		const graph = buildDomainGraph([contact]);
		const issues = checkConsistency(graph);
		const queryIssues = issues.filter((i) => i.type === 'unknown_query_field');
		expect(queryIssues).toHaveLength(0);
	});
});

// ============================================================================
// emits block (EVT-7)
// ============================================================================

describe('emits block (EVT-7)', () => {
	const base = {
		entity: { name: 'contact', plural: 'contacts', table: 'contacts' },
		fields: { email: { type: 'string', required: true } },
	};

	it('accepts a single valid snake_case entry', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['contact_created'],
		});
		expect(result.success).toBe(true);
		expect(result.data!.emits).toEqual(['contact_created']);
	});

	it('accepts multiple valid entries', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['contact_created', 'contact_updated', 'contact_deleted'],
		});
		expect(result.success).toBe(true);
	});

	it('accepts an explicit empty array (opt-out)', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: [],
		});
		expect(result.success).toBe(true);
		expect(result.data!.emits).toEqual([]);
	});

	it('treats absent emits as undefined (fallback path)', () => {
		const result = EntityDefinitionSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.data!.emits).toBeUndefined();
	});

	it('rejects PascalCase entries', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['ContactCreated'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects kebab-case entries', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['contact-created'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects entries starting with a digit', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['1contact_created'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects entries with uppercase characters', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['contact_Created'],
		});
		expect(result.success).toBe(false);
	});

	it('does not dedupe at schema level (validator concern)', () => {
		const result = EntityDefinitionSchema.safeParse({
			...base,
			emits: ['contact_created', 'contact_created'],
		});
		expect(result.success).toBe(true);
		expect(result.data!.emits).toHaveLength(2);
	});
});
