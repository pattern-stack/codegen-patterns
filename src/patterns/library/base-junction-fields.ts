/**
 * BaseJunctionFields — shared column shape every junction table carries.
 *
 * Per-pairing role columns and pairing-specific fields are declared in the
 * consumer YAML's `fields:` block and are NOT part of this shape.
 *
 * Exposed as a TS const so two consumers can import it:
 *   - `junction.pattern.ts`              — registers it as the pattern's
 *                                          column contribution so the
 *                                          registry's `assertHasContribution()`
 *                                          check passes structurally.
 *   - `junction-definition.schema.ts`    — uses the name set for the
 *                                          reserved-column collision check
 *                                          on the consumer's `fields:` block.
 *
 * See ADR-031 and `.ai-docs/stacks/codegen-app-patterns/specs/58.md`.
 */

import type { PatternColumnContribution } from '../pattern-definition.js';

export const BaseJunctionFields: readonly PatternColumnContribution[] = [
	{ name: 'is_primary', type: 'boolean' },
	{ name: 'started_at', type: 'timestamp' },
	{ name: 'ended_at', type: 'timestamp' },
	{ name: 'sourced_from', type: 'text' },
	{ name: 'confidence', type: 'numeric(5,4)' },
	{ name: 'matched_at', type: 'timestamp' },
] as const;

export const BASE_JUNCTION_FIELD_NAMES: ReadonlySet<string> = new Set(
	BaseJunctionFields.map((c) => c.name),
);
