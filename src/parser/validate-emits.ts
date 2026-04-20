/**
 * Entity `emits:` Cross-Validator (EVT-7)
 *
 * Runs after `loadEntities()` and the merged event registry (top-level
 * `events/*.yaml` ∪ entity `events:` desugar) have been computed.
 *
 * Responsibilities (per EVT-7 plan §Validation contract):
 *
 *   • For every entity with `emits !== undefined`:
 *       - each entry must resolve to an `EventDefinition` in the registry.
 *       - that definition must have `direction === 'change'`.
 *       - its `aggregate` must equal the entity's `name`.
 *       - duplicates inside the same `emits:` array surface as warnings.
 *   • For every entity with `emits === undefined`:
 *       - surface a `no_emits` warning — visibility only, not a gate (EVT-Q4).
 *
 * `emits: []` (explicit opt-out) → no warning, no errors.
 *
 * This module is framework-agnostic (pure). The CLI surfaces produced issues.
 */

import type { AnalysisIssue, ParsedEntity } from '../analyzer/types.js';
import type { EventDefinition } from '../schema/event-definition.schema.js';

/**
 * Cross-validate each entity's `emits:` block against the merged event
 * registry. Never throws — always returns an array of issues.
 */
export function validateEntityEmits(
	entities: ParsedEntity[],
	events: EventDefinition[],
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];
	const byType = new Map<string, EventDefinition>();
	for (const ev of events) byType.set(ev.type, ev);

	for (const entity of entities) {
		if (entity.emits === undefined) {
			issues.push({
				severity: 'warning',
				type: 'no_emits',
				entity: entity.name,
				message: `Entity '${entity.name}' has no emits: block — falling back to untyped lifecycle-events. Declare emits: to use TypedEventBus.`,
				path: entity.sourcePath,
			});
			continue;
		}

		// Explicit `[]` — affirmative opt-out, no warning.
		if (entity.emits.length === 0) continue;

		// Track duplicates within this entity's emits array.
		const seen = new Set<string>();

		for (const emitName of entity.emits) {
			if (seen.has(emitName)) {
				issues.push({
					severity: 'warning',
					type: 'duplicate_emit',
					entity: entity.name,
					message: `Entity '${entity.name}' lists '${emitName}' more than once in emits: — the duplicate will be ignored.`,
					path: entity.sourcePath,
				});
				continue;
			}
			seen.add(emitName);

			const def = byType.get(emitName);
			if (!def) {
				issues.push({
					severity: 'error',
					type: 'missing_event_declaration',
					entity: entity.name,
					message: `emits '${emitName}' has no matching events/${emitName}.yaml or entity events: entry`,
					path: entity.sourcePath,
					suggestion: `Create events/${emitName}.yaml with direction: 'change' and aggregate: '${entity.name}', or declare ${emitName} in this entity's events: block.`,
				});
				continue;
			}

			if (def.direction !== 'change') {
				issues.push({
					severity: 'error',
					type: 'emit_wrong_direction',
					entity: entity.name,
					message: `emits '${emitName}' references event with direction '${def.direction}' — only 'change' events are emittable from entity use-cases`,
					path: entity.sourcePath,
				});
				continue;
			}

			if (def.aggregate !== entity.name) {
				const aggregateLabel = def.aggregate ?? '(none)';
				issues.push({
					severity: 'error',
					type: 'emit_wrong_aggregate',
					entity: entity.name,
					message: `emits '${emitName}' belongs to aggregate '${aggregateLabel}' but this entity is '${entity.name}'`,
					path: entity.sourcePath,
				});
				continue;
			}
		}
	}

	return issues;
}
