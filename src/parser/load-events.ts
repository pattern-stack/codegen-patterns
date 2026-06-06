/**
 * Event Loader
 *
 * Loads and parses all `events/*.yaml` files from a directory. Cross-validates
 * change events' `aggregate` against a caller-supplied list of known entity
 * names, and enforces filename ↔ `type` consistency. Returns a
 * {@link LoadEventsResult} that collects all issues (never throws), matching
 * the `loadEntities()` / `loadRelationships()` contract used elsewhere in the
 * parser layer.
 *
 * Also exposes {@link desugarEntityEvents}, a pure helper that synthesizes
 * `EventDefinition[]` from an entity's inline `events:` block. The desugar
 * step is decoupled from `load-entities.ts` on purpose — the merge between
 * top-level event files and entity-sugar events happens at the generator
 * boundary (EVT-3), not inside either loader.
 */

import { basename, resolve } from 'node:path';
import { findYamlFiles } from '../utils/find-yaml-files';
import type { AnalysisIssue } from '../analyzer/types';
import {
	DIRECTION_TO_POOL,
	EVENT_FIELD_TYPES,
	type EventDefinition,
	type EventFieldType,
	type EventPayloadField,
} from '../schema/event-definition.schema';
import type { EntityDefinition } from '../schema/entity-definition.schema';
import {
	loadEventFromYaml,
	type EventLoadError,
	type LoadEventResult,
} from '../utils/yaml-loader';

export interface LoadEventsResult {
	events: EventDefinition[];
	issues: AnalysisIssue[];
}

/**
 * Convert an event-load error result into one or more {@link AnalysisIssue}s.
 * Mirrors the `loadErrorToIssue` helper in `load-entities.ts` exactly so CLI
 * renderers can treat both loaders' output uniformly.
 */
function loadErrorToIssue(error: EventLoadError): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	issues.push({
		severity: 'error',
		type: 'parse_error',
		message: error.error,
		path: error.filePath,
	});

	if (error.details) {
		for (const detail of error.details) {
			issues.push({
				severity: 'error',
				type: 'schema_error',
				message: detail,
				path: error.filePath,
			});
		}
	}

	return issues;
}

/**
 * Strip `.yaml` / `.yml` from a filename.
 */
function stripYamlExt(file: string): string {
	const base = basename(file);
	if (base.endsWith('.yaml')) return base.slice(0, -'.yaml'.length);
	if (base.endsWith('.yml')) return base.slice(0, -'.yml'.length);
	return base;
}

/**
 * Load all event YAML files from a directory.
 *
 * - Nonexistent directory → non-fatal warning, returns empty list.
 * - Empty directory → warning, returns empty list.
 * - Per-file errors (YAML syntax, schema, filename mismatch, unknown
 *   aggregate) accumulate into {@link AnalysisIssue}s; no short-circuit.
 * - Never throws. Generator callers aborts on `issues.some(i => i.severity === 'error')`.
 */
