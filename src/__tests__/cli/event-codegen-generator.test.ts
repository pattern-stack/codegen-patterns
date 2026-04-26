/**
 * Unit tests for event-codegen-generator.ts (EVT-3).
 *
 * Covers:
 *   - Pure content builders (types, schemas, registry, bus, index) for empty
 *     and non-empty event sets.
 *   - Per-direction event shapes (inbound/change/outbound).
 *   - camelCase conversion, nullability, field-type mapping for all 6 types.
 *   - Alphabetical ordering of interfaces, union members, registry entries.
 *   - Merge policy: top-level events override entity-sugar on `type` collision.
 *   - toCamelCase / toPascalCase helpers.
 *   - generateEventCodegen: dry-run (written:false), real writes, empty stub.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
	buildBusContent,
	buildIndexContent,
	buildRegistryContent,
	buildSchemasContent,
	buildTypesContent,
	collectEntityEvents,
	collectMergedEvents,
	generateEventCodegen,
	mergeEvents,
	toCamelCase,
	toPascalCase,
} from '../../cli/shared/event-codegen-generator.js';
import type { EventDefinition } from '../../schema/event-definition.schema.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function mkTempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-gen-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tempDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Fixture EventDefinitions
// ---------------------------------------------------------------------------

const contactCreated: EventDefinition = {
	type: 'contact_created',
	direction: 'change',
	aggregate: 'contact',
	version: 1,
	description: 'Emitted after a contact row is committed.',
	payload: {
		contact_id: { type: 'uuid', nullable: false },
		account_id: { type: 'uuid', nullable: true },
		created_by: { type: 'uuid', nullable: false },
	},
	retry: { attempts: 3, backoff: 'exponential' },
	pool: 'events_change',
};

const stripePaymentReceived: EventDefinition = {
	type: 'stripe_payment_received',
	direction: 'inbound',
	source: 'stripe',
	version: 1,
	description: 'Stripe charge.succeeded webhook, post-signature-verification.',
	payload: {
		event_id: {
			type: 'string',
			nullable: false,
			description: 'Stripe event id (evt_...)',
		},
		customer_id: { type: 'string', nullable: false },
		amount_cents: { type: 'number', nullable: false },
		currency: { type: 'string', nullable: false },
		received_at: { type: 'date', nullable: false },
	},
	retry: { attempts: 5, backoff: 'exponential' },
	pool: 'events_inbound',
};

const webhookOutboundContactSync: EventDefinition = {
	type: 'webhook_outbound_contact_sync',
	direction: 'outbound',
	destination: 'crm',
	aggregate: 'contact',
	version: 1,
	description: 'Outbound notification to the configured CRM when a contact changes.',
	payload: {
		contact_id: { type: 'uuid', nullable: false },
		operation: {
			type: 'string',
			nullable: false,
			description: 'create | update | delete',
		},
		occurred_at: { type: 'date', nullable: false },
	},
	retry: { attempts: 3, backoff: 'exponential' },
	pool: 'events_outbound',
};

/**
 * Audit-tier fixture (AUDIT-2). No `direction`, no `pool`, no
 * `aggregate`/`source`/`destination`. The Zod schema enforces this
 * shape; the generator must emit `tier: 'audit'`, `direction: null`,
 * `pool: null`.
 */
const crmSyncStarted = {
	type: 'crm_sync_started',
	tier: 'audit',
	version: 1,
	description: 'A CRM sync run kicked off (audit/observational).',
	payload: {
		run_id: { type: 'uuid', nullable: false },
	},
	retry: { attempts: 3, backoff: 'exponential' },
} as unknown as EventDefinition;

// ---------------------------------------------------------------------------
// Case helpers
// ---------------------------------------------------------------------------

describe('toCamelCase', () => {
	test('converts snake_case to camelCase', () => {
		expect(toCamelCase('contact_id')).toBe('contactId');
		expect(toCamelCase('event_id')).toBe('eventId');
		expect(toCamelCase('received_at')).toBe('receivedAt');
	});

	test('single token stays lowercase', () => {
		expect(toCamelCase('currency')).toBe('currency');
		expect(toCamelCase('id')).toBe('id');
	});

	test('multi-segment snake works', () => {
		expect(toCamelCase('a_b_c')).toBe('aBC');
	});
});

describe('toPascalCase', () => {
	test('converts snake_case to PascalCase', () => {
		expect(toPascalCase('contact_created')).toBe('ContactCreated');
		expect(toPascalCase('stripe_payment_received')).toBe('StripePaymentReceived');
		expect(toPascalCase('webhook_outbound_contact_sync')).toBe(
			'WebhookOutboundContactSync',
		);
	});
});

// ---------------------------------------------------------------------------
// buildTypesContent
// ---------------------------------------------------------------------------

