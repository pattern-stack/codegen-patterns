/**
 * Event codegen generator — writes codegen-owned TypeScript artifacts derived
 * from `events/*.yaml` plus entity `events:` block desugaring.
 *
 * Output: runtime/subsystems/events/generated/{types,schemas,registry,bus,index}.ts
 *
 * Consumer usage:
 *   import { TypedEventBus, eventPayloadSchemas, getEventMetadata } from
 *     './runtime/subsystems/events/generated';
 *   import type { AppDomainEvent, EventTypeName, PayloadOfType }
 *     from './runtime/subsystems/events/generated';
 *
 * Pattern mirrors scope-entity-type-generator.ts: HEADER constant, pure
 * content-builders unit-tested in isolation, one orchestrating entrypoint that
 * handles disk I/O with dryRun semantics.
 *
 * See EVT-3 spec, ADR-024 §"Generated artifacts".
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AnalysisIssue } from '../../analyzer/types.js';
import { loadEntityFromYaml } from '../../utils/yaml-loader.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import {
	desugarEntityEvents,
	loadEvents,
} from '../../parser/load-events.js';
import type {
	EventDefinition,
	EventFieldType,
	EventPayloadField,
} from '../../schema/event-definition.schema.js';
import type { RuntimeMode } from './runtime-import.js';

// ---------------------------------------------------------------------------
// Mode-aware runtime imports (ADR-037)
// ---------------------------------------------------------------------------

/**
 * The generated event files import three things from the events RUNTIME:
 * `DomainEvent` / `IEventBus` / `DrizzleTransaction` (the protocol), the
 * `EVENT_BUS` / `EVENTS_MULTI_TENANT` tokens, and `MissingTenantIdError`.
 *
 * In vendored mode those sit as siblings of the generated dir
 * (`../event-bus.protocol`, `../events.tokens`, `../events-errors`). In package
 * mode the generated files land in the consumer's `src/generated/events/`,
 * which has no relative line of sight to the package-internal runtime — so all
 * three resolve through the published events index barrel (which re-exports
 * every one of those symbols).
 */
const PACKAGE_EVENTS_RUNTIME_IMPORT =
	'@pattern-stack/codegen/runtime/subsystems/events/index';

/**
 * Build the package-mode `DomainEventRegistry` augmentation block (ADR-037,
 * package-mode trigger typing). Emitted ONLY in package mode and ONLY when the
 * project declares at least one event.
 *
 * The published runtime keys the bridge + job-trigger types off an EMPTY,
 * augmentable `DomainEventRegistry` interface (events/event-registry.ts), so
 * `EventTypeName` defaults to `string` until a consumer fills it in. This block
 * declaration-merges the consumer's events into that interface via the events
 * INDEX module specifier — the public, stable augmentation target the runtime
 * re-exports the interface from. After this merges, the consumer's
 * `bridge-registry.ts` and their `@JobHandler({ triggers })` see their own
 * `EventTypeName` union with full `EventOfType<T>` payload typing.
 *
 * In vendored mode this is unnecessary (the bridge/job types import the
 * consumer's vendored `./generated/types` directly) and not emitted, so
 * vendored output stays byte-stable.
 */
function buildRegistryAugmentationBlock(events: EventDefinition[]): string {
	const sorted = [...events].sort((a, b) => a.type.localeCompare(b.type));
	const chunks: string[] = [];
	chunks.push(
		`// Package-mode trigger typing (ADR-037): merge these events into the runtime's`,
	);
	chunks.push(
		`// augmentable \`DomainEventRegistry\` so the bridge + \`@JobHandler({ triggers })\``,
	);
	chunks.push(
		`// types (which key off the published \`EventTypeName\`) see THIS project's events`,
	);
	chunks.push(`// with full \`EventOfType<T>\` payload typing.`);
	chunks.push(`declare module '${PACKAGE_EVENTS_RUNTIME_IMPORT}' {`);
	chunks.push(`\tinterface DomainEventRegistry {`);
	for (const ev of sorted) {
		chunks.push(`\t\t'${ev.type}': ${toPascalCase(ev.type)}Event;`);
	}
	chunks.push(`\t}`);
	chunks.push(`}`);
	return chunks.join('\n');
}

interface EventsRuntimeImports {
	/** `DomainEvent`, `IEventBus`, `DrizzleTransaction`. */
	protocol: string;
	/** `EVENT_BUS`, `EVENTS_MULTI_TENANT`. */
	tokens: string;
	/** `MissingTenantIdError`. */
	errors: string;
}

