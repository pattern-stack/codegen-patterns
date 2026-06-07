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
 *
 * @deprecated EVT-7 — Lifecycle events are untyped and emit outside of the
 *   CRUD transaction. New work should declare an `emits:` block on the entity
 *   and publish typed domain events from use-cases via TYPED_EVENT_BUS inside
 *   the same Drizzle transaction. See `docs/specs/EVT-7.md`. This helper is
 *   retained for BaseService backward compatibility until all entities have
 *   migrated to typed emits.
 */

import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import type { IEventBus, DomainEvent } from '../subsystems/events/event-bus.protocol';

/**
 * Module-level logger for fire-and-forget emission failures. Routed through the
 * Nest `Logger` (not bare `console`) so consumers configuring `app.useLogger`
 * or the factory `logger:` option can format and filter it like any other
 * framework log line.
 */
const logger = new Logger('LifecycleEvents');

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
		// AUDIT tier: lifecycle/change events are untyped audit-trail records —
		// never bridge-routed, no pool/direction. The `domain_events`
		// `domain_events_tier_routing_check` CHECK requires `tier='audit' ⇔
		// (pool IS NULL AND direction IS NULL)`; the DEFAULT `tier='domain'`
		// (applied by toInsertValues when absent) requires non-null routing
		// fields, so an un-tiered lifecycle row violates the constraint and the
		// INSERT is rejected — silently, pre-fix, by emitSafely's catch. Stamp
		// `tier:'audit'` so these rows land (and surface under the
		// observability viewer's audit-tier toggle). The bridge guard keeps
		// audit-tier events out of job routing.
		metadata: { category: 'lifecycle' as EventCategory, tier: 'audit' },
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
		// AUDIT tier — see buildLifecycleEvent. Change events are audit-trail
		// records; tier:'audit' satisfies the tier-routing CHECK constraint.
		metadata: { category: 'change' as EventCategory, tier: 'audit' },
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
			const only = events[0];
			if (!only) return;
			await eventBus.publish(only);
		} else {
			await eventBus.publishMany(events);
		}
	} catch (err) {
		// Never fail the CRUD operation — but surface the cause. The bare
		// `catch` that used to live here swallowed the error entirely, so a
		// failing bus printed `failed to emit N event(s)` with zero
		// diagnosability. Route through the Nest Logger (not bare console) at
		// warn level, including the distinct event types and the error message;
		// the stack follows at debug so it's available without noising the
		// default-threshold output.
		const message = err instanceof Error ? err.message : String(err);
		const types = [...new Set(events.map((e) => e.type))].join(', ');
		logger.warn(
			`failed to emit ${events.length} event(s) [${types}]: ${message}`,
		);
		if (err instanceof Error && err.stack) {
			logger.debug(err.stack);
		}
	}
}