describe('buildTypesContent — empty case', () => {
	test('emits AppDomainEvent = never with EventTypeName = string', () => {
		const content = buildTypesContent([]);

		expect(content).toContain('// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.');
		expect(content).toContain("import type { DomainEvent } from '../event-bus.protocol';");
		expect(content).toContain('export type AppDomainEvent = never;');
		expect(content).toContain('export type EventTypeName = string;');
		expect(content).toContain(
			'export type EventOfType<T extends EventTypeName> = never;',
		);
		expect(content).toContain(
			'export type PayloadOfType<T extends EventTypeName> = never;',
		);
	});
});

describe('buildTypesContent — single change event', () => {
	test('emits ContactCreatedEvent with camelCase fields and nullable', () => {
		const content = buildTypesContent([contactCreated]);

		expect(content).toContain('/** Emitted after a contact row is committed. */');
		expect(content).toContain('export interface ContactCreatedEvent extends DomainEvent {');
		expect(content).toContain("readonly type: 'contact_created';");
		expect(content).toContain("readonly aggregateType: 'contact';");
		expect(content).toContain('contactId: string;');
		expect(content).toContain('accountId: string | null;');
		expect(content).toContain('createdBy: string;');

		expect(content).toContain('export type AppDomainEvent =\n\t| ContactCreatedEvent;');
		expect(content).toContain("export type EventTypeName = AppDomainEvent['type'];");
	});
});

describe('buildTypesContent — single inbound event', () => {
	test('aggregateType literal uses source when aggregate is absent', () => {
		const content = buildTypesContent([stripePaymentReceived]);

		expect(content).toContain('export interface StripePaymentReceivedEvent extends DomainEvent {');
		expect(content).toContain("readonly type: 'stripe_payment_received';");
		expect(content).toContain("readonly aggregateType: 'stripe';");
		expect(content).toContain('/** Stripe event id (evt_...) */');
		expect(content).toContain('eventId: string;');
		expect(content).toContain('customerId: string;');
		expect(content).toContain('amountCents: number;');
		expect(content).toContain('receivedAt: Date;');
	});
});

describe('buildTypesContent — single outbound event', () => {
	test('aggregateType uses aggregate when both aggregate and destination exist', () => {
		// aggregate wins per precedence (aggregate ?? source ?? destination ?? type).
		const content = buildTypesContent([webhookOutboundContactSync]);

		expect(content).toContain('export interface WebhookOutboundContactSyncEvent extends DomainEvent {');
		expect(content).toContain("readonly aggregateType: 'contact';");
	});

	test('aggregateType falls back to destination when aggregate is absent', () => {
		const ev: EventDefinition = {
			...webhookOutboundContactSync,
			aggregate: undefined,
		};
		const content = buildTypesContent([ev]);
		expect(content).toContain("readonly aggregateType: 'crm';");
	});
});

describe('buildTypesContent — multi-event ordering', () => {
	test('interfaces and union members are alphabetical by type', () => {
		const content = buildTypesContent([
			webhookOutboundContactSync,
			contactCreated,
			stripePaymentReceived,
		]);

		const contactIdx = content.indexOf('export interface ContactCreatedEvent');
		const stripeIdx = content.indexOf('export interface StripePaymentReceivedEvent');
		const webhookIdx = content.indexOf(
			'export interface WebhookOutboundContactSyncEvent',
		);

		expect(contactIdx).toBeGreaterThan(-1);
		expect(stripeIdx).toBeGreaterThan(contactIdx);
		expect(webhookIdx).toBeGreaterThan(stripeIdx);

		// Union literal: alphabetical.
		expect(content).toContain(
			'export type AppDomainEvent =\n\t| ContactCreatedEvent\n\t| StripePaymentReceivedEvent\n\t| WebhookOutboundContactSyncEvent;',
		);
	});
});

describe('buildTypesContent — empty payload', () => {
	test('emits Record<string, never> for a payload-less event', () => {
		const ev: EventDefinition = {
			type: 'nothing_event',
			direction: 'change',
			aggregate: 'contact',
			version: 1,
			payload: {},
			retry: { attempts: 3, backoff: 'exponential' },
			pool: 'events_change',
		};
		const content = buildTypesContent([ev]);
		expect(content).toContain('readonly payload: Record<string, never>;');
	});
});