function eventsRuntimeImports(mode: RuntimeMode): EventsRuntimeImports {
	if (mode === 'package') {
		return {
			protocol: PACKAGE_EVENTS_RUNTIME_IMPORT,
			tokens: PACKAGE_EVENTS_RUNTIME_IMPORT,
			errors: PACKAGE_EVENTS_RUNTIME_IMPORT,
		};
	}
	return {
		protocol: '../event-bus.protocol',
		tokens: '../events.tokens',
		errors: '../events-errors',
	};
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventCodegenGeneratorOptions {
	/** Absolute path to the entities directory (used for desugaring entity events: blocks). */
	entitiesDir: string;
	/** Absolute path to the events directory (top-level events/*.yaml files). */
	eventsDir: string;
	/** Absolute path to the generator's output directory. */
	outputDir: string;
	/**
	 * Runtime mode (ADR-037). Defaults to `'vendored'` so existing callers/tests
	 * and the vendored emission are byte-stable. In `'package'` mode the three
	 * runtime imports (`protocol` / `tokens` / `errors`) resolve through the
	 * published events index barrel instead of vendored `../` siblings — the
	 * consumer's generated files then typecheck from `src/generated/events/`.
	 */
	mode?: RuntimeMode;
	/** If true, compute content but don't write to disk. */
	dryRun?: boolean;
	/**
	 * Synthesized events to merge on the sugar arm (RFC-0005 #7: the jobs emitter's
	 * job-private scheduled-event ticks). Threaded to `collectMergedEvents`.
	 */
	extraSugarEvents?: EventDefinition[];
}

export interface EventCodegenFileOutput {
	/** Absolute path. */
	outputPath: string;
	/** File basename (e.g. 'types.ts'). */
	name: string;
	/** Content actually written (or planned in dry-run). */
	content: string;
}

export interface EventCodegenResult {
	outputDir: string;
	/** Number of events actually rendered into the generated files. */
	eventCount: number;
	/** Merged + deduplicated EventDefinitions used to render. */
	events: EventDefinition[];
	/** Issues surfaced during load / merge. */
	issues: AnalysisIssue[];
	/** Whether files were written to disk. */
	written: boolean;
	/** All five file outputs — always populated (content available for dry-run reports). */
	files: EventCodegenFileOutput[];
}

// ---------------------------------------------------------------------------
// Header — mirrors scope-entity-type-generator and barrel-generator.
// ---------------------------------------------------------------------------

const HEADER =
	`// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.\n` +
	`// Run \`codegen entity new --all\` to refresh.\n`;

// ---------------------------------------------------------------------------
// Case helpers — intentionally local to avoid a dependency on
// case-converters.mjs from a TS module (matches barrel-generator.ts convention).
// ---------------------------------------------------------------------------

/** `contact_id` → `contactId`, `a_b_c` → `aBC`. Assumes valid snake_case input. */
export function toCamelCase(input: string): string {
	const parts = input.split('_').filter(Boolean);
	if (parts.length === 0) return input;
	const [first, ...rest] = parts;
	return (
		(first ?? '') +
		rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
	);
}

/** `contact_created` → `ContactCreated`. */
export function toPascalCase(input: string): string {
	return input
		.split('_')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('');
}

// ---------------------------------------------------------------------------
// TS-type and Zod mapping tables (EventFieldType → TS / Zod)
// ---------------------------------------------------------------------------

// For non-array types only. `array` goes through its own branch that also
// needs the `items` hint to emit `T[]` / `z.array(T)`.
const TS_TYPE_BY_FIELD: Record<Exclude<EventFieldType, 'array'>, string> = {
	uuid: 'string',
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	date: 'Date',
	json: 'Record<string, unknown>',
};

const ZOD_EXPR_BY_FIELD: Record<Exclude<EventFieldType, 'array'>, string> = {
	uuid: 'z.string().uuid()',
	string: 'z.string()',
	number: 'z.number()',
	boolean: 'z.boolean()',
	date: 'z.coerce.date()',
	json: 'z.record(z.unknown())',
};

function tsTypeForField(field: EventPayloadField): string {
	let base: string;
	if (field.type === 'array') {
		// Schema validation guarantees `items` is defined for `type: 'array'`.
		const itemType = field.items as Exclude<EventFieldType, 'array' | 'json'>;
		base = `${TS_TYPE_BY_FIELD[itemType]}[]`;
	} else {
		base = TS_TYPE_BY_FIELD[field.type];
	}
	return field.nullable ? `${base} | null` : base;
}

function zodExprForField(field: EventPayloadField): string {
	let base: string;
	if (field.type === 'array') {
		const itemType = field.items as Exclude<EventFieldType, 'array' | 'json'>;
		base = `z.array(${ZOD_EXPR_BY_FIELD[itemType]})`;
	} else {
		base = ZOD_EXPR_BY_FIELD[field.type];
	}
	return field.nullable ? `${base}.nullable()` : base;
}

/**
 * `aggregateType` literal for a generated interface.
 *
 * Per ADR-024: aggregate ?? source ?? destination ?? type. The generator
 * computes the same precedence as `TypedEventBus.publish()`'s runtime
 * fallback, so the type-level literal matches the value stamped into
 * `DomainEvent.aggregateType` at publish time.
 */
function aggregateTypeLiteral(ev: EventDefinition): string {
	return ev.aggregate ?? ev.source ?? ev.destination ?? ev.type;
}

// ---------------------------------------------------------------------------
// Event discovery + merge
// ---------------------------------------------------------------------------

/**
 * Walk `entitiesDir`, load each entity, and desugar its `events:` block into
 * `EventDefinition[]`. Entities that fail to load are silently skipped — the
 * entity loader / validator reports those elsewhere in the pipeline, and we
 * don't want a single bad entity to block event generation for the rest.
 */
export function collectEntityEvents(entitiesDir: string): {
	events: EventDefinition[];
	issues: AnalysisIssue[];
} {
	const events: EventDefinition[] = [];
	const issues: AnalysisIssue[] = [];

	if (!fs.existsSync(entitiesDir)) {
		return { events, issues };
	}

	const files = findYamlFiles(entitiesDir);

	for (const filePath of files) {
		const result = loadEntityFromYaml(filePath);
		if (!result.success) continue;
		try {
			events.push(...desugarEntityEvents(result.definition));
		} catch (err) {
			issues.push({
				severity: 'error',
				type: 'entity_event_desugar_failed',
				message: err instanceof Error ? err.message : String(err),
				path: filePath,
			});
		}
	}

	return { events, issues };
}

/**
 * Merge top-level events (from `events/*.yaml`) with entity-sugar events.
 *
 * Merge policy: top-level events win on `type` collision. A `warning` issue
 * is emitted per collision so authors can see they're overriding sugar.
 * This is the first concrete implementation of the policy declared in the
 * EVT-3 plan and the EVT-7 spec.
 */
export function mergeEvents(
	topLevel: EventDefinition[],
	entitySugar: EventDefinition[],
): { events: EventDefinition[]; issues: AnalysisIssue[] } {
	const issues: AnalysisIssue[] = [];
	const byType = new Map<string, EventDefinition>();

	// Sugar first — top-level can override.
	for (const ev of entitySugar) {
		byType.set(ev.type, ev);
	}

	for (const ev of topLevel) {
		if (byType.has(ev.type)) {
			issues.push({
				severity: 'warning',
				type: 'event_merge_override',
				message: `event '${ev.type}' is declared both in an entity \`events:\` block and a top-level \`events/${ev.type}.yaml\` — top-level definition wins`,
			});
		}
		byType.set(ev.type, ev);
	}

	const events = Array.from(byType.values()).sort((a, b) =>
		a.type.localeCompare(b.type),
	);

	return { events, issues };
}

// ---------------------------------------------------------------------------
// Exported helper: collectMergedEvents (EVT-7)
// ---------------------------------------------------------------------------

export interface CollectMergedEventsOptions {
	/** Absolute path to the entities directory. */
	entitiesDir: string;
	/** Absolute path to the events directory. */
	eventsDir: string;
	/**
	 * Synthesized events contributed by other generators, merged on the SUGAR arm
	 * (RFC-0005 #7: the jobs emitter's job-private scheduled-event ticks, one per
	 * `schedule` arm). Treated exactly like entity `events:` sugar — a hand-authored
	 * top-level `events/*.yaml` of the same `type` still wins (top-level-wins).
	 */
	extraSugarEvents?: EventDefinition[];
}

export interface CollectMergedEventsResult {
	/** Merged + deduplicated EventDefinitions (same shape as generateEventCodegen). */
	events: EventDefinition[];
	/** Issues surfaced during load / merge (warnings + errors). */
	issues: AnalysisIssue[];
}

/**
 * Load + merge events from `events/*.yaml` and entity `events:` block desugar,
 * without writing any files.
 *
 * Exposed for callers that need the merged registry before Hygen runs (e.g.
 * `validateEntityEmits()` in `EntityNewCommand.execute()` pre-flight). Mirrors
 * the internal `generateEventCodegen()` flow so both paths observe the same
 * `{ events, issues }` shape.
 */
export function collectMergedEvents(
	opts: CollectMergedEventsOptions,
): CollectMergedEventsResult {
	const { entitiesDir, eventsDir } = opts;

	// 1. Gather entity names (for loadEvents cross-validation).
	const entityNames: string[] = [];
	if (fs.existsSync(entitiesDir)) {
		const entityFiles = findYamlFiles(entitiesDir);
		for (const f of entityFiles) {
			const result = loadEntityFromYaml(f);
			if (result.success) entityNames.push(result.definition.entity.name);
		}
	}

	// 2. Load top-level events and desugar entity events.
	const topLevelResult = loadEvents(eventsDir, entityNames);
	const { events: entitySugar, issues: sugarIssues } =
		collectEntityEvents(entitiesDir);

	// 3. Merge (top-level wins on collision). Extra synthesized events (RFC-0005 #7
	//    job-private scheduled ticks) ride the sugar arm alongside entity sugar.
	const { events: merged, issues: mergeIssues } = mergeEvents(
		topLevelResult.events,
		[...entitySugar, ...(opts.extraSugarEvents ?? [])],
	);

	const issues: AnalysisIssue[] = [
		...topLevelResult.issues,
		...sugarIssues,
		...mergeIssues,
	];

	return { events: merged, issues };
}

// ---------------------------------------------------------------------------
// Content builder: types.ts
// ---------------------------------------------------------------------------

export function buildTypesContent(
	events: EventDefinition[],
	mode: RuntimeMode = 'vendored',
): string {
	const sorted = [...events].sort((a, b) => a.type.localeCompare(b.type));
	const protocolImport = eventsRuntimeImports(mode).protocol;

	if (sorted.length === 0) {
		return (
			HEADER +
			'\n' +
			`import type { DomainEvent } from '${protocolImport}';\n` +
			'\n' +
			`export type AppDomainEvent = never;\n` +
			'\n' +
			`export type EventTypeName = string;\n` +
			// No events declared: fall back to the DomainEvent base rather than
			// `never`. `never` makes every consumer of EventOfType (e.g. the
			// bridge EventFlowService' `event.type`/`event.id`) fail to type-check
			// in a no-events project. DomainEvent has the structural fields the
			// subsystem code relies on; payloads are untyped (Record).
			`export type EventOfType<T extends EventTypeName> = DomainEvent;\n` +
			`export type PayloadOfType<T extends EventTypeName> = DomainEvent['payload'];\n`
		);
	}

	const chunks: string[] = [];
	chunks.push(HEADER);
	chunks.push('');
	chunks.push(`import type { DomainEvent } from '${protocolImport}';`);
	chunks.push('');

	for (const ev of sorted) {
		const interfaceName = `${toPascalCase(ev.type)}Event`;
		const aggregateLit = aggregateTypeLiteral(ev);

		if (ev.description) {
			chunks.push(`/** ${ev.description} */`);
		}
		chunks.push(`export interface ${interfaceName} extends DomainEvent {`);
		chunks.push(`\treadonly type: '${ev.type}';`);
		chunks.push(`\treadonly aggregateType: '${aggregateLit}';`);

		const payloadKeys = Object.keys(ev.payload).sort();
		if (payloadKeys.length === 0) {
			chunks.push(`\treadonly payload: Record<string, never>;`);
		} else {
			chunks.push(`\treadonly payload: {`);
			for (const key of payloadKeys) {
				const field = ev.payload[key];
				if (!field) continue;
				if (field.description) {
					chunks.push(`\t\t/** ${field.description} */`);
				}
				chunks.push(`\t\t${toCamelCase(key)}: ${tsTypeForField(field)};`);
			}
			chunks.push(`\t};`);
		}
		chunks.push(`}`);
		chunks.push('');
	}

	// Union + helpers
	const unionMembers = sorted.map((ev) => `${toPascalCase(ev.type)}Event`);
	chunks.push(`export type AppDomainEvent =`);
	chunks.push(`\t| ${unionMembers.join('\n\t| ')};`);
	chunks.push('');
	chunks.push(`export type EventTypeName = AppDomainEvent['type'];`);
	chunks.push(
		`export type EventOfType<T extends EventTypeName> = Extract<AppDomainEvent, { type: T }>;`,
	);
	chunks.push(
		`export type PayloadOfType<T extends EventTypeName> = EventOfType<T>['payload'];`,
	);
	chunks.push('');

	// Package-mode augmentation (ADR-037): in package mode the bridge + trigger
	// types key off the published runtime's augmentable `DomainEventRegistry`,
	// not the consumer's local `EventTypeName` above. Emit a `declare module`
	// block so they pick up this project's events. Vendored mode imports the
	// local types directly and needs no augmentation (byte-stable).
	if (mode === 'package') {
		chunks.push(buildRegistryAugmentationBlock(sorted));
		chunks.push('');
	}

	return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Content builder: schemas.ts
// ---------------------------------------------------------------------------

export function buildSchemasContent(events: EventDefinition[]): string {
	const sorted = [...events].sort((a, b) => a.type.localeCompare(b.type));

	if (sorted.length === 0) {
		return (
			HEADER +
			'\n' +
			`import { z } from 'zod';\n` +
			`import type { EventTypeName } from './types';\n` +
			'\n' +
			`export const eventPayloadSchemas = {} as Record<EventTypeName, z.ZodType>;\n`
		);
	}

	const chunks: string[] = [];
	chunks.push(HEADER);
	chunks.push('');
	chunks.push(`import { z } from 'zod';`);
	chunks.push(`import type { EventTypeName } from './types';`);
	chunks.push('');

	for (const ev of sorted) {
		const schemaConst = `${toCamelCase(ev.type)}PayloadSchema`;
		const payloadKeys = Object.keys(ev.payload).sort();

		if (payloadKeys.length === 0) {
			chunks.push(`export const ${schemaConst} = z.object({}).strict();`);
			chunks.push('');
			continue;
		}

		chunks.push(`export const ${schemaConst} = z.object({`);
		for (const key of payloadKeys) {
			const field = ev.payload[key];
			if (!field) continue;
			chunks.push(`\t${toCamelCase(key)}: ${zodExprForField(field)},`);
		}
		chunks.push(`}).strict();`);
		chunks.push('');
	}

	chunks.push(`export const eventPayloadSchemas = {`);
	for (const ev of sorted) {
		chunks.push(`\t'${ev.type}': ${toCamelCase(ev.type)}PayloadSchema,`);
	}
	chunks.push(`} as const satisfies Record<EventTypeName, z.ZodType>;`);
	chunks.push('');

	return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Content builder: registry.ts
// ---------------------------------------------------------------------------

const REGISTRY_INTERFACE = [
	'export interface EventMetadata {',
	'\ttype: EventTypeName;',
	"\ttier: 'domain' | 'audit';",
	"\tdirection: 'inbound' | 'change' | 'outbound' | null;",
	"\tpool: 'events_inbound' | 'events_change' | 'events_outbound' | null;",
	'\taggregate?: string;',
	'\tsource?: string;',
	'\tdestination?: string;',
	'\tversion: number;',
	"\tretry: { attempts: number; backoff: 'linear' | 'exponential' };",
	// ADR-039 — declarative time-based emission. Present only on scheduled
	// events; the runtime EventScheduler reads it (+ direction/pool above) to
	// materialise ticks. `every` is ms-or-duration-string; the rest carry the
	// schema defaults.
	'\tschedule?: { every: string | number; align: boolean; catchUp: boolean; maxCatchUpSlots: number };',
	'}',
].join('\n');

/**
 * The same `getEventMetadata` body is emitted in empty and non-empty cases.
 * Keeping the function uniform lets consumers rely on "throws on unknown type"
 * regardless of whether the registry was populated at codegen time.
 */
const REGISTRY_GETTER = [
	'export function getEventMetadata<T extends EventTypeName>(type: T): EventMetadata {',
	'\tconst meta = eventRegistry[type];',
	'\tif (!meta) {',
	"\t\tthrow new Error(`No registry entry for event type '${String(type)}' — declare events under events/*.yaml and re-run \\`codegen entity new --all\\`.`);",
	'\t}',
	'\treturn meta;',
	'}',
].join('\n');

export function buildRegistryContent(events: EventDefinition[]): string {
	const sorted = [...events].sort((a, b) => a.type.localeCompare(b.type));

	const chunks: string[] = [];
	chunks.push(HEADER);
	chunks.push('');
	chunks.push(`import type { EventTypeName } from './types';`);
	chunks.push('');
	chunks.push(REGISTRY_INTERFACE);
	chunks.push('');

	if (sorted.length === 0) {
		chunks.push(
			`export const eventRegistry = {} as Record<EventTypeName, EventMetadata>;`,
		);
		chunks.push('');
		chunks.push(REGISTRY_GETTER);
		chunks.push('');
		return chunks.join('\n');
	}

	chunks.push(`export const eventRegistry = {`);
	for (const ev of sorted) {
		const tier = ev.tier ?? 'domain';
		chunks.push(`\t'${ev.type}': {`);
		chunks.push(`\t\ttype: '${ev.type}',`);
		chunks.push(`\t\ttier: '${tier}',`);
		if (tier === 'audit') {
			// Audit events have no routing fields (AUDIT-1/AUDIT-2 invariant).
			chunks.push(`\t\tdirection: null,`);
			chunks.push(`\t\tpool: null,`);
		} else {
			chunks.push(`\t\tdirection: '${ev.direction}',`);
			chunks.push(`\t\tpool: '${ev.pool}',`);
		}
		if (ev.aggregate !== undefined) {
			chunks.push(`\t\taggregate: '${ev.aggregate}',`);
		}
		if (ev.source !== undefined) {
			chunks.push(`\t\tsource: '${ev.source}',`);
		}
		if (ev.destination !== undefined) {
			chunks.push(`\t\tdestination: '${ev.destination}',`);
		}
		chunks.push(`\t\tversion: ${ev.version},`);
		chunks.push(
			`\t\tretry: { attempts: ${ev.retry.attempts}, backoff: '${ev.retry.backoff}' },`,
		);
		// ADR-039 — emit the schedule block when present (parsed defaults applied
		// by the schema: align/catchUp/maxCatchUpSlots always set). `every` is
		// number-or-string; quote strings, emit numbers bare.
		if (ev.schedule !== undefined) {
			const every =
				typeof ev.schedule.every === 'number'
					? String(ev.schedule.every)
					: `'${ev.schedule.every}'`;
			chunks.push(
				`\t\tschedule: { every: ${every}, align: ${ev.schedule.align}, ` +
					`catchUp: ${ev.schedule.catchUp}, maxCatchUpSlots: ${ev.schedule.maxCatchUpSlots} },`,
			);
		}
		chunks.push(`\t},`);
	}
	chunks.push(
		`} as const satisfies Record<EventTypeName, EventMetadata>;`,
	);
	chunks.push('');
	chunks.push(REGISTRY_GETTER);
	chunks.push('');

	return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Content builder: bus.ts
// ---------------------------------------------------------------------------

/**
 * Class body is fully static — no YAML-derived content. Kept in a single
 * template string so empty/non-empty cases emit byte-identical output beyond
 * the shared header.
 */
const BUS_BODY = `import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EVENT_BUS, EVENTS_MULTI_TENANT } from '../events.tokens';
import { MissingTenantIdError } from '../events-errors';
import type { IEventBus, DrizzleTransaction } from '../event-bus.protocol';
import { eventPayloadSchemas } from './schemas';
import { getEventMetadata } from './registry';
import type { EventTypeName, EventOfType, PayloadOfType } from './types';

/**
 * Typed facade over IEventBus.
 *
 * Stamps \`pool\`, \`direction\`, \`tier\`, and \`version\` into \`event.metadata\`
 * from the generated \`eventRegistry\` before delegating to
 * \`IEventBus.publish()\`. Downstream backends (DrizzleEventBus) read those
 * values to populate the explicit \`domain_events\` columns.
 *
 * Tier stamping (AUDIT-3): every event carries \`metadata.tier\`, sourced
 * from the registry. For \`tier: 'audit'\` events, the bus FORCES
 * \`metadata.pool = null\` and \`metadata.direction = null\` regardless of
 * any caller-supplied values in \`opts.metadata\` — audit routing is
 * bus-stamped, not caller-controlled. Caller overrides are silently
 * dropped with a debug-level log (callers should not be specifying these
 * for audit events; see ai-docs/specs/issue-242/plan.md §AUDIT-3).
 *
 * Validation gating (EVT-Q5): \`CODEGEN_EVENT_VALIDATE\` env flag, default on.
 * Uses \`safeParse\` + \`console.warn\` — never throws, so a bad publish does
 * not crash a hot path.
 *
 * Multi-tenancy (EVT-6): when the EventsModule is configured with
 * \`multiTenant: true\`, every publish must supply \`opts.metadata.tenantId\`
 * — otherwise \`publish()\` throws \`MissingTenantIdError\`. When \`multiTenant\`
 * is \`false\` (default), no tenantId is required. If a tenantId IS supplied,
 * it is preserved on \`event.metadata\` and the Drizzle backend writes it to
 * \`domain_events.tenant_id\` (EVT-4).
 */
@Injectable()
export class TypedEventBus {
\tconstructor(
\t\t@Inject(EVENT_BUS) private readonly bus: IEventBus,
\t\t@Inject(EVENTS_MULTI_TENANT) private readonly multiTenant: boolean,
\t) {}

\tasync publish<T extends EventTypeName>(
\t\ttype: T,
\t\taggregateId: string,
\t\tpayload: PayloadOfType<T>,
\t\topts?: { tx?: DrizzleTransaction; metadata?: Record<string, unknown> },
\t): Promise<void> {
\t\tconst meta = getEventMetadata(type);

\t\tconst flag = process.env['CODEGEN_EVENT_VALIDATE'];
\t\tconst shouldValidate =
\t\t\tflag === undefined ? true : flag !== 'false' && flag !== '0';
\t\tif (shouldValidate) {
\t\t\t// \`eventPayloadSchemas\` is typed as \`Record<EventTypeName, z.ZodType>\`,
\t\t\t// so under \`noUncheckedIndexedAccess\` the indexed lookup widens
\t\t\t// to \`z.ZodType | undefined\`. When no events are registered at
\t\t\t// codegen time \`EventTypeName\` degrades to \`string\` and the
\t\t\t// schemas object is literally \`{}\` — the guard below is the
\t\t\t// honest handling of that empty-registry case (skip validation;
\t\t\t// it's a warn-only best-effort check per the class docblock).
\t\t\tconst schema = eventPayloadSchemas[type];
\t\t\tif (schema) {
\t\t\t\tconst check = schema.safeParse(payload);
\t\t\t\tif (!check.success) {
\t\t\t\t\tconsole.warn(
\t\t\t\t\t\t\`[TypedEventBus] payload validation failed for \${String(type)}:\`,
\t\t\t\t\t\tcheck.error.issues,
\t\t\t\t\t);
\t\t\t\t}
\t\t\t}
\t\t}

\t\tconst tenantId = opts?.metadata?.['tenantId'];
\t\tif (this.multiTenant && (tenantId === undefined || tenantId === null)) {
\t\t\tthrow new MissingTenantIdError(type as string);
\t\t}

\t\tconst aggregateType =
\t\t\tmeta.aggregate ?? meta.source ?? meta.destination ?? (type as string);

\t\t// AUDIT-3: build metadata with tier-aware routing stamping. For
\t\t// \`tier: 'audit'\` events the bus FORCES pool/direction to null,
\t\t// even if the caller supplied them in opts.metadata. Audit routing
\t\t// is bus-stamped, not caller-controlled (see plan §AUDIT-3).
\t\tconst baseMetadata: Record<string, unknown> = { ...(opts?.metadata ?? {}) };
\t\tif (meta.tier === 'audit') {
\t\t\tif (
\t\t\t\tbaseMetadata['pool'] !== undefined ||
\t\t\t\tbaseMetadata['direction'] !== undefined
\t\t\t) {
\t\t\t\tconsole.debug(
\t\t\t\t\t\`[TypedEventBus] tier:audit event '\${String(type)}' had pool/direction in opts.metadata; overriding to null.\`,
\t\t\t\t);
\t\t\t}
\t\t\tbaseMetadata['pool'] = null;
\t\t\tbaseMetadata['direction'] = null;
\t\t\tbaseMetadata['tier'] = 'audit';
\t\t} else {
\t\t\tbaseMetadata['pool'] = meta.pool;
\t\t\tbaseMetadata['direction'] = meta.direction;
\t\t\tbaseMetadata['tier'] = 'domain';
\t\t}
\t\tbaseMetadata['version'] = meta.version;

\t\tawait this.bus.publish(
\t\t\t{
\t\t\t\tid: randomUUID(),
\t\t\t\ttype,
\t\t\t\taggregateId,
\t\t\t\taggregateType,
\t\t\t\tpayload: payload as Record<string, unknown>,
\t\t\t\toccurredAt: new Date(),
\t\t\t\tmetadata: baseMetadata,
\t\t\t},
\t\t\topts?.tx,
\t\t);
\t}

\tsubscribe<T extends EventTypeName>(
\t\ttype: T,
\t\thandler: (event: EventOfType<T>) => Promise<void>,
\t): () => void {
\t\treturn this.bus.subscribe<EventOfType<T>>(type, handler as never);
\t}
}
`;

export function buildBusContent(
	_events: EventDefinition[],
	mode: RuntimeMode = 'vendored',
): string {
	// Body is identical for empty and non-empty projects; the behaviour
	// difference lives in registry.ts (empty throws on any lookup). Only the
	// three runtime imports are mode-dependent (ADR-037) — in package mode they
	// resolve through the published events index barrel. Vendored mode returns
	// BUS_BODY untouched (byte-stable).
	let body = BUS_BODY;
	if (mode === 'package') {
		body = body
			.replace(`from '../events.tokens'`, `from '${PACKAGE_EVENTS_RUNTIME_IMPORT}'`)
			.replace(`from '../events-errors'`, `from '${PACKAGE_EVENTS_RUNTIME_IMPORT}'`)
			.replace(`from '../event-bus.protocol'`, `from '${PACKAGE_EVENTS_RUNTIME_IMPORT}'`);
	}
	return HEADER + '\n' + body;
}

// ---------------------------------------------------------------------------
// Content builder: index.ts
// ---------------------------------------------------------------------------

export function buildIndexContent(_events: EventDefinition[]): string {
	return (
		HEADER +
		'\n' +
		`export * from './types';\n` +
		`export * from './schemas';\n` +
		`export * from './registry';\n` +
		`export * from './bus';\n`
	);
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

const OUTPUT_FILE_NAMES = [
	'types.ts',
	'schemas.ts',
	'registry.ts',
	'bus.ts',
	'index.ts',
] as const;

/**
 * Build all five generated file contents for an event set, mode-aware (ADR-037).
 * Pure — no fs. Shared by the entrypoint and the subsystem-barrel stub writer
 * (package mode) so the empty-set output is identical in both. `types.ts` /
 * `bus.ts` thread `mode` (their runtime imports differ); the other three have
 * no runtime imports and ignore it.
 */
export function buildEventCodegenContents(
	events: EventDefinition[],
	mode: RuntimeMode = 'vendored',
): Array<{ name: (typeof OUTPUT_FILE_NAMES)[number]; content: string }> {
	return [
		{ name: 'types.ts', content: buildTypesContent(events, mode) },
		{ name: 'schemas.ts', content: buildSchemasContent(events) },
		{ name: 'registry.ts', content: buildRegistryContent(events) },
		{ name: 'bus.ts', content: buildBusContent(events, mode) },
		{ name: 'index.ts', content: buildIndexContent(events) },
	];
}

export async function generateEventCodegen(
	opts: EventCodegenGeneratorOptions,
): Promise<EventCodegenResult> {
	const { entitiesDir, eventsDir, outputDir, mode = 'vendored', dryRun = false, extraSugarEvents } = opts;

	// 1–3. Load + merge via the shared helper. `no_events_dir` / `no_files`
	// warnings are retained — the generator still emits stub files, matching
	// JOB-7's empty case.
	const { events: merged, issues } = collectMergedEvents({
		entitiesDir,
		eventsDir,
		extraSugarEvents,
	});

	// 4. Build all file contents (mode-aware import resolution).
	const files: EventCodegenFileOutput[] = buildEventCodegenContents(merged, mode).map(
		({ name, content }) => ({
			name,
			outputPath: path.join(outputDir, name),
			content,
		}),
	);

	// 5. Write (or not) — fail-loud on `severity: 'error'` issues.
	const hasError = issues.some((i) => i.severity === 'error');
	let written = false;
	if (!dryRun && !hasError) {
		fs.mkdirSync(outputDir, { recursive: true });
		for (const file of files) {
			fs.writeFileSync(file.outputPath, file.content);
		}
		written = true;
	}

	return {
		outputDir,
		eventCount: merged.length,
		events: merged,
		issues,
		written,
		files,
	};
}