export function loadEvents(
	eventsDir: string,
	entityNames: string[],
): LoadEventsResult {
	const events: EventDefinition[] = [];
	const issues: AnalysisIssue[] = [];

	const resolvedDir = resolve(eventsDir);

	let files: string[];
	try {
		files = findYamlFiles(resolvedDir);
	} catch {
		issues.push({
			severity: 'warning',
			type: 'no_events_dir',
			message: `No events directory found at: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { events, issues };
	}

	if (files.length === 0) {
		issues.push({
			severity: 'warning',
			type: 'no_files',
			message: `No event YAML files found in directory: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { events, issues };
	}

	const entityNameSet = new Set(entityNames);
	const seenTypes = new Map<string, string>(); // type → filePath of first definition

	for (const filePath of files) {
		const result: LoadEventResult = loadEventFromYaml(filePath);

		if (!result.success) {
			issues.push(...loadErrorToIssue(result));
			continue;
		}

		const { definition } = result;
		const baseName = stripYamlExt(filePath);

		// Filename ↔ type match. Schema doesn't know filenames; loader does.
		if (baseName !== definition.type) {
			issues.push({
				severity: 'error',
				type: 'event_filename_mismatch',
				message: `Event file '${baseName}' must contain 'type: ${baseName}' (found 'type: ${definition.type}')`,
				path: filePath,
				suggestion: `Rename the file to '${definition.type}.yaml' or fix the 'type' field to '${baseName}'`,
			});
			continue;
		}

		// Cross-validation: change events must reference a known entity.
		if (
			definition.direction === 'change' &&
			definition.aggregate !== undefined &&
			!entityNameSet.has(definition.aggregate)
		) {
			issues.push({
				severity: 'error',
				type: 'unknown_aggregate',
				message: `change event '${definition.type}' references unknown aggregate entity '${definition.aggregate}'`,
				path: filePath,
				suggestion: `Define entities/${definition.aggregate}.yaml or fix the aggregate value`,
			});
			continue;
		}

		// Duplicate type detection (belt-and-braces — filename match usually
		// prevents this, but defend against symlinks / .yml vs .yaml twins).
		if (seenTypes.has(definition.type)) {
			issues.push({
				severity: 'error',
				type: 'duplicate_event_type',
				message: `Duplicate event type '${definition.type}' (already declared in ${seenTypes.get(definition.type)})`,
				path: filePath,
			});
			continue;
		}

		seenTypes.set(definition.type, filePath);
		events.push(definition);
	}

	return { events, issues };
}

// ============================================================================
// Entity `events:` block desugaring
// ============================================================================

/**
 * Synthesize `EventDefinition[]` from an entity's inline `events:` block.
 *
 * - `direction` is always `change`; `aggregate` is always the entity's name.
 * - `body: Record<string, string>` → `payload: Record<string, EventPayloadField>`.
 * - `retry` defaults to `{ attempts: 3, backoff: 'exponential' }`;
 *   `version` defaults to `1`; `pool` derives to `events_change`.
 *
 * Throws synchronously on unknown payload type strings. This is a programmer
 * error in the entity YAML (the entity loader has already validated the
 * entity shape) — fail loud at codegen time rather than surface as a schema
 * issue, because the downstream generator cannot do anything useful with a
 * partially-valid event definition.
 */
export function desugarEntityEvents(
	entity: EntityDefinition,
): EventDefinition[] {
	const entityName = entity.entity.name;
	const entityEvents = entity.events ?? [];

	const explicit: EventDefinition[] = entityEvents.map((ev) => {
		const payload: Record<string, EventPayloadField> = {};
		for (const [key, typeString] of Object.entries(ev.body)) {
			if (!isEventFieldType(typeString)) {
				throw new Error(
					`Entity '${entityName}' event '${ev.name}' field '${key}' has unknown type '${typeString}' — expected one of ${EVENT_FIELD_TYPES.join('|')}`,
				);
			}
			payload[key] = { type: typeString, nullable: false };
		}

		const def: EventDefinition = {
			type: ev.name,
			tier: 'domain',
			direction: 'change',
			aggregate: entityName,
			payload,
			retry: { attempts: 3, backoff: 'exponential' },
			version: 1,
			pool: DIRECTION_TO_POOL.change,
		};
		return def;
	});

	// EMIT-CHANGES seam — opt-in post-upsert change-event triad. When the entity
	// declares `integration.sink.emit_changes: true`, synthesize the three
	// data-level change events the integration orchestrator publishes after every
	// sink write/soft-delete. These merge into the generated registry exactly like
	// a hand-authored `events/*.yaml` (same `direction: change` shape as the
	// explicit `events:` block above), so the consumer gets TypedEventBus
	// augmentation, the `EventTypeName` union, schemas, and registry entries for
	// free. A top-level `events/<entity>_created.yaml` still wins on type collision
	// (mergeEvents is top-level-wins) for authors who want a richer payload.
	const changeTriad = desugarEmitChangeEvents(entity);

	return [...explicit, ...changeTriad];
}

/**
 * The three change verbs the EMIT-CHANGES seam publishes, and the event suffix
 * each maps to. `_edited` (NOT `_updated`) per swe-brain ADR-0009 Amendment B1 —
 * the explicit, domain-gated event vocabulary that drove this seam.
 */
const EMIT_CHANGE_SUFFIXES = ['created', 'edited', 'deleted'] as const;

/**
 * Synthesize the `<entity>_created` / `<entity>_edited` / `<entity>_deleted`
 * change events for an entity that opts into `integration.sink.emit_changes`.
 * Returns `[]` when the entity does not opt in (the back-compat default).
 *
 * Payload shape mirrors `IntegrationChangeNotification` (the orchestrator's port
 * input): `{ entity_id, external_id, provider, changed_fields?, source }`.
 * `source` is the provenance marker (always `'integration'`) a write-back action
 * reads to break the inbound→writeback→inbound loop. `changed_fields` is present
 * only on `created`/`edited` (the differ has a before/after map there); `deleted`
 * is a tombstone with no field diff. Payload keys are snake_case (the event-YAML
 * convention); the event codegen camelCases them on emission
 * (`changed_fields → changedFields`, `entity_id → entityId`).
 */
export function desugarEmitChangeEvents(
	entity: EntityDefinition,
): EventDefinition[] {
	if (entity.integration?.sink?.emit_changes !== true) return [];

	const entityName = entity.entity.name;

	const basePayload: Record<string, EventPayloadField> = {
		entity_id: {
			type: 'uuid',
			nullable: false,
			description: 'Local aggregate id the sink wrote/soft-deleted.',
		},
		external_id: {
			type: 'string',
			nullable: false,
			description: 'Vendor external id the change keyed on.',
		},
		provider: {
			type: 'string',
			nullable: false,
			description: "Provider label (e.g. 'slack', 'google').",
		},
		source: {
			type: 'string',
			nullable: false,
			description:
				"Provenance marker — always 'integration'. A write-back action reads this to avoid echoing the change back to the vendor.",
		},
	};

	return EMIT_CHANGE_SUFFIXES.map((suffix) => {
		const payload: Record<string, EventPayloadField> = { ...basePayload };
		// created/edited carry the differ's per-field before/after map; a delete is
		// a tombstone with no diff.
		if (suffix !== 'deleted') {
			payload.changed_fields = {
				type: 'json',
				nullable: true,
				description:
					"Differ's per-field before/after map (same value as integration_run_items.changed_fields).",
			};
		}

		const def: EventDefinition = {
			type: `${entityName}_${suffix}`,
			tier: 'domain',
			direction: 'change',
			aggregate: entityName,
			payload,
			retry: { attempts: 3, backoff: 'exponential' },
			version: 1,
			pool: DIRECTION_TO_POOL.change,
		};
		return def;
	});
}

function isEventFieldType(s: string): s is EventFieldType {
	return (EVENT_FIELD_TYPES as readonly string[]).includes(s);
}