describe('buildTypesContent — all six field types', () => {
	test('maps each EventFieldType to the correct TS type', () => {
		const ev: EventDefinition = {
			type: 'all_types',
			direction: 'change',
			aggregate: 'contact',
			version: 1,
			payload: {
				a_uuid: { type: 'uuid', nullable: false },
				a_string: { type: 'string', nullable: false },
				a_number: { type: 'number', nullable: false },
				a_boolean: { type: 'boolean', nullable: false },
				a_date: { type: 'date', nullable: false },
				a_json: { type: 'json', nullable: false },
				nullable_uuid: { type: 'uuid', nullable: true },
			},
			retry: { attempts: 3, backoff: 'exponential' },
			pool: 'events_change',
		};
		const content = buildTypesContent([ev]);

		expect(content).toContain('aUuid: string;');
		expect(content).toContain('aString: string;');
		expect(content).toContain('aNumber: number;');
		expect(content).toContain('aBoolean: boolean;');
		expect(content).toContain('aDate: Date;');
		expect(content).toContain('aJson: Record<string, unknown>;');
		expect(content).toContain('nullableUuid: string | null;');
	});
});

describe('buildTypesContent / buildSchemasContent — array field', () => {
	test('emits T[] in TS and z.array(scalar) in Zod for array + items', () => {
		const ev: EventDefinition = {
			type: 'crm_sync_started',
			direction: 'change',
			aggregate: 'integration',
			version: 1,
			payload: {
				entity_types: { type: 'array', items: 'string', nullable: false },
				ids: { type: 'array', items: 'uuid', nullable: false },
				optional_ids: { type: 'array', items: 'uuid', nullable: true },
			},
			retry: { attempts: 3, backoff: 'exponential' },
			pool: 'events_change',
		};
		const typesContent = buildTypesContent([ev]);
		expect(typesContent).toContain('entityTypes: string[];');
		expect(typesContent).toContain('ids: string[];');
		expect(typesContent).toContain('optionalIds: string[] | null;');

		const schemasContent = buildSchemasContent([ev]);
		expect(schemasContent).toContain('entityTypes: z.array(z.string()),');
		expect(schemasContent).toContain('ids: z.array(z.string().uuid()),');
		expect(schemasContent).toContain(
			'optionalIds: z.array(z.string().uuid()).nullable(),',
		);
	});
});

// ---------------------------------------------------------------------------
// buildSchemasContent
// ---------------------------------------------------------------------------

describe('buildSchemasContent — empty case', () => {
	test('emits empty map typed as Record<EventTypeName, z.ZodType>', () => {
		const content = buildSchemasContent([]);
		expect(content).toContain("import { z } from 'zod';");
		expect(content).toContain("import type { EventTypeName } from './types';");
		expect(content).toContain(
			'export const eventPayloadSchemas = {} as Record<EventTypeName, z.ZodType>;',
		);
	});
});

describe('buildSchemasContent — non-empty', () => {
	test('uses correct Zod mapping for each field type and nullable variant', () => {
		const content = buildSchemasContent([contactCreated, stripePaymentReceived]);

		// contact_created → contactCreatedPayloadSchema
		expect(content).toContain('export const contactCreatedPayloadSchema = z.object({');
		expect(content).toContain('contactId: z.string().uuid(),');
		expect(content).toContain('accountId: z.string().uuid().nullable(),');
		expect(content).toContain('createdBy: z.string().uuid(),');
		expect(content).toContain('}).strict();');

		// stripe_payment_received — varied field types
		expect(content).toContain(
			'export const stripePaymentReceivedPayloadSchema = z.object({',
		);
		expect(content).toContain('eventId: z.string(),');
		expect(content).toContain('amountCents: z.number(),');
		expect(content).toContain('receivedAt: z.coerce.date(),');

		// map
		expect(content).toContain("'contact_created': contactCreatedPayloadSchema,");
		expect(content).toContain(
			"'stripe_payment_received': stripePaymentReceivedPayloadSchema,",
		);
		expect(content).toContain(
			'} as const satisfies Record<EventTypeName, z.ZodType>;',
		);
	});

	test('empty payload emits z.object({}).strict()', () => {
		const ev: EventDefinition = {
			type: 'empty_payload',
			direction: 'change',
			aggregate: 'contact',
			version: 1,
			payload: {},
			retry: { attempts: 3, backoff: 'exponential' },
			pool: 'events_change',
		};
		const content = buildSchemasContent([ev]);
		expect(content).toContain('export const emptyPayloadPayloadSchema = z.object({}).strict();');
	});

	test('boolean and json fields', () => {
		const ev: EventDefinition = {
			type: 'mixed',
			direction: 'change',
			aggregate: 'contact',
			version: 1,
			payload: {
				is_active: { type: 'boolean', nullable: false },
				extras: { type: 'json', nullable: true },
			},
			retry: { attempts: 3, backoff: 'exponential' },
			pool: 'events_change',
		};
		const content = buildSchemasContent([ev]);
		expect(content).toContain('isActive: z.boolean(),');
		expect(content).toContain('extras: z.record(z.unknown()).nullable(),');
	});
});

// ---------------------------------------------------------------------------
// buildRegistryContent
// ---------------------------------------------------------------------------

