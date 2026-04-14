/**
 * Lifecycle event emission for BaseService.
 *
 * Ported from pattern-stack/atoms/patterns/services/base.py — the Python
 * BaseService emits LIFECYCLE and CHANGE events on every CRUD operation.
 * This module provides the same capability for the TypeScript codegen stack.
 *
 * Design:
 *   - Fire-and-forget: event emission never fails the CRUD operation.
 *   - IEventBus is optional: if no EVENT_BUS is injected, emission is silently
 *     skipped. This means base classes work in projects that haven't installed
 *     the events subsystem.
 *   - LIFECYCLE events carry an entity snapshot in payload.
 *   - CHANGE events carry per-field old/new diffs.
 *   - Controlled per-entity via `emitLifecycleEvents` flag (default: true).
 */

import { randomUUID } from 'crypto';
import type { IEventBus, DomainEvent } from '../subsystems/events/event-bus.protocol';

// ============================================================================
// Event categories (subset of pattern-stack's EventCategory)
// ============================================================================

export type EventCategory = 'lifecycle' | 'change';

// ============================================================================
// Helpers
// ============================================================================

/** System fields excluded from entity snapshots and change diffs. */
const SYSTEM_FIELDS = new Set([
	'id',
	'createdAt',
	'updatedAt',
	'deletedAt',
]);

/**
 * Snapshot an entity's field values, excluding system fields.
 * Mirrors pattern-stack's `_get_entity_snapshot()`.
 */
export function entitySnapshot(entity: Record<string, unknown>): Record<string, unknown> {
	const snap: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entity)) {
		if (!SYSTEM_FIELDS.has(key)) {
			snap[key] = value;
		}
	}
	return snap;
}

/**
 * Diff two entity snapshots, returning per-field old/new pairs.
 * Only includes fields that actually changed.
 */
export function diffSnapshots(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): Array<{ field: string; oldValue: unknown; newValue: unknown }> {
	const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
	const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

	for (const key of allKeys) {
		if (SYSTEM_FIELDS.has(key)) continue;
		const oldVal = before[key];
		const newVal = after[key];
		// Simple equality — good enough for primitives and nulls.
		// For deep objects, JSON.stringify comparison.
		if (oldVal !== newVal && JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
			changes.push({ field: key, oldValue: oldVal, newValue: newVal });
		}
	}

	return changes;
}

// ============================================================================
// Event builders
// ============================================================================

export function buildLifecycleEvent(
	entityName: string,
	action: 'created' | 'updated' | 'deleted',
	entityId: string,
	snapshot?: Record<string, unknown>,
): DomainEvent {
	return {
		id: randomUUID(),
		type: `${entityName}.${action}`,
		aggregateId: entityId,
		aggregateType: entityName,
		payload: snapshot ? { snapshot } : {},
		occurredAt: new Date(),
		metadata: { category: 'lifecycle' as EventCategory },
	};
}

export function buildChangeEvents(
	entityName: string,
	entityId: string,
	changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>,
): DomainEvent[] {
	return changes.map((c) => ({
		id: randomUUID(),
		type: `${entityName}.field_changed`,
		aggregateId: entityId,
		aggregateType: entityName,
		payload: {
			fieldName: c.field,
			oldValue: c.oldValue,
			newValue: c.newValue,
		},
		occurredAt: new Date(),
		metadata: { category: 'change' as EventCategory },
	}));
}

// ============================================================================
// Emission helper (fire-and-forget)
// ============================================================================

/**
 * Emit events to the bus, swallowing errors.
 * Mirrors pattern-stack's `_emit_lifecycle_event()` try/except.
 */
export async function emitSafely(
	eventBus: IEventBus | undefined,
	events: DomainEvent[],
): Promise<void> {
	if (!eventBus || events.length === 0) return;
	try {
		if (events.length === 1) {
			await eventBus.publish(events[0]);
		} else {
			await eventBus.publishMany(events);
		}
	} catch {
		// Log but never fail the CRUD operation.
		// In production, this would use a structured logger.
		console.warn(`[lifecycle-events] failed to emit ${events.length} event(s)`);
	}
}