describe('buildRegistryContent — empty case', () => {
	test('emits empty registry and getEventMetadata that throws', () => {
		const content = buildRegistryContent([]);
		expect(content).toContain('export interface EventMetadata {');
		expect(content).toContain(
			'export const eventRegistry = {} as Record<EventTypeName, EventMetadata>;',
		);
		expect(content).toContain(
			'export function getEventMetadata<T extends EventTypeName>(type: T): EventMetadata {',
		);
		expect(content).toContain('throw new Error(');
	});
});

describe('buildRegistryContent — non-empty', () => {
	test('omits undefined optional fields (aggregate/source/destination)', () => {
		const content = buildRegistryContent([
			contactCreated,
			stripePaymentReceived,
			webhookOutboundContactSync,
		]);

		// change event: only aggregate (no source, no destination)
		expect(content).toContain("'contact_created': {");
		expect(content).toContain("aggregate: 'contact',");

		// inbound event: only source
		expect(content).toContain("'stripe_payment_received': {");
		expect(content).toContain("source: 'stripe',");

		// outbound event: aggregate + destination
		expect(content).toContain("'webhook_outbound_contact_sync': {");
		expect(content).toContain("destination: 'crm',");

		// Nothing should emit `aggregate: undefined` etc.
		expect(content).not.toContain('undefined');
	});

	test('pool, direction, version, retry are emitted inline', () => {
		const content = buildRegistryContent([stripePaymentReceived]);
		expect(content).toContain("direction: 'inbound',");
		expect(content).toContain("pool: 'events_inbound',");
		expect(content).toContain('version: 1,');
		expect(content).toContain(
			"retry: { attempts: 5, backoff: 'exponential' },",
		);
	});

	test('emits tier on every entry; domain entries keep direction/pool string literals', () => {
		const content = buildRegistryContent([contactCreated]);
		expect(content).toContain("tier: 'domain',");
		expect(content).toContain("direction: 'change',");
		expect(content).toContain("pool: 'events_change',");
	});

	test('audit events emit tier:audit with direction:null and pool:null', () => {
		const content = buildRegistryContent([crmSyncStarted]);
		expect(content).toContain("'crm_sync_started': {");
		expect(content).toContain("tier: 'audit',");
		expect(content).toContain('direction: null,');
		expect(content).toContain('pool: null,');
		// Audit entries have no aggregate/source/destination by construction.
		expect(content).not.toContain("aggregate: '");
		expect(content).not.toContain("source: '");
		expect(content).not.toContain("destination: '");
	});

	test('EventMetadata interface widens direction/pool to nullable and adds tier', () => {
		const content = buildRegistryContent([]);
		expect(content).toContain("tier: 'domain' | 'audit';");
		expect(content).toContain(
			"direction: 'inbound' | 'change' | 'outbound' | null;",
		);
		expect(content).toContain(
			"pool: 'events_inbound' | 'events_change' | 'events_outbound' | null;",
		);
	});

	test('registry entries are alphabetical by type', () => {
		const content = buildRegistryContent([
			webhookOutboundContactSync,
			contactCreated,
			stripePaymentReceived,
		]);

		const contactIdx = content.indexOf("'contact_created':");
		const stripeIdx = content.indexOf("'stripe_payment_received':");
		const webhookIdx = content.indexOf("'webhook_outbound_contact_sync':");
		expect(contactIdx).toBeGreaterThan(-1);
		expect(stripeIdx).toBeGreaterThan(contactIdx);
		expect(webhookIdx).toBeGreaterThan(stripeIdx);
	});
});

// ---------------------------------------------------------------------------
// buildBusContent / buildIndexContent
// ---------------------------------------------------------------------------

describe('buildBusContent', () => {
	test('class body is identical between empty and non-empty cases', () => {
		const empty = buildBusContent([]);
		const nonEmpty = buildBusContent([contactCreated]);
		expect(empty).toBe(nonEmpty);
	});

	test('imports the EVENT_BUS / EVENTS_MULTI_TENANT tokens and IEventBus protocol', () => {
		const content = buildBusContent([]);
		expect(content).toContain(
			"import { EVENT_BUS, EVENTS_MULTI_TENANT } from '../events.tokens';",
		);
		expect(content).toContain(
			"import { MissingTenantIdError } from '../events-errors';",
		);
		expect(content).toContain(
			"import type { IEventBus, DrizzleTransaction } from '../event-bus.protocol';",
		);
		expect(content).toContain("import { eventPayloadSchemas } from './schemas';");
		expect(content).toContain("import { getEventMetadata } from './registry';");
	});

	test('uses safeParse + console.warn gated by CODEGEN_EVENT_VALIDATE', () => {
		const content = buildBusContent([]);
		expect(content).toContain("process.env['CODEGEN_EVENT_VALIDATE']");
		expect(content).toContain('safeParse(payload)');
		expect(content).toContain('console.warn(');
		expect(content).not.toContain('.parse(payload)');
	});

	test('stamps pool/direction/version/tier into metadata from the registry', () => {
		const content = buildBusContent([]);
		// Domain branch: pool/direction sourced from registry; tier='domain'.
		expect(content).toContain("baseMetadata['pool'] = meta.pool;");
		expect(content).toContain("baseMetadata['direction'] = meta.direction;");
		expect(content).toContain("baseMetadata['tier'] = 'domain';");
		expect(content).toContain("baseMetadata['version'] = meta.version;");
		// opts.metadata is spread first so registry overrides
		expect(content).toContain('...(opts?.metadata ?? {})');
	});

	test('AUDIT-3: tier:audit forces pool/direction null and stamps tier=audit', () => {
		const content = buildBusContent([]);
		// Audit branch present and gates on registry tier.
		expect(content).toContain("if (meta.tier === 'audit') {");
		expect(content).toContain("baseMetadata['pool'] = null;");
		expect(content).toContain("baseMetadata['direction'] = null;");
		expect(content).toContain("baseMetadata['tier'] = 'audit';");
		// Caller-supplied pool/direction on audit events are silently dropped
		// with a debug-level log (not an error).
		expect(content).toContain('console.debug(');
		expect(content).toContain(
			"had pool/direction in opts.metadata; overriding to null.",
		);
	});

	test('@Injectable() and @Inject(EVENT_BUS) / @Inject(EVENTS_MULTI_TENANT) are present', () => {
		const content = buildBusContent([]);
		expect(content).toContain('@Injectable()');
		expect(content).toContain('@Inject(EVENT_BUS)');
		expect(content).toContain('@Inject(EVENTS_MULTI_TENANT)');
		expect(content).toContain('export class TypedEventBus {');
	});

	test('throws MissingTenantIdError when multiTenant is true and tenantId is absent', () => {
		const content = buildBusContent([]);
		// Publish-side tenant enforcement: module-level `multiTenant` flag +
		// `opts.metadata.tenantId` absence → throw.
		expect(content).toContain('this.multiTenant');
		expect(content).toContain('MissingTenantIdError');
		expect(content).toContain("opts?.metadata?.['tenantId']");
	});

	// ---------------------------------------------------------------------------
	// Regression: `noUncheckedIndexedAccess` strict-TS compatibility.
	//
	// `eventPayloadSchemas` is typed as `Record<EventTypeName, z.ZodType>`. In
	// the empty-registry case the emitter degrades `EventTypeName` to `string`
	// and the schemas object is literally `{}`, so `eventPayloadSchemas[type]`
	// under `noUncheckedIndexedAccess` is `z.ZodType | undefined`. Calling
	// `.safeParse()` directly on that was a TS2532 error (caught by smoke the
	// moment CI started running `just test-all`; see PR for #136). The bus
	// template must bind the lookup result to a local and guard it.
	// ---------------------------------------------------------------------------
	test('guards the schema lookup so strict + noUncheckedIndexedAccess passes', () => {
		const content = buildBusContent([]);
		// Must hoist the lookup into a local and guard it.
		expect(content).toContain('const schema = eventPayloadSchemas[type];');
		expect(content).toContain('if (schema) {');
		expect(content).toContain('schema.safeParse(payload)');
		// Must NOT call safeParse directly on the indexed access (the
		// exact shape that failed TS2532 under noUncheckedIndexedAccess).
		expect(content).not.toContain('eventPayloadSchemas[type].safeParse(');
	});
});

describe('buildIndexContent', () => {
	test('re-exports types, schemas, registry, bus', () => {
		const content = buildIndexContent([]);
		expect(content).toContain("export * from './types';");
		expect(content).toContain("export * from './schemas';");
		expect(content).toContain("export * from './registry';");
		expect(content).toContain("export * from './bus';");
	});
});

// ---------------------------------------------------------------------------
// Regression: the bundle of emitted files typechecks under the same strict
// compilerOptions the smoke harness / consumer tsconfig.json enforces
// (`strict: true`, `noUncheckedIndexedAccess: true`, etc.).
//
// Before the empty-registry schema guard fix (landed alongside the CI
// bootstrap), this test failed on line 51 of the empty-case bus.ts with
// TS2532. Covers the concrete regression but also catches any future
// strict-TS breakage in the emitted content — much faster than waiting on
// `just test-smoke`.
// ---------------------------------------------------------------------------

describe('emitted generated/* typechecks under strict + noUncheckedIndexedAccess', () => {
	function runTscOnEmit(events: EventDefinition[]): {
		exitCode: number;
		output: string;
	} {
		// Place the tmp dir INSIDE the repo so Node's module-resolution
		// walks up to the repo's \`node_modules\` and finds zod, @nestjs/*,
		// and @types/node. Using os.tmpdir() would require a package install
		// per test — slow and flaky.
		const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
		const tmpBase = path.join(repoRoot, 'test', 'tmp', 'evt-emit-tsc');
		fs.mkdirSync(tmpBase, { recursive: true });
		const dir = fs.mkdtempSync(path.join(tmpBase, 'case-'));
		tempDirs.push(dir);
		const generated = path.join(dir, 'generated');
		fs.mkdirSync(generated, { recursive: true });

		// Emit the four content builders into ./generated, matching the
		// layout `generateEventCodegen` produces on disk.
		fs.writeFileSync(path.join(generated, 'types.ts'), buildTypesContent(events));
		fs.writeFileSync(
			path.join(generated, 'schemas.ts'),
			buildSchemasContent(events),
		);
		fs.writeFileSync(
			path.join(generated, 'registry.ts'),
			buildRegistryContent(events),
		);
		fs.writeFileSync(path.join(generated, 'bus.ts'), buildBusContent(events));
		fs.writeFileSync(path.join(generated, 'index.ts'), buildIndexContent(events));

		// Minimal stubs for the sibling modules bus.ts imports from '../*'.
		fs.writeFileSync(
			path.join(dir, 'event-bus.protocol.ts'),
			[
				"export interface DomainEvent {",
				"  id: string;",
				"  type: string;",
				"  aggregateId: string;",
				"  aggregateType: string;",
				"  payload: Record<string, unknown>;",
				"  occurredAt: Date;",
				"  metadata?: Record<string, unknown>;",
				"}",
				"export type DrizzleTransaction = unknown;",
				"export interface IEventBus {",
				"  publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void>;",
				"  subscribe<T extends DomainEvent>(type: string, handler: (event: T) => Promise<void>): () => void;",
				"}",
			].join('\n') + '\n',
		);
		fs.writeFileSync(
			path.join(dir, 'events.tokens.ts'),
			[
				"export const EVENT_BUS = Symbol('EVENT_BUS');",
				"export const EVENTS_MULTI_TENANT = Symbol('EVENTS_MULTI_TENANT');",
			].join('\n') + '\n',
		);
		fs.writeFileSync(
			path.join(dir, 'events-errors.ts'),
			"export class MissingTenantIdError extends Error {\n  constructor(type: string) { super(type); }\n}\n",
		);

		// tsconfig mirroring the smoke harness consumer tsconfig (see
		// `test/smoke/run-smoke.ts` — it writes the same strict options).
		fs.writeFileSync(
			path.join(dir, 'tsconfig.json'),
			JSON.stringify(
				{
					compilerOptions: {
						lib: ['ESNext'],
						target: 'ESNext',
						module: 'Preserve',
						moduleDetection: 'force',
						allowJs: true,
						moduleResolution: 'bundler',
						allowImportingTsExtensions: true,
						verbatimModuleSyntax: false,
						noEmit: true,
						strict: true,
						skipLibCheck: true,
						noFallthroughCasesInSwitch: true,
						noUncheckedIndexedAccess: true,
						noImplicitOverride: true,
						experimentalDecorators: true,
						emitDecoratorMetadata: true,
						types: ['bun'],
					},
				},
				null,
				2,
			),
		);

		// Stub package.json so bun/tsc can resolve zod + nestjs from the repo's
		// node_modules via the nearest upward search.
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"evt-emit-tsc"}\n');

		const res = spawnSync(
			'bunx',
			['--bun', 'tsc', '--noEmit', '-p', dir],
			{
				cwd: repoRoot,
				encoding: 'utf-8',
				timeout: 60_000,
			},
		);
		return {
			exitCode: res.status ?? -1,
			output: (res.stdout ?? '') + (res.stderr ?? ''),
		};
	}

	test('empty-registry emit typechecks (TS2532 regression — PR #136)', () => {
		const { exitCode, output } = runTscOnEmit([]);
		if (exitCode !== 0) {
			// Surface the raw tsc output so regressions are debuggable from CI logs.
			throw new Error(`tsc exited ${exitCode}:\n${output}`);
		}
		expect(exitCode).toBe(0);
	});

	test('non-empty-registry emit typechecks', () => {
		const { exitCode, output } = runTscOnEmit([contactCreated]);
		if (exitCode !== 0) {
			throw new Error(`tsc exited ${exitCode}:\n${output}`);
		}
		expect(exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// mergeEvents — top-level wins on collision
// ---------------------------------------------------------------------------

describe('mergeEvents', () => {
	test('top-level event overrides entity sugar on type collision, warning emitted', () => {
		const sugarContact: EventDefinition = {
			...contactCreated,
			description: 'from entity sugar',
		};
		const topLevelContact: EventDefinition = {
			...contactCreated,
			description: 'from top-level events/*.yaml',
		};

		const { events, issues } = mergeEvents([topLevelContact], [sugarContact]);

		expect(events).toHaveLength(1);
		expect(events[0]?.description).toBe('from top-level events/*.yaml');

		expect(issues).toHaveLength(1);
		expect(issues[0]?.severity).toBe('warning');
		expect(issues[0]?.type).toBe('event_merge_override');
		expect(issues[0]?.message).toContain('contact_created');
	});

	test('no collision → both events present, alphabetical, no warnings', () => {
		const { events, issues } = mergeEvents(
			[stripePaymentReceived],
			[contactCreated],
		);
		expect(events.map((e) => e.type)).toEqual([
			'contact_created',
			'stripe_payment_received',
		]);
		expect(issues).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// collectEntityEvents
// ---------------------------------------------------------------------------

function writeEntityYaml(
	entitiesDir: string,
	name: string,
	body: string,
): void {
	fs.mkdirSync(entitiesDir, { recursive: true });
	fs.writeFileSync(path.join(entitiesDir, `${name}.yaml`), body);
}

describe('collectEntityEvents', () => {
	test('desugars entity events: blocks into change events', () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		writeEntityYaml(
			entitiesDir,
			'contact',
			`entity:
  name: contact
  plural: contacts
  table: contacts
fields:
  id:
    type: uuid
    required: true
events:
  - name: contact_archived
    queue: domain-events
    body:
      contact_id: uuid
      reason: string
`,
		);

		const { events, issues } = collectEntityEvents(entitiesDir);
		expect(issues).toEqual([]);
		expect(events).toHaveLength(1);
		const first = events[0];
		expect(first?.type).toBe('contact_archived');
		expect(first?.direction).toBe('change');
		expect(first?.aggregate).toBe('contact');
		expect(first?.pool).toBe('events_change');
	});

	test('returns empty + no issues when no entities declare events', () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		writeEntityYaml(
			entitiesDir,
			'contact',
			`entity:
  name: contact
  plural: contacts
  table: contacts
fields:
  id:
    type: uuid
    required: true
`,
		);
		const { events, issues } = collectEntityEvents(entitiesDir);
		expect(events).toEqual([]);
		expect(issues).toEqual([]);
	});

	test('returns empty when entities directory is absent', () => {
		const root = mkTempRoot();
		const { events, issues } = collectEntityEvents(path.join(root, 'missing'));
		expect(events).toEqual([]);
		expect(issues).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// generateEventCodegen — end-to-end (dry-run + write)
// ---------------------------------------------------------------------------

function writeEventYaml(
	eventsDir: string,
	name: string,
	body: string,
): void {
	fs.mkdirSync(eventsDir, { recursive: true });
	fs.writeFileSync(path.join(eventsDir, `${name}.yaml`), body);
}

describe('generateEventCodegen', () => {
	test('dry-run does not write files but returns full content', async () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		const eventsDir = path.join(root, 'events');
		const outputDir = path.join(root, 'out');
		fs.mkdirSync(entitiesDir, { recursive: true });

		writeEventYaml(
			eventsDir,
			'contact_created',
			`type: contact_created
direction: change
aggregate: contact
payload:
  contact_id:
    type: uuid
`,
		);
		// contact entity referenced by the event
		writeEntityYaml(
			entitiesDir,
			'contact',
			`entity:
  name: contact
  plural: contacts
  table: contacts
fields:
  id:
    type: uuid
    required: true
`,
		);

		const result = await generateEventCodegen({
			entitiesDir,
			eventsDir,
			outputDir,
			dryRun: true,
		});

		expect(result.written).toBe(false);
		expect(result.eventCount).toBe(1);
		expect(result.files.map((f) => f.name)).toEqual([
			'types.ts',
			'schemas.ts',
			'registry.ts',
			'bus.ts',
			'index.ts',
		]);
		expect(fs.existsSync(outputDir)).toBe(false);

		const types = result.files.find((f) => f.name === 'types.ts');
		expect(types?.content).toContain(
			'export interface ContactCreatedEvent extends DomainEvent {',
		);
	});

	test('real run writes all five files', async () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		const eventsDir = path.join(root, 'events');
		const outputDir = path.join(root, 'out');
		fs.mkdirSync(entitiesDir, { recursive: true });
		writeEventYaml(
			eventsDir,
			'stripe_payment_received',
			`type: stripe_payment_received
direction: inbound
source: stripe
payload:
  event_id:
    type: string
`,
		);

		const result = await generateEventCodegen({
			entitiesDir,
			eventsDir,
			outputDir,
		});

		expect(result.written).toBe(true);
		expect(fs.existsSync(path.join(outputDir, 'types.ts'))).toBe(true);
		expect(fs.existsSync(path.join(outputDir, 'schemas.ts'))).toBe(true);
		expect(fs.existsSync(path.join(outputDir, 'registry.ts'))).toBe(true);
		expect(fs.existsSync(path.join(outputDir, 'bus.ts'))).toBe(true);
		expect(fs.existsSync(path.join(outputDir, 'index.ts'))).toBe(true);

		const onDisk = fs.readFileSync(path.join(outputDir, 'types.ts'), 'utf-8');
		expect(onDisk).toContain('StripePaymentReceivedEvent');
	});

	test('empty project (no events, no entity events:) writes stub files', async () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		const eventsDir = path.join(root, 'events');
		const outputDir = path.join(root, 'out');
		fs.mkdirSync(entitiesDir, { recursive: true });

		const result = await generateEventCodegen({
			entitiesDir,
			eventsDir,
			outputDir,
		});

		expect(result.written).toBe(true);
		expect(result.eventCount).toBe(0);

		const types = fs.readFileSync(path.join(outputDir, 'types.ts'), 'utf-8');
		expect(types).toContain('export type AppDomainEvent = never;');
		expect(types).toContain('export type EventTypeName = string;');

		const registry = fs.readFileSync(
			path.join(outputDir, 'registry.ts'),
			'utf-8',
		);
		expect(registry).toContain(
			'export const eventRegistry = {} as Record<EventTypeName, EventMetadata>;',
		);

		// A missing events/ is a warning, not an error.
		expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
	});

	test('merge: top-level and entity sugar produce one registry entry, warning emitted', async () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		const eventsDir = path.join(root, 'events');
		const outputDir = path.join(root, 'out');

		writeEntityYaml(
			entitiesDir,
			'contact',
			`entity:
  name: contact
  plural: contacts
  table: contacts
fields:
  id:
    type: uuid
    required: true
events:
  - name: contact_created
    queue: domain-events
    body:
      contact_id: uuid
`,
		);
		writeEventYaml(
			eventsDir,
			'contact_created',
			`type: contact_created
direction: change
aggregate: contact
description: top-level wins
payload:
  contact_id:
    type: uuid
  extra_field:
    type: string
`,
		);

		const result = await generateEventCodegen({
			entitiesDir,
			eventsDir,
			outputDir,
		});

		expect(result.eventCount).toBe(1);
		expect(
			result.issues.some(
				(i) =>
					i.severity === 'warning' && i.type === 'event_merge_override',
			),
		).toBe(true);

		const types = fs.readFileSync(path.join(outputDir, 'types.ts'), 'utf-8');
		// Top-level wins → includes extra_field.
		expect(types).toContain('extraField: string;');
	});

	test('load error (bad event YAML) prevents writes', async () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		const eventsDir = path.join(root, 'events');
		const outputDir = path.join(root, 'out');
		fs.mkdirSync(entitiesDir, { recursive: true });
		writeEventYaml(
			eventsDir,
			'bad_event',
			`type: mismatched_type
direction: change
aggregate: contact
payload: {}
`,
		);

		const result = await generateEventCodegen({
			entitiesDir,
			eventsDir,
			outputDir,
		});

		expect(result.written).toBe(false);
		expect(
			result.issues.some((i) => i.severity === 'error'),
		).toBe(true);
		expect(fs.existsSync(path.join(outputDir, 'types.ts'))).toBe(false);
	});
});

describe('collectMergedEvents (EVT-7)', () => {
	test('exposes the same merged events as generateEventCodegen', async () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'entities');
		const eventsDir = path.join(root, 'events');
		const outputDir = path.join(root, 'out');

		writeEntityYaml(
			entitiesDir,
			'contact',
			`entity:
  name: contact
  plural: contacts
  table: contacts
fields:
  id:
    type: uuid
    required: true
events:
  - name: contact_merged
    queue: domain-events
    body:
      source_id: uuid
      target_id: uuid
`,
		);

		writeEventYaml(
			eventsDir,
			'contact_created',
			`type: contact_created
direction: change
aggregate: contact
payload:
  contact_id:
    type: uuid
`,
		);

		const helper = collectMergedEvents({ entitiesDir, eventsDir });
		const genRun = await generateEventCodegen({
			entitiesDir,
			eventsDir,
			outputDir,
			dryRun: true,
		});

		expect(helper.events.map((e) => e.type).sort()).toEqual(
			genRun.events.map((e) => e.type).sort(),
		);
		expect(helper.events.map((e) => e.type)).toContain('contact_created');
		expect(helper.events.map((e) => e.type)).toContain('contact_merged');
	});

	test('returns empty events + warning when no dirs exist', () => {
		const root = mkTempRoot();
		const entitiesDir = path.join(root, 'missing-entities');
		const eventsDir = path.join(root, 'missing-events');

		const result = collectMergedEvents({ entitiesDir, eventsDir });
		expect(result.events).toEqual([]);
		expect(result.issues.some((i) => i.type === 'no_events_dir')).toBe(true);
	});
});
